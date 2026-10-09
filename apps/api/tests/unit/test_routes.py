import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.auth import current_user_id
from app.main import app
from app.recipes import routes
from app.recipes.extract import RecipeDraft, page_from_json_ld
from app.recipes.fetch import FetchError, Page
from tests.helpers import RECIPE_LD, page_html


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    async def fake_fetch(url: str) -> Page:
        if "blocked" in url:
            raise FetchError("blocked", "This site blocks automated imports.")
        return Page(url=url, html=page_html(RECIPE_LD))

    saved: list[tuple[RecipeDraft, str]] = []
    origins: list[str] = []

    async def fake_save(
        draft: RecipeDraft, user_id: str, origin: str = "fetched"
    ) -> dict[str, Any]:
        saved.append((draft, user_id))
        origins.append(origin)
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
    test_client.origins = origins  # type: ignore[attr-defined]
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


class TestImportPage:
    """Import from the page data the user's own browser sends."""

    URL = "https://www.blocked-blog.example/tacos/"

    def post(self, client: TestClient, **body: Any) -> Any:
        return client.post("/recipes/import-page", json={"url": self.URL, **body})

    def test_saves_the_recipe_as_the_users_private_copy(self, client: TestClient) -> None:
        resp = self.post(client, ld=[json.dumps(RECIPE_LD)], site_name="Blocked Blog")
        assert resp.status_code == 200, resp.text
        assert resp.json()["title"] == "Weeknight Black Bean Tacos"
        assert resp.json()["source_name"] == "Blocked Blog"
        assert client.origins == ["browser"]  # type: ignore[attr-defined]
        draft, user = client.saved[0]  # type: ignore[attr-defined]
        assert user == "user-1"
        assert [i.raw_text for i in draft.ingredients] == RECIPE_LD["recipeIngredient"]

    def test_never_fetches_the_page(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def no_fetch(url: str) -> None:
            raise AssertionError("browser import must not fetch")

        monkeypatch.setattr(routes, "fetch_page", no_fetch)
        assert self.post(client, ld=[json.dumps(RECIPE_LD)]).status_code == 200

    def test_finds_the_recipe_among_other_blocks_and_skips_bad_json(
        self, client: TestClient
    ) -> None:
        org = json.dumps({"@context": "https://schema.org", "@type": "Organization"})
        resp = self.post(client, ld=["{not json", org, json.dumps(RECIPE_LD)])
        assert resp.status_code == 200

    @pytest.mark.parametrize(
        ("body", "code"),
        [
            ({"ld": ["{not json"]}, "not_a_recipe"),
            ({"ld": [json.dumps({"@type": "Organization"})]}, "not_a_recipe"),
            ({"url": "javascript:alert(1)", "ld": [json.dumps(RECIPE_LD)]}, "invalid_url"),
        ],
    )
    def test_explains_what_it_cant_import(
        self, client: TestClient, body: dict[str, Any], code: str
    ) -> None:
        resp = client.post("/recipes/import-page", json={"url": self.URL, **body})
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == code

    def test_refuses_oversized_pages(self, client: TestClient) -> None:
        resp = self.post(client, ld=["x" * 300_000, "y" * 300_000])
        assert resp.status_code == 413
        assert self.post(client, ld=["{}"] * 21).status_code == 422  # too many blocks


class TestPageFromJsonLd:
    def test_a_block_cannot_close_its_script_tag(self) -> None:
        evil = {"@type": "Recipe", "name": "</script><script>alert(1)</script>"}
        page = page_from_json_ld("https://a.example/", [json.dumps(evil)])
        assert page.count("</script>") == 1

    def test_escapes_the_site_name(self) -> None:
        page = page_from_json_ld("https://a.example/", ["{}"], site_name='"><b>x')
        assert '"><b>' not in page
