"""The Kroger API: Harris Teeter products and prices (TYL-80), and stores
near a zip code (TYL-19).

Kroger's terms (§5e.1) don't allow keeping their content: product responses
carry no cache header, so names, sizes and prices are used for the request
that fetched them and never stored. Sous stores only which product it picked
for each ingredient (kroger_product_matches). Credentials are server-side only.
"""

import time
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx2 as httpx

from app.config import settings

BASE = "https://api.kroger.com/v1"
# Products allows 10,000 calls a day; one search per ingredient when matching,
# one lookup per 50 products when pricing.
MAX_IDS = 50
# Seconds to wait before retrying a 429 or 5xx; the last try's error stands.
RETRY_WAITS = (1.0, 3.0, 0.0)
# Every Harris Teeter is on Eastern time. Kroger gives sale ends in UTC:
# "2026-10-14T03:59:59Z" is the end of Tuesday the 13th in the store.
STORE_TZ = ZoneInfo("America/New_York")


@dataclass
class Product:
    """One product at one store, as Kroger describes it right now."""

    product_id: str
    description: str
    brand: str | None
    size: str | None
    # UNIT (sold per package) or WEIGHT (priced per lb).
    sold_by: str | None
    regular: float | None
    promo: float | None
    # The last day of the sale, in the store's time zone.
    promo_ends: date | None
    in_store: bool
    # Kroger's departments: "Produce", "Baking Goods", "Meat & Seafood".
    categories: tuple[str, ...] = ()


@dataclass
class Location:
    """A Kroger-family store (Kroger, Harris Teeter, Ralphs...)."""

    location_id: str
    # Kroger's chain code: "HART" for Harris Teeter, "KROGER", "RALPHS"...
    chain: str
    name: str
    address: str
    city: str
    state: str
    zip: str


def parse_location(loc: dict[str, Any]) -> Location:
    """A store from the Locations API's response."""
    a = loc.get("address") or {}
    return Location(
        location_id=str(loc["locationId"]),
        chain=str(loc.get("chain") or ""),
        name=str(loc.get("name") or ""),
        address=str(a.get("addressLine1") or ""),
        city=str(a.get("city") or ""),
        state=str(a.get("state") or ""),
        zip=str(a.get("zipCode") or "")[:5],
    )


def parse_product(p: dict[str, Any]) -> Product:
    item = (p.get("items") or [{}])[0]
    price = item.get("price") or {}
    promo = price.get("promo") or None
    return Product(
        product_id=p["productId"],
        description=p.get("description") or "",
        brand=p.get("brand"),
        size=item.get("size"),
        sold_by=item.get("soldBy"),
        regular=price.get("regular") or None,
        promo=promo,
        promo_ends=_local_date((price.get("expirationDate") or {}).get("value")) if promo else None,
        in_store=(item.get("fulfillment") or {}).get("inStore", True) is not False,
        categories=tuple(dict.fromkeys(p.get("categories") or [])),
    )


def _local_date(value: str | None) -> date | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(STORE_TZ).date()


class Kroger:
    def __init__(self, client: httpx.Client) -> None:
        self.client = client
        self._token: str | None = None
        self._expires = 0.0

    def _auth(self) -> dict[str, str]:
        if not self._token or time.monotonic() > self._expires:
            if not settings.kroger_client_id or not settings.kroger_client_secret:
                raise RuntimeError("KROGER_CLIENT_ID and KROGER_CLIENT_SECRET aren't set")
            resp = self.client.post(
                f"{BASE}/connect/oauth2/token",
                data={"grant_type": "client_credentials", "scope": "product.compact"},
                auth=(settings.kroger_client_id, settings.kroger_client_secret),
            )
            resp.raise_for_status()
            body = resp.json()
            self._token = body["access_token"]
            self._expires = time.monotonic() + body.get("expires_in", 1800) - 60
        return {"Authorization": f"Bearer {self._token}"}

    def _products(self, params: dict[str, Any]) -> list[Product]:
        for wait in RETRY_WAITS:
            resp = self.client.get(f"{BASE}/products", params=params, headers=self._auth())
            if resp.status_code != 429 and resp.status_code < 500:
                break
            time.sleep(wait)  # Kroger has the odd brief outage
        if resp.status_code == 404:
            return []  # some searches that find nothing answer 404
        resp.raise_for_status()
        return [parse_product(p) for p in resp.json().get("data") or []]

    def _get(self, path: str, params: dict[str, Any]) -> httpx.Response:
        """GET from the API, retrying the odd 429 or 5xx."""
        for wait in RETRY_WAITS:
            resp = self.client.get(f"{BASE}/{path}", params=params, headers=self._auth())
            if resp.status_code != 429 and resp.status_code < 500:
                break
            time.sleep(wait)
        return resp

    def stores_near(self, zip_code: str, miles: int = 15, limit: int = 10) -> list[Location]:
        """Kroger-family stores near a zip code, nearest first. (Locations
        allows 1,600 calls a day.)"""
        resp = self._get(
            "locations",
            {
                "filter.zipCode.near": zip_code,
                "filter.radiusInMiles": miles,
                "filter.limit": limit,
            },
        )
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        return [parse_location(loc) for loc in resp.json().get("data") or []]

    def store(self, location_id: str) -> Location | None:
        """One store by its location id; None when Kroger doesn't know it."""
        resp = self._get(f"locations/{location_id}", {})
        if resp.status_code in (400, 404):
            return None
        resp.raise_for_status()
        data = resp.json().get("data")
        return parse_location(data) if data else None

    def search(self, term: str, location_id: str, limit: int = 20) -> list[Product]:
        """Products matching `term` at a store, in Kroger's order."""
        return self._products(
            {"filter.term": term, "filter.locationId": location_id, "filter.limit": limit}
        )

    def products(self, product_ids: list[str], location_id: str) -> list[Product]:
        """These products at a store, with today's prices."""
        found: list[Product] = []
        for i in range(0, len(product_ids), MAX_IDS):
            batch = product_ids[i : i + MAX_IDS]
            found += self._products(
                {
                    "filter.productId": ",".join(batch),
                    "filter.locationId": location_id,
                    "filter.limit": len(batch),
                }
            )
        return found
