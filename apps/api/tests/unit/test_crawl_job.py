import asyncio
from typing import Any

import httpx2 as httpx
import pytest

from app.config import settings
from app.crawl import job
from app.crawl.job import CrawlNotAllowed, crawl_all, crawl_source
from app.crawl.sitemap import Entry
from app.crawl.store import PageStatus, QueuedPage, RunReport, Source
from tests.helpers import RECIPE_LD, page_html, urlset

SOURCE = Source("src-1", "example-blog.com")
HOME = "https://example-blog.com"


class FakeStore:
    """In-memory CrawlStore: a queue with the same due rules as crawl_enqueue()."""

    def __init__(self, sources: list[Source] | None = None) -> None:
        self._sources = [SOURCE] if sources is None else sources
        self.pages: dict[str, QueuedPage] = {}
        self.status: dict[str, PageStatus | None] = {}
        self.saved: list[dict[str, Any]] = []
        self.hidden: list[str] = []
        self.opted_out: list[str] = []
        self.finished: list[RunReport] = []
        self.existing: dict[str, str] = {}  # source_url -> recipe_id

    async def sources(self, domain: str | None = None) -> list[Source]:
        return [s for s in self._sources if domain in (None, s.domain)]

    async def start_run(self, source: Source) -> str:
        return f"run-{source.id}"

    async def enqueue(self, source: Source, entries: list[Entry]) -> int:
        for e in entries:
            if e.url not in self.pages:
                self.pages[e.url] = QueuedPage(f"page-{len(self.pages)}", e.url, e.lastmod)
                self.status[e.url] = None
        return sum(1 for s in self.status.values() if s in (None, "error"))

    async def due_pages(self, source: Source, limit: int) -> list[QueuedPage]:
        return [p for u, p in self.pages.items() if self.status[u] in (None, "error")][:limit]

    async def save_recipe(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.saved.append(payload)
        url = payload["recipe"]["source_url"]
        known = url in self.existing
        self.existing.setdefault(url, f"recipe-{len(self.existing)}")
        return {"recipe_id": self.existing[url], "created": not known, "updated": known}

    async def record_page(
        self,
        page: QueuedPage,
        status: PageStatus,
        error_code: str | None = None,
        recipe_id: str | None = None,
    ) -> None:
        self.status[page.url] = status

    async def hide_recipe(self, recipe_id: str) -> None:
        self.hidden.append(recipe_id)

    async def opt_out(self, source: Source) -> int:
        self.opted_out.append(source.id)
        return 2

    async def finish_run(self, report: RunReport) -> None:
        self.finished.append(report)


def html(body: str) -> httpx.Response:
    return httpx.Response(200, text=body, headers={"content-type": "text/html"})


def blog(pages: dict[str, httpx.Response], robots: str = "") -> httpx.MockTransport:
    """A synthetic blog whose sitemap lists every page in `pages`."""
    sitemap = urlset([(f"{HOME}{path}", None) for path in pages])

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["user-agent"].startswith("SousBot/0.1 (+https://")
        path = request.url.path
        if path == "/robots.txt":
            return httpx.Response(200, text=robots)
        if path == "/sitemap.xml":
            return httpx.Response(200, text=sitemap, headers={"content-type": "text/xml"})
        return pages.get(path, httpx.Response(404))

    return httpx.MockTransport(handler)


def recipe_page(slug: str) -> httpx.Response:
    return html(page_html({**RECIPE_LD, "url": f"{HOME}/{slug}/", "name": slug.title()}))


@pytest.fixture(autouse=True)
def contact_page(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "sousbot_contact_url", "https://sous.example/sousbot")


def crawl(
    transport: httpx.MockTransport, store: FakeStore | None = None, max_pages: int = 100
) -> tuple[RunReport, FakeStore, list[float]]:
    store = store or FakeStore()
    sleeps: list[float] = []

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    async def go() -> RunReport:
        async with httpx.AsyncClient(transport=transport) as client:
            return await crawl_source(SOURCE, store, client, max_pages, sleep)

    return asyncio.run(go()), store, sleeps


@pytest.mark.usefixtures("no_dns")
class TestCrawlSource:
    def test_imports_recipes_as_the_crawler_with_refresh(self) -> None:
        report, store, _ = crawl(
            blog({"/tacos/": recipe_page("tacos"), "/dal/": recipe_page("dal")})
        )
        assert (report.status, report.recipes_created, report.pages_fetched) == ("done", 2, 2)
        assert all(p["added_by"] is None and p["refresh"] is True for p in store.saved)
        assert store.finished == [report]
        assert set(store.status.values()) == {"imported"}

    def test_a_changed_page_counts_as_updated(self) -> None:
        store = FakeStore()
        store.existing[f"{HOME}/tacos/"] = "recipe-old"
        report, _, _ = crawl(blog({"/tacos/": recipe_page("tacos")}), store)
        assert (report.recipes_created, report.recipes_updated) == (0, 1)

    def test_records_pages_that_arent_recipes(self) -> None:
        report, store, _ = crawl(blog({"/hello/": html("<p>Just a post</p>")}))
        assert store.status[f"{HOME}/hello/"] == "not_recipe"
        assert (report.status, report.pages_failed) == ("done", 0)

    def test_respects_the_batch_size(self) -> None:
        pages = {f"/r{n}/": recipe_page(f"r{n}") for n in range(5)}
        report, store, _ = crawl(blog(pages), max_pages=2)
        assert report.pages_fetched == 2
        assert list(store.status.values()).count(None) == 3

    def test_a_site_that_disallows_sousbot_is_opted_out(self) -> None:
        robots = "User-agent: SousBot\nDisallow: /\n"
        report, store, _ = crawl(blog({"/tacos/": recipe_page("tacos")}, robots))
        assert (report.status, report.stop_reason) == ("stopped", "robots_disallowed")
        assert store.opted_out == ["src-1"]
        assert store.saved == []

    def test_a_disallowed_page_is_skipped_and_its_recipe_hidden(self) -> None:
        store = FakeStore()
        robots = "User-agent: *\nDisallow: /private/\n"
        transport = blog({"/private/x/": recipe_page("x"), "/tacos/": recipe_page("tacos")}, robots)
        asyncio.run(store.enqueue(SOURCE, [Entry(f"{HOME}/private/x/", None)]))
        store.pages[f"{HOME}/private/x/"] = QueuedPage(
            "page-0", f"{HOME}/private/x/", None, 0, "r9"
        )
        report, _, _ = crawl(transport, store)
        assert store.status[f"{HOME}/private/x/"] == "robots_disallowed"
        assert store.hidden == ["r9"]
        assert report.recipes_created == 1

    def test_a_page_gone_from_the_site_hides_its_recipe(self) -> None:
        store = FakeStore()
        url = f"{HOME}/gone/"
        store.pages[url] = QueuedPage("page-0", url, None, 0, "r1")
        store.status[url] = None
        crawl(blog({}), store)
        assert store.status[url] == "not_found"
        assert store.hidden == ["r1"]

    def test_stops_after_repeated_blocks(self) -> None:
        blocked = httpx.Response(403, headers={"cf-mitigated": "challenge"})
        pages = {f"/r{n}/": blocked for n in range(5)}
        report, store, _ = crawl(blog(pages))
        assert (report.status, report.stop_reason) == ("stopped", "3 blocked in a row")
        assert report.pages_fetched == 3

    def test_backs_off_when_rate_limited(self) -> None:
        pages = {"/a/": httpx.Response(429), "/b/": recipe_page("b"), "/c/": httpx.Response(429)}
        report, store, sleeps = crawl(blog(pages))
        assert sleeps == [job.BACKOFF_SECONDS, job.BACKOFF_SECONDS]
        assert report.status == "done"
        assert store.status[f"{HOME}/a/"] == "error"

    def test_a_page_that_breaks_extraction_doesnt_stop_the_site(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def explode(html: str, url: str) -> None:
            raise RuntimeError("unexpected markup")

        monkeypatch.setattr(job, "extract_recipe", explode)
        report, store, _ = crawl(blog({"/a/": recipe_page("a")}))
        assert report.status == "done"
        assert store.status[f"{HOME}/a/"] == "error"

    def test_a_blocked_sitemap_stops_the_site(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/robots.txt":
                return httpx.Response(200, text="")
            return httpx.Response(403)

        report, store, _ = crawl(httpx.MockTransport(handler))
        assert (report.status, report.stop_reason) == ("stopped", "sitemap: blocked")
        assert store.finished == [report]

    def test_a_database_error_fails_the_run_but_is_recorded(self) -> None:
        store = FakeStore()

        async def broken(payload: dict[str, Any]) -> dict[str, Any]:
            raise RuntimeError("database down")

        store.save_recipe = broken  # type: ignore[method-assign]
        report, _, _ = crawl(blog({"/a/": recipe_page("a")}), store)
        assert report.status == "failed"
        assert report.stop_reason == "RuntimeError: database down"
        assert store.finished == [report]


@pytest.mark.usefixtures("no_dns")
class TestCrawlAll:
    def test_refuses_without_the_contact_page(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "sousbot_contact_url", "")
        store = FakeStore()
        with pytest.raises(CrawlNotAllowed):
            asyncio.run(crawl_all(store))
        assert store.finished == []

    def test_crawls_each_approved_source(self) -> None:
        other = Source("src-2", "example-two.com")
        store = FakeStore([SOURCE, other])

        async def go() -> list[RunReport]:
            async with httpx.AsyncClient(transport=blog({"/a/": recipe_page("a")})) as client:
                return await crawl_all(store, client=client)

        reports = asyncio.run(go())
        assert [r.source for r in reports] == [SOURCE, other]

    def test_only_the_requested_source(self) -> None:
        store = FakeStore([SOURCE, Source("src-2", "example-two.com")])

        async def go() -> list[RunReport]:
            async with httpx.AsyncClient(transport=blog({})) as client:
                return await crawl_all(store, "example-two.com", client=client)

        assert [r.source.id for r in asyncio.run(go())] == ["src-2"]

    def test_no_sources_is_a_quiet_no_op(self) -> None:
        assert asyncio.run(crawl_all(FakeStore([]))) == []


@pytest.mark.usefixtures("no_dns")
def test_an_unreadable_robots_txt_stops_without_opting_out() -> None:
    report, store, _ = crawl(httpx.MockTransport(lambda r: httpx.Response(503)))
    assert (report.status, report.stop_reason) == ("stopped", "robots.txt: unreachable")
    assert store.opted_out == []
