"""Run the crawler: python -m app.crawl [--source DOMAIN] [--max-pages N]

Meant to run as a nightly batch job. Exits non-zero if SOUSBOT_CONTACT_URL
isn't set, or if any site's run failed.
"""

import argparse
import asyncio
import logging
import sys

import httpx2 as httpx

from app.crawl.job import MAX_PAGES_PER_RUN, CrawlNotAllowed, crawl_all
from app.crawl.store import RunReport, SupabaseCrawlStore


async def main(domain: str | None, max_pages: int) -> list[RunReport]:
    async with httpx.AsyncClient(timeout=30.0) as db:
        return await crawl_all(SupabaseCrawlStore(db), domain, max_pages)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="python -m app.crawl", description=__doc__)
    parser.add_argument("--source", help="only crawl this domain (e.g. minimalistbaker.com)")
    parser.add_argument("--max-pages", type=int, default=MAX_PAGES_PER_RUN)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        reports = asyncio.run(main(args.source, args.max_pages))
    except CrawlNotAllowed as e:
        sys.exit(str(e))
    sys.exit(1 if any(r.status == "failed" for r in reports) else 0)
