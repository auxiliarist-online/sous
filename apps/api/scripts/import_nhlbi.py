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
their recipe links, then each recipe page, one request at a time with a pause,
as SousBot, within robots.txt (which allows these paths). Pages are kept in
.cache/nhlbi/ (not in git), and later downloads fetch only new recipes.

Load: each page goes through app/recipes/nhlbi.py and the catalog's exclusion
rules, then import_recipes() and publish_licensed_recipes() as for Wikibooks.
Loading again updates recipes in place. Uses the service role from .env.
"""

import argparse
import asyncio
import json
import sys
import time
from collections import Counter
from pathlib import Path

import httpx2 as httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.recipes.curation import excluded  # noqa: E402
from app.recipes.fetch import user_agent  # noqa: E402
from app.recipes.nhlbi import DOMAIN, INDEX_URL, parse, recipe_links, source_of  # noqa: E402
from scripts.import_wikibooks import hide, load  # noqa: E402

PAUSE = 2.0  # seconds between requests
MAX_INDEX_PAGES = 100
CACHE = Path(__file__).resolve().parents[1] / ".cache" / "nhlbi"


def slug(url: str) -> str:
    """The cache file name for a recipe page."""
    return url.rstrip("/").rsplit("/", 1)[-1] + ".html"


def download() -> dict[str, str]:
    """Fetch new recipe pages into the cache; return {url: html} for all."""
    CACHE.mkdir(parents=True, exist_ok=True)
    links: list[str] = []
    with httpx.Client(
        timeout=60.0, headers={"User-Agent": user_agent()}, follow_redirects=True
    ) as client:
        for page in range(MAX_INDEX_PAGES):
            resp = client.get(INDEX_URL, params={"page": str(page)})
            resp.raise_for_status()
            time.sleep(PAUSE)
            found = [u for u in recipe_links(resp.text) if u not in links]
            if not found:
                break
            links += found
            print(f"index page {page}: {len(links)} recipes so far", file=sys.stderr)
        for n, url in enumerate(links, 1):
            path = CACHE / slug(url)
            if path.exists():
                continue
            resp = client.get(url)
            time.sleep(PAUSE)
            if resp.status_code != 200:
                print(f"skipped {url}: HTTP {resp.status_code}", file=sys.stderr)
                continue
            path.write_text(resp.text)
            print(f"{n}/{len(links)} {url}", file=sys.stderr)
    (CACHE / "links.json").write_text(json.dumps(links, indent=1))
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
