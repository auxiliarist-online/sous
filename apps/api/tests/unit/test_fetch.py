import asyncio
import gzip
from collections.abc import Callable

import httpx2 as httpx
import pytest

from app.recipes import fetch
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


@pytest.mark.usefixtures("no_dns")
class TestCrawlerSupport:
    def test_sitemaps_are_refused_unless_asked_for(self) -> None:
        xml = httpx.Response(200, text="<urlset/>", headers={"content-type": "application/xml"})
        with pytest.raises(FetchError) as err:
            run(site(pages={"/sitemap.xml": xml}), "https://example-blog.com/sitemap.xml")
        assert err.value.code == "not_a_recipe"

        async def go() -> Page:
            transport = httpx.MockTransport(site(pages={"/sitemap.xml": xml}))
            async with httpx.AsyncClient(transport=transport) as client:
                return await fetch_page(
                    "https://example-blog.com/sitemap.xml", client, accept=("xml",)
                )

        assert asyncio.run(go()).html == "<urlset/>"

    def test_a_gzip_bomb_is_cut_off(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(fetch, "MAX_BYTES", 1000)
        bomb = gzip.compress(b"a" * 10_000)
        resp = httpx.Response(200, content=bomb, headers={"content-type": "application/gzip"})

        async def go() -> Page:
            transport = httpx.MockTransport(site(pages={"/s.xml.gz": resp}))
            async with httpx.AsyncClient(transport=transport) as client:
                return await fetch_page(
                    "https://example-blog.com/s.xml.gz", client, accept=("gzip",)
                )

        with pytest.raises(FetchError) as err:
            asyncio.run(go())
        assert err.value.code == "too_large"

    def test_reads_crawl_delay_and_sitemaps_from_robots(self) -> None:
        robots = (
            "User-agent: SousBot\nCrawl-delay: 12\n\n"
            "Sitemap: https://example-blog.com/sitemap_index.xml\n"
        )

        async def go() -> tuple[float | None, list[str]]:
            transport = httpx.MockTransport(site(robots))
            headers = {"User-Agent": fetch.user_agent()}
            async with httpx.AsyncClient(transport=transport, headers=headers) as client:
                url = "https://example-blog.com/"
                return (
                    await fetch.robots.crawl_delay(client, url),
                    await fetch.robots.sitemaps(client, url),
                )

        assert asyncio.run(go()) == (12.0, ["https://example-blog.com/sitemap_index.xml"])


class TestThrottle:
    def test_a_longer_crawl_delay_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        clock = [100.0]
        monkeypatch.setattr("app.recipes.fetch.time.monotonic", lambda: clock[0])
        throttle = fetch.Throttle(5.0)
        waits: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            waits.append(seconds)

        monkeypatch.setattr("app.recipes.fetch.asyncio.sleep", fake_sleep)

        async def go() -> None:
            await throttle.wait("a.example", crawl_delay=12.0)
            await throttle.wait("a.example")  # 12s after the first
            await throttle.wait("b.example", crawl_delay=1.0)  # other host: no wait

        asyncio.run(go())
        assert waits == [12.0]


def test_an_absurd_crawl_delay_fails_fast_instead_of_hanging(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.recipes.fetch.time.monotonic", lambda: 100.0)
    throttle = fetch.Throttle(5.0)

    async def go() -> None:
        await throttle.wait("slow.example", crawl_delay=999_999_999)
        await throttle.wait("slow.example")

    with pytest.raises(FetchError) as err:
        asyncio.run(go())
    assert err.value.code == "rate_limited"
