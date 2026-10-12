"""Import the Wikibooks Cookbook into the shared catalog (TYL-45).

    .venv/bin/python scripts/import_wikibooks.py            # download changes, then load
    .venv/bin/python scripts/import_wikibooks.py download   # update the local copy only
    .venv/bin/python scripts/import_wikibooks.py load       # load from the local copy
    .venv/bin/python scripts/import_wikibooks.py load --dry-run --out wikibooks.json

The Cookbook is CC BY-SA 4.0, so recipes are stored with their steps and
shown with attribution (docs/policies/recipe-sources.md).

Download: pages come from the MediaWiki API, not by crawling, following
Wikimedia's API etiquette (one request at a time, a SousBot user agent with a
contact link, maxlag). The raw pages are kept in .cache/wikibooks/pages.jsonl
(not in git). Later downloads list the pages' latest revisions and fetch only
pages that are new or changed, so re-running costs Wikimedia a few requests.

Load: each cached page goes through app/recipes/wikibooks.py (pages that
aren't usable recipes are skipped), then batches go to import_recipes() in the
database, a few at a time, and publish_licensed_recipes() makes them public.
Loading again updates recipes in place. Uses the service role from .env.
"""

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

import httpx2 as httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.recipes.extract import RecipeDraft  # noqa: E402
from app.recipes.fetch import user_agent  # noqa: E402
from app.recipes.wikibooks import DOMAIN, parse  # noqa: E402

API = f"https://{DOMAIN}/w/api.php"
CATEGORY = "Category:Recipes"
COOKBOOK_NAMESPACE = 102
LIST_BATCH = 500  # pages per listing request
CONTENT_BATCH = 50  # pages per content request (the API's limit for content)
PAUSE = 1.0  # seconds between requests
CACHE = Path(__file__).resolve().parents[1] / ".cache" / "wikibooks" / "pages.jsonl"

Page = dict[str, Any]  # {pageid, title, revid, wikitext}


# ---------- download ----------


def _get(client: httpx.Client, params: dict[str, Any]) -> dict[str, Any]:
    """One API request, waiting while Wikimedia's servers are busy (maxlag)."""
    base = {"action": "query", "format": "json", "formatversion": "2", "maxlag": "5"}
    while True:
        resp = client.get(API, params={**base, **params})
        body: dict[str, Any] = resp.json()
        if body.get("error", {}).get("code") == "maxlag":
            wait = int(resp.headers.get("Retry-After", "5"))
            print(f"servers busy, waiting {wait}s", file=sys.stderr)
            time.sleep(wait)
            continue
        resp.raise_for_status()
        time.sleep(PAUSE)
        return body


def latest_revisions(client: httpx.Client) -> dict[int, tuple[str, int]]:
    """{pageid: (title, latest revision)} for every recipe page: no content."""
    params: dict[str, Any] = {
        "generator": "categorymembers",
        "gcmtitle": CATEGORY,
        "gcmnamespace": str(COOKBOOK_NAMESPACE),
        "gcmlimit": str(LIST_BATCH),
        "prop": "info",
    }
    found: dict[int, tuple[str, int]] = {}
    while True:
        body = _get(client, params)
        for page in body.get("query", {}).get("pages", []):
            found[page["pageid"]] = (page["title"], page["lastrevid"])
        if "continue" not in body:
            return found
        params.update(body["continue"])


def contents(client: httpx.Client, pageids: list[int]) -> list[Page]:
    pages: list[Page] = []
    for start in range(0, len(pageids), CONTENT_BATCH):
        batch = pageids[start : start + CONTENT_BATCH]
        body = _get(
            client,
            {
                "pageids": "|".join(map(str, batch)),
                "prop": "revisions",
                "rvprop": "content|ids",
                "rvslots": "main",
            },
        )
        for page in body.get("query", {}).get("pages", []):
            revs = page.get("revisions") or []
            if revs:
                pages.append(
                    {
                        "pageid": page["pageid"],
                        "title": page["title"],
                        "revid": revs[0]["revid"],
                        "wikitext": revs[0]["slots"]["main"]["content"],
                    }
                )
        print(f"{start + len(batch)} of {len(pageids)} changed pages read", file=sys.stderr)
    return pages


def read_cache() -> dict[int, Page]:
    if not CACHE.exists():
        return {}
    with CACHE.open(encoding="utf-8") as f:
        return {p["pageid"]: p for p in map(json.loads, f)}


def download() -> dict[int, Page]:
    """Bring the local copy up to date; returns it."""
    if not settings.sousbot_contact_url:
        sys.exit("Set SOUSBOT_CONTACT_URL: Wikimedia asks for contact details in the user agent")
    cached = read_cache()
    with httpx.Client(timeout=60.0, headers={"User-Agent": user_agent()}) as client:
        latest = latest_revisions(client)
        changed = [
            pid for pid, (_, rev) in latest.items() if cached.get(pid, {}).get("revid") != rev
        ]
        print(f"{len(latest)} pages, {len(changed)} new or changed", file=sys.stderr)
        for page in contents(client, changed):
            cached[page["pageid"]] = page
    current = {pid: p for pid, p in cached.items() if pid in latest}  # drop removed pages
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for page in current.values():
            f.write(json.dumps(page, ensure_ascii=False) + "\n")
    tmp.replace(CACHE)
    return current


# ---------- load ----------


async def load(drafts: list[RecipeDraft], batch: int, concurrency: int) -> int:
    """Save drafts in batches through import_recipes(), a few batches at a
    time, then publish them."""
    key = settings.supabase_service_role_key
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    base = f"{settings.supabase_url}/rest/v1"
    gate = asyncio.Semaphore(concurrency)
    saved = 0
    failed: list[dict[str, str]] = []
    async with httpx.AsyncClient(timeout=120.0, headers=headers) as client:

        async def one(chunk: list[RecipeDraft]) -> None:
            nonlocal saved
            async with gate:
                resp = await client.post(
                    f"{base}/rpc/import_recipes",
                    json={"p_recipes": [d.payload(None) for d in chunk]},
                )
            if resp.status_code != 200:
                failed.extend({"source_url": d.source_url, "error": resp.text[:200]} for d in chunk)
                return
            result = resp.json()
            saved += result["saved"]
            failed.extend(result["failed"])
            print(f"{saved} saved", file=sys.stderr)

        chunks = [drafts[i : i + batch] for i in range(0, len(drafts), batch)]
        await asyncio.gather(*(one(c) for c in chunks))
        for f in failed:
            print(f"failed: {f['source_url']}: {f['error']}", file=sys.stderr)
        source = await client.get(
            f"{base}/recipe_sources", params={"select": "id", "domain": f"eq.{DOMAIN}"}
        )
        source.raise_for_status()
        published = await client.post(
            f"{base}/rpc/publish_licensed_recipes", json={"p_source": source.json()[0]["id"]}
        )
        published.raise_for_status()
        return int(published.json())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("step", nargs="?", choices=("all", "download", "load"), default="all")
    ap.add_argument("--dry-run", action="store_true", help="load: parse and report; save nothing")
    ap.add_argument("--out", type=Path, help="load: write the parsed recipes here as JSON")
    ap.add_argument("--batch", type=int, default=50, help="load: recipes per database call")
    ap.add_argument("--concurrency", type=int, default=4, help="load: database calls at once")
    args = ap.parse_args()

    pages = download() if args.step in ("all", "download") else read_cache()
    if args.step == "download":
        return
    if not pages:
        sys.exit(f"No local copy at {CACHE}; run the download step first")
    drafts = [d for p in pages.values() if (d := parse(p["title"], p["wikitext"]))]
    print(f"{len(pages)} pages, {len(drafts)} usable recipes", file=sys.stderr)
    if args.out:
        args.out.write_text(
            json.dumps([d.payload(None) for d in drafts], indent=1, ensure_ascii=False)
        )
    if args.dry_run:
        return
    if not settings.supabase_url or not settings.supabase_service_role_key:
        sys.exit("Supabase isn't configured (.env)")
    published = asyncio.run(load(drafts, args.batch, args.concurrency))
    print(f"{published} recipes published", file=sys.stderr)


if __name__ == "__main__":
    main()
