"""Find a site's recipe URLs from its sitemaps (TYL-26).

The policy only lets the crawler fetch pages listed in a site's sitemap, and
`lastmod` tells us which ones changed since the last crawl.
"""

import logging
import re
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urlsplit

import defusedxml.ElementTree as ET
import httpx2 as httpx
from defusedxml import DefusedXmlException

from app.recipes import fetch
from app.recipes.extract import canonical_url, domain_of
from app.recipes.fetch import FetchError, fetch_page

log = logging.getLogger(__name__)

SITEMAP_TYPES = ("xml", "gzip")
MAX_SITEMAPS = 100
MAX_URLS = 50_000

# WordPress and Yoast split sitemaps by type; these hold no recipes.
SKIP_SITEMAP = re.compile(
    r"(category|tag|author|users|taxonom|attachment|product|web-?stor|video|image|"
    r"page-sitemap|posts-page|misc)",
    re.I,
)
SKIP_PATH = re.compile(
    r"^/(category|tag|author|page|wp-content|feed|shop|about|contact)(/|$)", re.I
)


@dataclass(frozen=True)
class Entry:
    url: str
    lastmod: str | None  # ISO 8601


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _lastmod(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.strip()).isoformat()
    except ValueError:
        return None


def parse_sitemap(xml: str) -> tuple[list[Entry], list[str]]:
    """Returns (page entries, child sitemap URLs) from a urlset or sitemapindex."""
    try:
        root = ET.fromstring(xml)
    except (ET.ParseError, DefusedXmlException) as e:
        raise FetchError("not_a_sitemap", "That sitemap couldn't be read.") from e
    entries: list[Entry] = []
    children: list[str] = []
    for item in root:
        fields = {_local(child.tag): (child.text or "").strip() for child in item}
        loc = fields.get("loc")
        if not loc:
            continue
        if _local(root.tag) == "sitemapindex":
            children.append(loc)
        else:
            entries.append(Entry(loc, _lastmod(fields.get("lastmod"))))
    return entries, children


async def find_recipe_urls(
    client: httpx.AsyncClient, domain: str, sitemap_url: str | None = None
) -> list[Entry]:
    """Every page URL on `domain` from its sitemaps, minus obvious non-recipe pages.

    Starts from `sitemap_url`, else the Sitemap lines in robots.txt, else
    /sitemap.xml. Raises the first FetchError if no sitemap could be read at all.
    """
    home = f"https://{domain}/"
    queue = [sitemap_url] if sitemap_url else await fetch.robots.sitemaps(client, home)
    queue = queue or [f"{home}sitemap.xml"]
    seen: set[str] = set()
    found: dict[str, Entry] = {}
    first_error: FetchError | None = None
    read_any = False

    while queue and len(seen) < MAX_SITEMAPS and len(found) < MAX_URLS:
        url = queue.pop(0)
        if url in seen or domain_of(url) != domain:
            continue
        seen.add(url)
        try:
            page = await fetch_page(url, client, accept=SITEMAP_TYPES)
            entries, children = parse_sitemap(page.html)
        except FetchError as e:
            log.warning("%s: sitemap %s: %s", domain, url, e.code)
            first_error = first_error or e
            if e.code in ("blocked", "rate_limited"):
                break  # don't keep knocking
            continue
        read_any = True
        queue += [c for c in children if not SKIP_SITEMAP.search(urlsplit(c).path)]
        for entry in entries:
            if domain_of(entry.url) == domain and not SKIP_PATH.search(urlsplit(entry.url).path):
                url = canonical_url(entry.url)
                found[url] = Entry(url, entry.lastmod)

    if not read_any and first_error:
        raise first_error
    return list(found.values())[:MAX_URLS]
