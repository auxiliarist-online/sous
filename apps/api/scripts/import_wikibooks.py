"""Import the Wikibooks Cookbook into the shared catalog (TYL-45).

    .venv/bin/python scripts/import_wikibooks.py --dry-run --out wikibooks.json
    .venv/bin/python scripts/import_wikibooks.py              # import and publish
    .venv/bin/python scripts/import_wikibooks.py --limit 50   # a few first

The Cookbook is CC BY-SA 4.0, so recipes are stored with their steps and
shown with attribution (docs/policies/recipe-sources.md). Pages come from the
MediaWiki API, not by crawling, following Wikimedia's API etiquette: one
request at a time, a SousBot user agent with a contact link, and maxlag so we
back off when their servers are busy.

Each page goes through app/recipes/wikibooks.py; pages that aren't usable
recipes (articles, stubs, no steps) are skipped. Recipes are saved through
import_recipe() and then published with publish_licensed_recipes(). Running it
again updates recipes whose pages changed. Uses the service role from .env.
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
BATCH = 50  # pages per request (the API's limit for page content)
PAUSE = 1.0  # seconds between requests


def pages(client: httpx.Client, limit: int | None) -> list[tuple[str, str]]:
    """(title, wikitext) for every page in the recipes category."""
    params: dict[str, Any] = {
        "action": "query",
        "format": "json",
        "formatversion": "2",
        "maxlag": "5",
        "generator": "categorymembers",
        "gcmtitle": CATEGORY,
        "gcmnamespace": str(COOKBOOK_NAMESPACE),
        "gcmlimit": str(BATCH),
        "prop": "revisions",
        "rvprop": "content",
        "rvslots": "main",
    }
    found: list[tuple[str, str]] = []
    while True:
        resp = client.get(API, params=params)
        body = resp.json()
        if body.get("error", {}).get("code") == "maxlag":
            wait = int(resp.headers.get("Retry-After", "5"))
            print(f"servers busy, waiting {wait}s", file=sys.stderr)
            time.sleep(wait)
            continue
        resp.raise_for_status()
        for page in body.get("query", {}).get("pages", []):
            revisions = page.get("revisions") or []
            if revisions:
                found.append((page["title"], revisions[0]["slots"]["main"]["content"]))
        print(f"{len(found)} pages read", file=sys.stderr)
        if (limit and len(found) >= limit) or "continue" not in body:
            return found[:limit] if limit else found
        params.update(body["continue"])
        time.sleep(PAUSE)


async def save(drafts: list[RecipeDraft], concurrency: int) -> int:
    """Save every draft, several at a time: each save is a round trip to the
    database plus its parsing and diet labelling, so one at a time is slow."""
    key = settings.supabase_service_role_key
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    base = f"{settings.supabase_url}/rest/v1"
    gate = asyncio.Semaphore(concurrency)
    done = 0
    async with httpx.AsyncClient(timeout=60.0, headers=headers) as client:

        async def one(draft: RecipeDraft) -> None:
            nonlocal done
            async with gate:
                resp = await client.post(
                    f"{base}/rpc/import_recipe", json={"p": draft.payload(None)}
                )
            if resp.status_code != 200:
                print(f"failed: {draft.title}: {resp.text[:200]}", file=sys.stderr)
            done += 1
            if done % 250 == 0:
                print(f"{done} saved", file=sys.stderr)

        await asyncio.gather(*(one(d) for d in drafts))
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
    ap.add_argument("--limit", type=int, help="read at most this many pages")
    ap.add_argument("--dry-run", action="store_true", help="parse and report; save nothing")
    ap.add_argument("--out", type=Path, help="write the parsed recipes here as JSON")
    ap.add_argument(
        "--concurrency", type=int, default=8, help="saves in flight at once (default 8)"
    )
    args = ap.parse_args()
    if not settings.sousbot_contact_url:
        sys.exit("Set SOUSBOT_CONTACT_URL: Wikimedia asks for contact details in the user agent")

    with httpx.Client(timeout=60.0, headers={"User-Agent": user_agent()}) as client:
        raw = pages(client, args.limit)
    drafts = [d for title, text in raw if (d := parse(title, text))]
    print(f"{len(raw)} pages, {len(drafts)} usable recipes", file=sys.stderr)

    if args.out:
        args.out.write_text(
            json.dumps([d.payload(None) for d in drafts], indent=1, ensure_ascii=False)
        )
    if args.dry_run:
        return
    if not settings.supabase_url or not settings.supabase_service_role_key:
        sys.exit("Supabase isn't configured (.env)")
    print(f"{asyncio.run(save(drafts, args.concurrency))} recipes published", file=sys.stderr)


if __name__ == "__main__":
    main()
