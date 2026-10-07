import asyncio
import json
from collections.abc import Callable, Iterator
from typing import Any

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import current_user_id
from app.main import app
from app.recipes import fetch, routes
from app.recipes.extract import RecipeDraft, canonical_url, extract_recipe
from app.recipes.fetch import FetchError, Page, fetch_page

# Synthetic page in the shape food blogs publish (schema.org Recipe JSON-LD).
RECIPE_LD = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    "name": "Weeknight Black Bean Tacos",
    "url": "https://example-blog.com/black-bean-tacos/",
    "image": ["https://example-blog.com/img/tacos.jpg"],
    "description": "A short headnote written by the author.",
    "recipeYield": ["4", "4 servings"],
    "prepTime": "PT10M",
    "cookTime": "PT15M",
    "totalTime": "PT25M",
    "recipeCuisine": "Mexican, Gluten-Free",
    "recipeIngredient": [
        "1 (15 oz) can black beans, drained",
        "8 corn tortillas",
        "1 avocado",
    ],
    "recipeInstructions": [
        {"@type": "HowToStep", "text": "Warm the beans."},
        {"@type": "HowToStep", "text": "Fill the tortillas."},
    ],
}


def page_html(ld: dict[str, Any] | None = None, canonical: str | None = None) -> str:
    link = f'<link rel="canonical" href="{canonical}">' if canonical else ""
    script = (
        f'<script type="application/ld+json">{json.dumps(ld)}</script>' if ld is not None else ""
    )
    return (
        f"<html><head><title>Tacos</title>"
        f'<meta property="og:site_name" content="Example Blog">{link}{script}'
        f"</head><body><p>Story about tacos.</p></body></html>"
    )


class TestExtract:
    def test_reads_the_recipe_fields_we_store(self) -> None:
        url = "https://www.example-blog.com/black-bean-tacos/?utm_source=pin"
        draft = extract_recipe(page_html(RECIPE_LD), url)
        assert draft.title == "Weeknight Black Bean Tacos"
        assert draft.domain == "example-blog.com"
        assert draft.site_name == "Example Blog"
        assert draft.source_url == "https://www.example-blog.com/black-bean-tacos/"
        assert draft.image_url == "https://example-blog.com/img/tacos.jpg"
        assert (draft.prep_minutes, draft.cook_minutes, draft.total_minutes) == (10, 15, 25)
        assert draft.servings == 4
        assert draft.cuisines == ["mexican"]  # "Gluten-Free" isn't a cuisine
        assert [i.raw_text for i in draft.ingredients] == RECIPE_LD["recipeIngredient"]
        assert [i.line_no for i in draft.ingredients] == [0, 1, 2]

    def test_prefers_the_pages_canonical_link_on_the_same_site(self) -> None:
        html = page_html(RECIPE_LD, canonical="https://example-blog.com/tacos/")
        draft = extract_recipe(html, "https://example-blog.com/tacos/print/")
        assert draft.source_url == "https://example-blog.com/tacos/"

    def test_ignores_a_canonical_link_to_another_site(self) -> None:
        html = page_html(RECIPE_LD, canonical="https://elsewhere.example/tacos/")
        draft = extract_recipe(html, "https://example-blog.com/tacos/")
        assert draft.source_url == "https://example-blog.com/tacos/"

    def test_rejects_pages_without_a_recipe(self) -> None:
        with pytest.raises(FetchError) as err:
            extract_recipe(page_html(None), "https://example-blog.com/about/")
        assert err.value.code == "not_a_recipe"

    def test_payload_matches_import_recipe(self) -> None:
        draft = extract_recipe(page_html(RECIPE_LD), "https://example-blog.com/tacos/")
        p = draft.payload("user-1")
        assert p["added_by"] == "user-1"
        assert p["source"]["domain"] == "example-blog.com"
        assert p["ingredients"][0] == {
            "line_no": 0,
            "raw_text": "1 (15 oz) can black beans, drained",
            "section": None,
        }


def test_canonical_url_drops_tracking_and_fragments() -> None:
    assert (
        canonical_url("https://Example.com/a/?utm_medium=x&page=2&fbclid=1#recipe")
        == "https://example.com/a/?page=2"
    )


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

Handler = Callable[[httpx.Request], httpx.Response]


@pytest.fixture(autouse=True)
def fresh_fetch_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fetch, "robots", fetch.Robots())
    monkeypatch.setattr(fetch, "throttle", fetch.Throttle(0))


@pytest.fixture
def no_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    """Let mock hostnames through the public-address check (scheme/port still checked)."""
    real = fetch._check_public_host

    async def check(url: str) -> None:
        if "example" not in url:
            await real(url)

    monkeypatch.setattr(fetch, "_check_public_host", check)


def run(handler: Handler, url: str) -> Page:
    async def go() -> Page:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await fetch_page(url, client)

    return asyncio.run(go())


def site(robots: str = "", pages: dict[str, httpx.Response] | None = None) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["user-agent"].startswith("SousBot/")
        if request.url.path == "/robots.txt":
            return httpx.Response(200, text=robots)
        return (pages or {}).get(request.url.path, httpx.Response(404))

    return handler


def html_response(body: str = "<html></html>") -> httpx.Response:
    return httpx.Response(200, text=body, headers={"content-type": "text/html; charset=utf-8"})


@pytest.mark.usefixtures("no_dns")
class TestFetch:
    def test_fetches_an_allowed_page(self) -> None:
        page = run(site(pages={"/tacos/": html_response("hi")}), "https://example-blog.com/tacos/")
        assert page.html == "hi"

    def test_follows_redirects(self) -> None:
        pages = {
            "/old/": httpx.Response(301, headers={"location": "/tacos/"}),
            "/tacos/": html_response(),
        }
        page = run(site(pages=pages), "https://example-blog.com/old/")
        assert page.url == "https://example-blog.com/tacos/"

    def test_obeys_robots_txt(self) -> None:
        robots = "User-agent: SousBot\nDisallow: /\n"
        with pytest.raises(FetchError) as err:
            run(site(robots, {"/tacos/": html_response()}), "https://example-blog.com/tacos/")
        assert err.value.code == "robots_disallowed"

    def test_robots_rules_for_other_bots_dont_apply(self) -> None:
        robots = "User-agent: GPTBot\nDisallow: /\n"
        run(site(robots, {"/tacos/": html_response()}), "https://example-blog.com/tacos/")

    @pytest.mark.parametrize(
        ("response", "code"),
        [
            (httpx.Response(403, headers={"cf-mitigated": "challenge"}), "blocked"),
            (httpx.Response(401), "blocked"),
            (httpx.Response(404), "not_found"),
            (httpx.Response(429), "rate_limited"),
            (httpx.Response(200, json={"a": 1}), "not_a_recipe"),
        ],
    )
    def test_reports_failures_clearly(self, response: httpx.Response, code: str) -> None:
        with pytest.raises(FetchError) as err:
            run(site(pages={"/tacos/": response}), "https://example-blog.com/tacos/")
        assert err.value.code == code

    def test_robots_server_error_means_try_later(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503)

        with pytest.raises(FetchError) as err:
            run(handler, "https://example-blog.com/tacos/")
        assert err.value.code == "unreachable"


class TestPublicAddressesOnly:
    @pytest.mark.parametrize(
        "url",
        [
            "http://127.0.0.1/",
            "http://10.0.0.5/recipe",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "ftp://8.8.8.8/recipe",
            "http://8.8.8.8:8080/recipe",
        ],
    )
    def test_refuses_internal_or_odd_addresses(self, url: str) -> None:
        with pytest.raises(FetchError) as err:
            run(site(), url)
        assert err.value.code == "invalid_url"

    def test_refuses_a_redirect_to_an_internal_address(self) -> None:
        pages = {"/r": httpx.Response(302, headers={"location": "http://127.0.0.1/admin"})}
        with pytest.raises(FetchError) as err:
            run(site(pages=pages), "http://8.8.8.8/r")
        assert err.value.code == "invalid_url"


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    async def fake_fetch(url: str) -> Page:
        if "blocked" in url:
            raise FetchError("blocked", "This site blocks automated imports.")
        return Page(url=url, html=page_html(RECIPE_LD))

    saved: list[tuple[RecipeDraft, str]] = []

    async def fake_save(draft: RecipeDraft, user_id: str) -> dict[str, Any]:
        saved.append((draft, user_id))
        return {
            "recipe_id": "r-1",
            "created": True,
            "visibility": "private",
            "status": "needs_review",
        }

    monkeypatch.setattr(routes, "fetch_page", fake_fetch)
    monkeypatch.setattr(routes, "save_recipe", fake_save)
    app.dependency_overrides[current_user_id] = lambda: "user-1"
    test_client = TestClient(app)
    test_client.saved = saved  # type: ignore[attr-defined]
    yield test_client
    app.dependency_overrides.clear()


def test_import_saves_the_recipe_for_the_user(client: TestClient) -> None:
    resp = client.post("/recipes/import", json={"url": "example-blog.com/tacos/"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["recipe_id"] == "r-1"
    assert body["title"] == "Weeknight Black Bean Tacos"
    assert body["source_name"] == "Example Blog"
    draft, user = client.saved[0]  # type: ignore[attr-defined]
    assert user == "user-1"
    assert draft.source_url == "https://example-blog.com/tacos/"


def test_import_explains_why_a_page_cant_be_imported(client: TestClient) -> None:
    resp = client.post("/recipes/import", json={"url": "https://blocked.example/tacos/"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "blocked"


def test_import_requires_sign_in() -> None:
    resp = TestClient(app).post("/recipes/import", json={"url": "https://example.com/"})
    assert resp.status_code == 401
