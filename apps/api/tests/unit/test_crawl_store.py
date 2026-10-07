"""SupabaseCrawlStore's REST calls, with HTTP mocked."""

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

import httpx2 as httpx
import pytest

from app.config import settings
from app.crawl.sitemap import Entry
from app.crawl.store import QueuedPage, RunReport, Source, SupabaseCrawlStore
from app.recipes.store import StoreError

SOURCE = Source("src-1", "example-blog.com")
Reply = Callable[[httpx.Request], httpx.Response]


@pytest.fixture(autouse=True)
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "supabase_url", "https://proj.supabase.co")
    monkeypatch.setattr(settings, "supabase_service_role_key", "service-key")


def call[T](
    action: Callable[[SupabaseCrawlStore], Awaitable[T]],
    reply: Reply = lambda r: httpx.Response(204),
) -> tuple[T, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return reply(request)

    async def go() -> T:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await action(SupabaseCrawlStore(client))

    return asyncio.run(go()), seen


def body(request: httpx.Request) -> Any:
    return json.loads(request.content)


def test_needs_supabase_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "supabase_service_role_key", "")
    with pytest.raises(StoreError):
        SupabaseCrawlStore(httpx.AsyncClient())


def test_lists_approved_sources_with_the_service_key() -> None:
    rows = [{"id": "s1", "domain": "example-blog.com", "sitemap_url": None}]
    sources, seen = call(
        lambda s: s.sources("example-blog.com"), lambda r: httpx.Response(200, json=rows)
    )
    assert sources == [Source("s1", "example-blog.com", None)]
    req = seen[0]
    assert req.url.path == "/rest/v1/recipe_sources"
    assert req.headers["authorization"] == "Bearer service-key"
    assert req.url.params["crawl_enabled"] == "is.true"
    assert req.url.params["opted_out_at"] == "is.null"
    assert req.url.params["domain"] == "eq.example-blog.com"


def test_starts_a_run() -> None:
    run_id, seen = call(
        lambda s: s.start_run(SOURCE), lambda r: httpx.Response(201, json=[{"id": "run-1"}])
    )
    assert run_id == "run-1"
    assert seen[0].headers["prefer"] == "return=representation"
    assert body(seen[0]) == {"source_id": "src-1"}


def test_enqueues_through_the_rpc() -> None:
    due, seen = call(
        lambda s: s.enqueue(SOURCE, [Entry("https://example-blog.com/a/", "2026-09-01")]),
        lambda r: httpx.Response(200, json=7),
    )
    assert due == 7
    assert seen[0].url.path == "/rest/v1/rpc/crawl_enqueue"
    assert body(seen[0]) == {
        "p_source": "src-1",
        "p_entries": [{"url": "https://example-blog.com/a/", "lastmod": "2026-09-01"}],
    }


def test_asks_for_pending_pages_and_retryable_errors() -> None:
    rows = [{"id": "p1", "url": "u", "lastmod": None, "attempts": 1, "recipe_id": None}]
    pages, seen = call(lambda s: s.due_pages(SOURCE, 25), lambda r: httpx.Response(200, json=rows))
    assert pages == [QueuedPage("p1", "u", None, 1, None)]
    params = seen[0].url.params
    assert params["or"] == "(status.eq.pending,and(status.eq.error,attempts.lt.3))"
    assert params["limit"] == "25"


def test_saves_a_recipe_through_import_recipe() -> None:
    result = {"recipe_id": "r1", "created": True, "updated": False}
    saved, seen = call(
        lambda s: s.save_recipe({"refresh": True}), lambda r: httpx.Response(200, json=result)
    )
    assert saved == result
    assert body(seen[0]) == {"p": {"refresh": True}}


@pytest.mark.parametrize(("status", "attempts"), [("imported", 0), ("error", 3)])
def test_records_a_page(status: str, attempts: int) -> None:
    page = QueuedPage("p1", "u", "2026-09-01T00:00:00", 2)
    _, seen = call(lambda s: s.record_page(page, status, "x", "r1"))  # type: ignore[arg-type]
    sent = body(seen[0])
    assert seen[0].url.params["id"] == "eq.p1"
    assert (sent["status"], sent["attempts"], sent["recipe_id"]) == (status, attempts, "r1")
    assert sent["fetched_lastmod"] == "2026-09-01T00:00:00"


def test_hides_only_a_public_listed_recipe() -> None:
    _, seen = call(lambda s: s.hide_recipe("r1"))
    params = seen[0].url.params
    assert (params["id"], params["visibility"]) == ("eq.r1", "eq.public")
    assert body(seen[0]) == {"status": "hidden"}


def test_opts_a_source_out() -> None:
    hidden, seen = call(lambda s: s.opt_out(SOURCE), lambda r: httpx.Response(200, json=4))
    assert hidden == 4
    assert seen[0].url.path == "/rest/v1/rpc/opt_out_source"


def test_finishes_a_run_and_marks_the_source_crawled() -> None:
    report = RunReport(SOURCE, "stopped", "3 blocked in a row", pages_fetched=3, run_id="run-1")
    _, seen = call(lambda s: s.finish_run(report))
    run, source = seen
    assert run.url.params["id"] == "eq.run-1"
    assert body(run)["status"] == "stopped"
    assert body(run)["pages_fetched"] == 3
    assert source.url.path == "/rest/v1/recipe_sources"
    assert "last_crawled_at" in body(source)


def test_surfaces_database_errors() -> None:
    with pytest.raises(StoreError, match="500"):
        call(lambda s: s.opt_out(SOURCE), lambda r: httpx.Response(500, text="boom"))
