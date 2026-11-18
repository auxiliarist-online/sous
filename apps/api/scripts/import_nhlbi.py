"""Import NHLBI's public-domain recipes into the shared catalog (TYL-42).

    .venv/bin/python scripts/import_nhlbi.py            # download, then load
    .venv/bin/python scripts/import_nhlbi.py download   # update the local copy only
    .venv/bin/python scripts/import_nhlbi.py load       # load from the local copy
    .venv/bin/python scripts/import_nhlbi.py load --dry-run --out nhlbi.json
    .venv/bin/python scripts/import_nhlbi.py sources    # which cookbooks pages credit

USDA's own recipe sites turn SousBot away (403) or need a login, so federal
recipes come from NHLBI (NIH), whose site is public domain unless noted
(app/recipes/nhlbi.py). Only recipes credited to NHLBI's or NIH's own
cookbooks are kept.

Download: the recipe index's pages are read in turn (?page=0, 1, ...) for
their recipe links, then each recipe page, through app/recipes/fetch.py like
any import: SousBot, robots.txt checked on every hop, at most one request
every five seconds (or the site's longer Crawl-delay). When the site is busy
(429/503) it waits and tries again a few times, then stops; pages are kept in
.cache/nhlbi/ (not in git), so a stopped download picks up where it left off.

Load: each page goes through app/recipes/nhlbi.py and the catalog's exclusion
rules, then import_recipes() and publish_licensed_recipes() as for Wikibooks.
Loading again updates recipes in place. Uses the service role from .env.
"""

import argparse
import asyncio
import json
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlencode

import httpx2 as httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.recipes.curation import excluded  # noqa: E402
from app.recipes.fetch import TIMEOUT, FetchError, fetch_page  # noqa: E402
from app.recipes.nhlbi import DOMAIN, INDEX_URL, parse, recipe_links, source_of  # noqa: E402
from scripts.import_wikibooks import hide, load  # noqa: E402

MAX_INDEX_PAGES = 100
BACKOFF = 120.0  # seconds to wait when the site is busy
TRIES = 3
CACHE = Path(__file__).resolve().parents[1] / ".cache" / "nhlbi"


def slug(url: str) -> str:
    """The cache file name for a recipe page."""
    return url.rstrip("/").rsplit("/", 1)[-1] + ".html"


async def _get(client: httpx.AsyncClient, url: str) -> str:
    """One page through the shared fetcher (robots.txt, throttle). A busy
    site gets a few tries, waiting longer each time; anything else it
    refuses ends the download."""
    for attempt in range(1, TRIES + 1):
        try:
            return (await fetch_page(url, client)).html
        except FetchError as e:
            if e.code not in ("rate_limited", "unreachable", "timeout") or attempt == TRIES:
                sys.exit(f"stopped at {url}: {e.code}. Run again later to carry on.")
            print(f"{url}: {e.code}, waiting {BACKOFF * attempt:.0f}s", file=sys.stderr)
            await asyncio.sleep(BACKOFF * attempt)
    raise AssertionError("unreachable")


async def _download() -> None:
    """Fetch the index pages and any recipe pages not cached yet."""
    CACHE.mkdir(parents=True, exist_ok=True)
    links: list[str] = []
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        for page in range(MAX_INDEX_PAGES):
            html = await _get(client, f"{INDEX_URL}?{urlencode({'page': page})}")
            found = [u for u in recipe_links(html) if u not in links]
            if not found:
                break
            links += found
            print(f"index page {page}: {len(links)} recipes so far", file=sys.stderr)
        (CACHE / "links.json").write_text(json.dumps(links, indent=1))
        for n, url in enumerate(links, 1):
            path = CACHE / slug(url)
            if path.exists():
                continue
            path.write_text(await _get(client, url))
            print(f"{n}/{len(links)} {url}", file=sys.stderr)


def download() -> dict[str, str]:
    """Fetch new recipe pages into the cache; return {url: html} for all."""
    asyncio.run(_download())
    return read_cache()


def read_cache() -> dict[str, str]:
    """{url: html} for every cached recipe page, in index order."""
    links_file = CACHE / "links.json"
    if not links_file.exists():
        return {}
    links: list[str] = json.loads(links_file.read_text())
    return {u: (CACHE / slug(u)).read_text() for u in links if (CACHE / slug(u)).exists()}


def main() -> None:
    """Download, load, or report the credited cookbooks (see the docstring)."""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "step", nargs="?", choices=("all", "download", "load", "sources"), default="all"
    )
    ap.add_argument("--dry-run", action="store_true", help="load: parse and report; save nothing")
    ap.add_argument("--out", type=Path, help="load: write the parsed recipes here as JSON")
    ap.add_argument("--batch", type=int, default=50, help="load: recipes per database call")
    ap.add_argument("--concurrency", type=int, default=2, help="load: database calls at once")
    args = ap.parse_args()

    pages = download() if args.step in ("all", "download") else read_cache()
    if args.step == "download":
        return
    if not pages:
        sys.exit(f"No local copy at {CACHE}; run the download step first")
    if args.step == "sources":
        for name, count in Counter(source_of(h) for h in pages.values()).most_common():
            print(f"{count}\t{name}")
        return
    parsed = [d for url, html in pages.items() if (d := parse(url, html))]
    left_out = [(d, reason) for d in parsed if (reason := excluded(d))]
    drafts = [d for d in parsed if not excluded(d)]
    for d, reason in left_out:
        print(f"left out: {d.title} ({reason})", file=sys.stderr)
    print(
        f"{len(pages)} pages, {len(parsed)} federal recipes, {len(left_out)} left out",
        file=sys.stderr,
    )
    if args.out:
        args.out.write_text(
            json.dumps([d.payload(None) for d in drafts], indent=1, ensure_ascii=False)
        )
    if args.dry_run:
        return
    if not settings.supabase_url or not settings.supabase_service_role_key:
        sys.exit("Supabase isn't configured (.env)")
    asyncio.run(hide([d.source_url for d, _ in left_out]))
    published = asyncio.run(load(drafts, args.batch, args.concurrency, domain=DOMAIN))
    print(f"{published} recipes published", file=sys.stderr)


if __name__ == "__main__":
    main()
