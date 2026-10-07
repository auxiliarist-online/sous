"""Crawl approved recipe sites in small, polite batches (TYL-26).

For each source with crawl_enabled (and not opted out): read its sitemaps, queue
new or changed URLs, then fetch up to `max_pages` of them through the same
fetch and extract code as URL import. Rules from docs/policies/recipe-sources.md:

- SousBot user agent with a contact URL; refuses to run without one.
- robots.txt obeyed per page; a site that disallows SousBot entirely is treated
  as an opt-out. Crawl-delay is honored when it's longer than our 5 seconds.
- A block (401/403/challenge) stops that page; repeated blocks or errors stop
  the site until the next run. 429 backs off before trying again.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable

import httpx2 as httpx

from app.config import settings
from app.crawl.sitemap import find_recipe_urls
from app.crawl.store import CrawlStore, PageStatus, QueuedPage, RunReport, Source
from app.recipes import fetch
from app.recipes.extract import extract_recipe
from app.recipes.fetch import TIMEOUT, FetchError, fetch_page, user_agent

log = logging.getLogger(__name__)

MAX_PAGES_PER_RUN = 100
# Consecutive blocks or errors before we stop a site for this run.
STOP_AFTER = 3
BACKOFF_SECONDS = 60.0

Sleep = Callable[[float], Awaitable[None]]

# FetchError codes from fetch_page/extract_recipe -> what we record for the page.
PAGE_STATUS: dict[str, PageStatus] = {
    "not_a_recipe": "not_recipe",
    "not_found": "not_found",
    "blocked": "blocked",
    "robots_disallowed": "robots_disallowed",
}


class CrawlNotAllowed(Exception):
    """Bulk crawling must not start until SousBot's contact page exists."""


async def crawl_source(
    source: Source,
    store: CrawlStore,
    client: httpx.AsyncClient,
    max_pages: int = MAX_PAGES_PER_RUN,
    sleep: Sleep = asyncio.sleep,
) -> RunReport:
    report = RunReport(source, run_id=await store.start_run(source))
    try:
        await _crawl(report, store, client, max_pages, sleep)
    except Exception as e:
        report.status, report.stop_reason = "failed", f"{type(e).__name__}: {e}"[:500]
        log.exception("%s: crawl failed", source.domain)
    await store.finish_run(report)
    log.info(
        "%s: %s%s %s",
        source.domain,
        report.status,
        f" ({report.stop_reason})" if report.stop_reason else "",
        report.counts(),
    )
    return report


async def _crawl(
    report: RunReport,
    store: CrawlStore,
    client: httpx.AsyncClient,
    max_pages: int,
    sleep: Sleep,
) -> None:
    source = report.source
    require_contact_page()
    client.headers["User-Agent"] = user_agent()
    try:
        allowed = await fetch.robots.allowed(client, f"https://{source.domain}/")
    except FetchError as e:
        report.status, report.stop_reason = "stopped", f"robots.txt: {e.code}"
        return
    if not allowed:
        hidden = await store.opt_out(source)
        report.status, report.stop_reason = "stopped", "robots_disallowed"
        log.warning("%s: robots.txt disallows SousBot; opted out", source.domain)
        log.warning("%s: %d public recipes hidden", source.domain, hidden)
        return
    try:
        entries = await find_recipe_urls(client, source.domain, source.sitemap_url)
    except FetchError as e:
        report.status, report.stop_reason = "stopped", f"sitemap: {e.code}"
        return

    report.urls_queued = await store.enqueue(source, entries)
    strikes = 0
    for page in await store.due_pages(source, max_pages):
        status, code = await _crawl_page(page, report, store, client)
        if status in ("blocked", "error"):
            strikes += 1
            if strikes >= STOP_AFTER:
                report.status, report.stop_reason = "stopped", f"{STOP_AFTER} {code} in a row"
                return
            if code == "rate_limited":
                await sleep(BACKOFF_SECONDS * strikes)
        else:
            strikes = 0


async def _crawl_page(
    page: QueuedPage, report: RunReport, store: CrawlStore, client: httpx.AsyncClient
) -> tuple[PageStatus, str | None]:
    report.pages_fetched += 1
    try:
        fetched = await fetch_page(page.url, client)
        try:
            draft = extract_recipe(fetched.html, fetched.url)
        except FetchError:
            raise
        except Exception as e:  # a page recipe-scrapers chokes on shouldn't stop the site
            log.warning("%s: extract failed: %r", page.url, e)
            raise FetchError("extract_failed", str(e)) from e
    except FetchError as e:
        status = PAGE_STATUS.get(e.code, "error")
        report.pages_failed += status != "not_recipe"
        await store.record_page(page, status, e.code)
        # Gone from the site, or the site asked us not to read it: out of the catalog.
        if page.recipe_id and status in ("not_found", "robots_disallowed"):
            await store.hide_recipe(page.recipe_id)
        return status, e.code

    saved = await store.save_recipe({**draft.payload(None), "refresh": True})
    report.recipes_created += bool(saved.get("created"))
    report.recipes_updated += bool(saved.get("updated"))
    await store.record_page(page, "imported", recipe_id=saved["recipe_id"])
    return "imported", None


def require_contact_page() -> None:
    if not settings.sousbot_contact_url:
        raise CrawlNotAllowed(
            "Set SOUSBOT_CONTACT_URL to the live SousBot page before bulk crawling "
            "(docs/policies/recipe-sources.md)."
        )


async def crawl_all(
    store: CrawlStore,
    domain: str | None = None,
    max_pages: int = MAX_PAGES_PER_RUN,
    client: httpx.AsyncClient | None = None,
) -> list[RunReport]:
    """Crawl every approved source (or one), all at once: the throttle is per
    site, so running sites side by side doesn't make any one of them busier."""
    require_contact_page()  # refuse before touching anything
    sources = await store.sources(domain)
    if not sources:
        log.warning("no approved sources%s", f" matching {domain}" if domain else "")
        return []
    own_client = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT)
    try:
        return list(
            await asyncio.gather(*(crawl_source(s, store, client, max_pages) for s in sources))
        )
    finally:
        if own_client:
            await client.aclose()
