"""Fetch a recipe page politely and safely (TYL-8).

Rules from docs/policies/recipe-sources.md: an honest SousBot user agent,
robots.txt obeyed, at most one request per site every few seconds, and no
getting around blocks. The URL comes from a user, so every hop is also checked
against private and internal addresses before we connect.
"""

import asyncio
import ipaddress
import socket
import time
import urllib.robotparser
import zlib
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx2 as httpx

from app.config import settings

MAX_REDIRECTS = 5
MAX_BYTES = 5_000_000
ROBOTS_TTL_SECONDS = 24 * 3600
# Longest we'll wait for a site's turn. A site can set any Crawl-delay, so a
# longer wait fails as rate_limited instead of tying up the request.
MAX_WAIT_SECONDS = 60.0
TIMEOUT = httpx.Timeout(15.0, connect=5.0)


class FetchError(Exception):
    """A page we can't import. `code` is stable for clients; the message is user-facing."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Page:
    url: str  # after redirects
    html: str  # the decoded body: HTML, or XML for sitemaps


def user_agent() -> str:
    contact = settings.sousbot_contact_url
    return f"SousBot/0.1 (+{contact})" if contact else "SousBot/0.1"


async def _check_public_host(url: str) -> None:
    """Refuse anything but http(s) to public internet addresses."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FetchError("invalid_url", "That doesn't look like a web address.")
    if parts.port not in (None, 80, 443):
        raise FetchError("invalid_url", "Only standard web addresses can be imported.")
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(
            parts.hostname, parts.port or 443, type=socket.SOCK_STREAM
        )
    except socket.gaierror as e:
        raise FetchError("unreachable", "We couldn't find that website.") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise FetchError("invalid_url", "That address can't be imported.")


async def _get_public(client: httpx.AsyncClient, url: str) -> httpx.Response:
    """GET with redirects followed by hand, checking every hop is a public address."""
    for _ in range(MAX_REDIRECTS + 1):
        await _check_public_host(url)
        resp = await client.get(url, follow_redirects=False)
        if not (resp.is_redirect and "location" in resp.headers):
            return resp
        url = urljoin(url, resp.headers["location"])
    raise FetchError("unreachable", "That link redirects too many times.")


class Robots:
    """robots.txt per host, cached for a day, read the way RFC 9309 describes:
    a 4xx response means no rules; a 5xx or no response means try again later."""

    def __init__(self) -> None:
        self._cache: dict[str, tuple[float, urllib.robotparser.RobotFileParser]] = {}

    async def allowed(self, client: httpx.AsyncClient, url: str) -> bool:
        return (await self._parser(client, url)).can_fetch("SousBot", url)

    async def crawl_delay(self, client: httpx.AsyncClient, url: str) -> float | None:
        delay = (await self._parser(client, url)).crawl_delay("SousBot")
        return float(delay) if delay is not None else None

    async def sitemaps(self, client: httpx.AsyncClient, url: str) -> list[str]:
        """Sitemap URLs listed in the site's robots.txt."""
        return (await self._parser(client, url)).site_maps() or []

    async def _parser(
        self, client: httpx.AsyncClient, url: str
    ) -> urllib.robotparser.RobotFileParser:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        cached = self._cache.get(origin)
        if cached is None or time.monotonic() - cached[0] > ROBOTS_TTL_SECONDS:
            try:
                resp = await _get_public(client, f"{origin}/robots.txt")
            except httpx.HTTPError as e:
                raise FetchError("unreachable", "We couldn't reach that site.") from e
            if resp.status_code >= 500:
                raise FetchError("unreachable", "That site isn't responding right now.")
            parser = urllib.robotparser.RobotFileParser()
            parser.parse(resp.text.splitlines() if resp.status_code < 400 else [])
            cached = (time.monotonic(), parser)
            self._cache[origin] = cached
        return cached[1]


class Throttle:
    """At most one request per host every `interval` seconds (or the site's longer
    Crawl-delay); waits rather than failing."""

    def __init__(self, interval: float) -> None:
        self.interval = interval
        self._next: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def wait(self, host: str, crawl_delay: float | None = None) -> None:
        async with self._lock:
            now = time.monotonic()
            start = max(now, self._next.get(host, 0.0))
            if start - now > MAX_WAIT_SECONDS:
                raise FetchError("rate_limited", "That site is busy. Try again later.")
            self._next[host] = start + max(self.interval, crawl_delay or 0.0)
        if start > now:
            await asyncio.sleep(start - now)


robots = Robots()
throttle = Throttle(settings.fetch_interval_seconds)


def _blocked(resp: httpx.Response) -> bool:
    if resp.status_code in (401, 403):
        return True
    if resp.headers.get("cf-mitigated") == "challenge":
        return True
    return resp.status_code == 503 and "challenge" in resp.text[:2000].lower()


def _gunzip(data: bytes) -> bytes:
    inflater = zlib.decompressobj(wbits=31)
    try:
        out = inflater.decompress(data, MAX_BYTES + 1)
    except zlib.error as e:
        raise FetchError("unreachable", "That file couldn't be read.") from e
    if len(out) > MAX_BYTES:
        raise FetchError("too_large", "That page is too large to import.")
    return out


async def fetch_page(
    url: str, client: httpx.AsyncClient | None = None, *, accept: tuple[str, ...] = ("html",)
) -> Page:
    """`accept` lists content-type fragments we take; the crawler adds "xml" and
    "gzip" for sitemaps."""
    own_client = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT)
    client.headers["User-Agent"] = user_agent()
    try:
        for _ in range(MAX_REDIRECTS + 1):
            await _check_public_host(url)
            if not await robots.allowed(client, url):
                raise FetchError(
                    "robots_disallowed",
                    "This site asks automated tools not to read this page, so we can't import it. "
                    "You can still open it in your browser.",
                )
            await throttle.wait(urlsplit(url).netloc, await robots.crawl_delay(client, url))
            try:
                async with client.stream("GET", url, follow_redirects=False) as resp:
                    if resp.is_redirect and "location" in resp.headers:
                        url = urljoin(url, resp.headers["location"])
                        continue
                    if _blocked(resp):
                        await resp.aread()
                        raise FetchError(
                            "blocked",
                            "This site blocks automated imports. Open it in your browser instead.",
                        )
                    if resp.status_code in (404, 410):
                        raise FetchError("not_found", "That page doesn't exist anymore.")
                    if resp.status_code == 429:
                        raise FetchError("rate_limited", "That site is busy. Try again later.")
                    if resp.status_code >= 400:
                        raise FetchError("unreachable", "That site didn't respond properly.")
                    ctype = resp.headers.get("content-type", "")
                    if not any(kind in ctype for kind in accept):
                        raise FetchError("not_a_recipe", "That link isn't a web page.")
                    body = bytearray()
                    async for chunk in resp.aiter_bytes():
                        body += chunk
                        if len(body) > MAX_BYTES:
                            raise FetchError("too_large", "That page is too large to import.")
                    data = _gunzip(bytes(body)) if "gzip" in ctype else bytes(body)
                    encoding = resp.encoding or "utf-8"
                    return Page(url=str(resp.url), html=data.decode(encoding, errors="replace"))
            except httpx.TimeoutException as e:
                raise FetchError("timeout", "That site took too long to respond.") from e
            except httpx.HTTPError as e:
                raise FetchError("unreachable", "We couldn't reach that site.") from e
        raise FetchError("unreachable", "That link redirects too many times.")
    finally:
        if own_client:
            await client.aclose()
