import asyncio
from collections.abc import Callable

import httpx2 as httpx
import pytest

from app.recipes.fetch import FetchError, Page, fetch_page

Handler = Callable[[httpx.Request], httpx.Response]


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
