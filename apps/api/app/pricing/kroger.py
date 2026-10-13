"""The Kroger API: Harris Teeter products and prices (TYL-80).

Kroger's terms (§5e.1) don't allow keeping their content: product responses
carry no cache header, so names, sizes and prices are used for the request
that fetched them and never stored. Sous stores only which product it picked
for each ingredient (kroger_product_matches). Credentials are server-side only.
"""

import time
from dataclasses import dataclass
from typing import Any

import httpx2 as httpx

from app.config import settings

BASE = "https://api.kroger.com/v1"
# Products allows 10,000 calls a day; one search per ingredient when matching,
# one lookup per 50 products when pricing.
MAX_IDS = 50
# Seconds to wait before retrying a 429 or 5xx; the last try's error stands.
RETRY_WAITS = (1.0, 3.0, 0.0)


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
    promo_ends: str | None
    in_store: bool
    # Kroger's departments: "Produce", "Baking Goods", "Meat & Seafood".
    categories: tuple[str, ...] = ()


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
        promo_ends=(price.get("expirationDate") or {}).get("value") if promo else None,
        in_store=(item.get("fulfillment") or {}).get("inStore", True) is not False,
        categories=tuple(dict.fromkeys(p.get("categories") or [])),
    )


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
