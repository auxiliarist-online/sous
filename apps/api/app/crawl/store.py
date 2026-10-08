"""The crawler's database calls, through Supabase's REST API with the service role.

The crawl tables have row-level security with no policies, so only this
service-role client can read or write them.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

import httpx2 as httpx

from app.config import settings
from app.crawl.sitemap import Entry
from app.recipes.store import StoreError

PageStatus = Literal["imported", "not_recipe", "not_found", "blocked", "robots_disallowed", "error"]
RunStatus = Literal["done", "stopped", "failed"]


@dataclass(frozen=True)
class Source:
    id: str
    domain: str
    sitemap_url: str | None = None


@dataclass(frozen=True)
class QueuedPage:
    id: str
    url: str
    lastmod: str | None = None
    attempts: int = 0
    recipe_id: str | None = None


@dataclass
class RunReport:
    source: Source
    status: RunStatus = "done"
    stop_reason: str | None = None
    urls_queued: int = 0
    pages_fetched: int = 0
    recipes_created: int = 0
    recipes_updated: int = 0
    pages_failed: int = 0
    run_id: str | None = field(default=None, repr=False)

    def counts(self) -> dict[str, int]:
        return {
            "urls_queued": self.urls_queued,
            "pages_fetched": self.pages_fetched,
            "recipes_created": self.recipes_created,
            "recipes_updated": self.recipes_updated,
            "pages_failed": self.pages_failed,
        }


class CrawlStore(Protocol):
    async def sources(self, domain: str | None = None) -> list[Source]: ...
    async def start_run(self, source: Source) -> str: ...
    async def enqueue(self, source: Source, entries: list[Entry]) -> int: ...
    async def due_pages(self, source: Source, limit: int) -> list[QueuedPage]: ...
    async def save_recipe(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    async def record_page(
        self,
        page: QueuedPage,
        status: PageStatus,
        error_code: str | None = None,
        recipe_id: str | None = None,
    ) -> None: ...
    async def hide_recipe(self, source: Source, recipe_id: str) -> None: ...
    async def opt_out(self, source: Source) -> int: ...
    async def finish_run(self, report: RunReport) -> None: ...


def _now() -> str:
    return datetime.now(UTC).isoformat()


class SupabaseCrawlStore:
    def __init__(self, client: httpx.AsyncClient) -> None:
        if not settings.supabase_url or not settings.supabase_service_role_key:
            raise StoreError("Supabase is not configured")
        key = settings.supabase_service_role_key
        self._client = client
        self._base = f"{settings.supabase_url}/rest/v1"
        self._headers = {"apikey": key, "Authorization": f"Bearer {key}"}

    async def _call(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json: Any = None,
        returning: bool = False,
    ) -> Any:
        headers = dict(self._headers)
        if returning:
            headers["Prefer"] = "return=representation"
        resp = await self._client.request(
            method, f"{self._base}/{path}", params=params, json=json, headers=headers
        )
        if resp.status_code >= 300:
            raise StoreError(f"{method} {path} failed: {resp.status_code} {resp.text[:300]}")
        return resp.json() if resp.content else None

    async def sources(self, domain: str | None = None) -> list[Source]:
        params = {
            "select": "id,domain,sitemap_url",
            "crawl_enabled": "is.true",
            "opted_out_at": "is.null",
            "order": "last_crawled_at.asc.nullsfirst",
        }
        if domain:
            params["domain"] = f"eq.{domain}"
        rows = await self._call("GET", "recipe_sources", params=params)
        return [Source(r["id"], r["domain"], r["sitemap_url"]) for r in rows]

    async def start_run(self, source: Source) -> str:
        rows = await self._call("POST", "crawl_runs", json={"source_id": source.id}, returning=True)
        return str(rows[0]["id"])

    async def enqueue(self, source: Source, entries: list[Entry]) -> int:
        body = {
            "p_source": source.id,
            "p_entries": [{"url": e.url, "lastmod": e.lastmod} for e in entries],
        }
        return int(await self._call("POST", "rpc/crawl_enqueue", json=body))

    async def due_pages(self, source: Source, limit: int) -> list[QueuedPage]:
        rows = await self._call(
            "GET",
            "crawl_pages",
            params={
                "select": "id,url,lastmod,attempts,recipe_id",
                "source_id": f"eq.{source.id}",
                "or": "(status.eq.pending,and(status.eq.error,attempts.lt.3))",
                "order": "first_seen_at.asc",
                "limit": str(limit),
            },
        )
        return [
            QueuedPage(r["id"], r["url"], r["lastmod"], r["attempts"], r["recipe_id"]) for r in rows
        ]

    async def save_recipe(self, payload: dict[str, Any]) -> dict[str, Any]:
        result: dict[str, Any] = await self._call("POST", "rpc/import_recipe", json={"p": payload})
        return result

    async def record_page(
        self,
        page: QueuedPage,
        status: PageStatus,
        error_code: str | None = None,
        recipe_id: str | None = None,
    ) -> None:
        body: dict[str, Any] = {
            "status": status,
            "error_code": error_code,
            "attempts": page.attempts + 1 if status == "error" else 0,
            "last_fetched_at": _now(),
            "fetched_lastmod": page.lastmod,
        }
        if recipe_id:
            body["recipe_id"] = recipe_id
        await self._call("PATCH", "crawl_pages", params={"id": f"eq.{page.id}"}, json=body)

    async def hide_recipe(self, source: Source, recipe_id: str) -> None:
        """Hide a public recipe, but only one that belongs to this source."""
        await self._call(
            "PATCH",
            "recipes",
            params={
                "id": f"eq.{recipe_id}",
                "source_id": f"eq.{source.id}",
                "visibility": "eq.public",
                "status": "in.(active,needs_review)",
            },
            json={"status": "hidden"},
        )

    async def opt_out(self, source: Source) -> int:
        return int(await self._call("POST", "rpc/opt_out_source", json={"p_source": source.id}))

    async def finish_run(self, report: RunReport) -> None:
        now = _now()
        await self._call(
            "PATCH",
            "crawl_runs",
            params={"id": f"eq.{report.run_id}"},
            json={
                "status": report.status,
                "stop_reason": report.stop_reason,
                "finished_at": now,
                **report.counts(),
            },
        )
        await self._call(
            "PATCH",
            "recipe_sources",
            params={"id": f"eq.{report.source.id}"},
            json={"last_crawled_at": now},
        )
