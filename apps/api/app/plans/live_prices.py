"""Today's Harris Teeter prices for a plan, fetched live (TYL-80).

Kroger's terms don't allow keeping their prices or product details, so they're
added to this request's cost inputs and never stored. Sous stores only which
product it buys for each ingredient (kroger_product_matches, written by
scripts/match_kroger.py). Anything going wrong here falls back to the
estimates: a plan never fails to price because Kroger is down.
"""

import asyncio
import logging
import threading
import time
from datetime import UTC, datetime
from typing import Any

import httpx2 as httpx

from app.config import settings
from app.pricing.kroger import Kroger, Product
from app.pricing.kroger_match import parse_size

log = logging.getLogger(__name__)


def _rest(client: httpx.AsyncClient, path: str, params: dict[str, str]) -> Any:
    key = settings.supabase_service_role_key
    return client.get(
        f"{settings.supabase_url}/rest/v1/{path}",
        params=params,
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )


async def _store(client: httpx.AsyncClient, user_id: str) -> dict[str, Any] | None:
    """The user's primary store, if it has live prices. Without one there's
    no store to price from: Sous uses estimates and says why (no_store)."""
    select = "id,name,external_location_id,chain_slug,store_chains!inner(price_source)"
    resp = await _rest(
        client,
        "user_stores",
        {
            "select": f"stores!inner({select})",
            "user_id": f"eq.{user_id}",
            "is_primary": "is.true",
            "stores.store_chains.price_source": "eq.kroger_api",
        },
    )
    resp.raise_for_status()
    rows = resp.json()
    return rows[0]["stores"] if rows else None


# Whether a zip code has a Kroger-family store within 15 miles, by zip, with
# when it was asked: Kroger is asked at most once a day per zip.
_nearby: dict[str, tuple[bool, float]] = {}
NEARBY_SECONDS = 24 * 3600
# One lookup per zip at a time: a second request for it waits for the answer.
_nearby_locks: dict[str, threading.Lock] = {}
_locks_lock = threading.Lock()


def _has_store_near(zip_code: str) -> bool | None:
    """Whether Kroger lists a store within 15 miles of the zip (None when it
    can't be asked)."""
    with _locks_lock:
        lock = _nearby_locks.setdefault(zip_code, threading.Lock())
    with lock:
        hit = _nearby.get(zip_code)
        if hit and time.monotonic() - hit[1] < NEARBY_SECONDS:
            return hit[0]
        try:
            with httpx.Client(timeout=10.0) as client:
                found = bool(Kroger(client).stores_near(zip_code, miles=15, limit=1))
        except (httpx.HTTPError, RuntimeError, ValueError, KeyError) as exc:
            # ValueError: Kroger answered with something that isn't JSON;
            # KeyError: JSON without what we expected (no access token).
            log.warning("couldn't check stores near %s: %s", zip_code, exc)
            return None
        _nearby[zip_code] = (found, time.monotonic())
        return found


async def no_store(user_id: str) -> dict[str, Any]:
    """Why the week isn't priced from a store, for the plan page to say:
    "unavailable" (the user's store didn't answer), "none_nearby" (no
    Kroger-family store near their zip code), "not_chosen", or "unknown"
    when it can't be told (the cost stands either way)."""
    unknown = {"store_status": "unknown", "home_zip": None}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await _rest(
                client,
                "user_stores",
                {"select": "store_id", "user_id": f"eq.{user_id}", "is_primary": "is.true"},
            )
            if resp.status_code != 200:
                return unknown
            if resp.json():
                return {"store_status": "unavailable", "home_zip": None}
            resp = await _rest(
                client, "profiles", {"select": "home_zip", "user_id": f"eq.{user_id}"}
            )
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("couldn't tell why there's no store: %s", exc)
        return unknown
    if resp.status_code != 200:
        return unknown
    rows = resp.json()
    zip_code = rows[0].get("home_zip") if rows else None
    if (
        zip_code
        and settings.kroger_client_id
        and await asyncio.to_thread(_has_store_near, zip_code) is False
    ):
        return {"store_status": "none_nearby", "home_zip": zip_code}
    return {"store_status": "not_chosen", "home_zip": zip_code}


def _size(p: Product, info: dict[str, Any]) -> tuple[float, str, float | None] | None:
    """What one of the product holds, and how many of our own packages that is
    (None when it isn't counted in them).

    Kroger sells a bunch of scallions or cilantro, or a head of garlic, as
    "1 each", and two bunches as "2 pk". In Sous an "each" of scallion is one
    stalk, so a count of the product for an ingredient bought by its own unit
    (a bunch, a head) is that many of those, priced by their weight: 1 bunch of
    scallions = 100 g, 2 bunches = 200 g."""
    if p.sold_by == "WEIGHT":
        return 1.0, "lb", None  # Kroger prices weighed items per pound
    size = parse_size(p.size)
    if size is None:
        return None
    own = info.get("units") or {}
    unit = info.get("package_unit")
    if size[1] == "each" and unit in own and info.get("package_quantity"):
        packages = size[0] * float(info["package_quantity"])
        return packages * float(own[unit]), "g", packages
    return size[0], size[1], None


def _quotes(
    ingredient_id: str, p: Product, info: dict[str, Any], store_id: str, now: datetime
) -> list[dict[str, Any]]:
    """Price rows like the prices table's, for this request only. A promo is
    its own row, valid until the sale ends; the regular price applies after."""
    size = _size(p, info)
    if size is None:
        return []
    quantity, unit, _ = size
    row = {
        "ingredient_id": ingredient_id,
        "source": "store_api",
        "quantity": quantity,
        "unit": unit,
        "store_id": store_id,
        "observed_at": now.isoformat(),
    }
    rows = []
    if p.promo and p.promo_ends:
        rows.append(
            {
                **row,
                "price_cents": round(p.promo * 100),
                "valid_to": p.promo_ends.isoformat(),
                "on_sale": True,
            }
        )
    if p.regular:
        rows.append({**row, "price_cents": round(p.regular * 100)})
    return rows


def _package(p: Product, info: dict[str, Any]) -> dict[str, Any]:
    """How the product is really sold, in place of our packaging.csv guess."""
    if p.sold_by == "WEIGHT":
        return {"sold_by": "loose", "package_quantity": None, "package_unit": None}
    size = _size(p, info)
    if size is None:
        return {}
    if size[2] is not None:  # counted in our own unit: 2 bunches
        return {
            "sold_by": "package",
            "package_quantity": size[2],
            "package_unit": info["package_unit"],
        }
    return {"sold_by": "package", "package_quantity": size[0], "package_unit": size[1]}


async def add_live_prices(user_id: str, inputs: dict[str, Any]) -> str | None:
    """Add today's store prices and package sizes to `inputs`, in place.
    Returns the store's id when it did, so the cost prefers its prices."""
    if not settings.kroger_client_id or not inputs.get("ingredients"):
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            store = await _store(client, user_id)
            if store is None:
                return None
            ids = ",".join(inputs["ingredients"])
            # Stores of one chain carry the same products, so a match made at
            # any of them serves (TYL-19); one made at this store comes first.
            resp = await _rest(
                client,
                "kroger_product_matches",
                {
                    "select": "ingredient_id,product_id,store_id,stores!inner(chain_slug)",
                    "stores.chain_slug": f"eq.{store['chain_slug']}",
                    "ingredient_id": f"in.({ids})",
                },
            )
            resp.raise_for_status()
            rows = sorted(resp.json(), key=lambda m: m["store_id"] != store["id"])
            chosen: dict[str, str] = {}
            for m in rows:
                chosen.setdefault(m["ingredient_id"], m["product_id"])
            # Two ingredients can be bought as one product; each gets its price.
            matches: dict[str, list[str]] = {}
            for ingredient, product in chosen.items():
                matches.setdefault(product, []).append(ingredient)
        if not matches:
            return None
        products = await asyncio.to_thread(_fetch, list(matches), store["external_location_id"])
    except (httpx.HTTPError, RuntimeError, KeyError, ValueError) as exc:
        log.warning("live prices unavailable, using estimates: %s", exc)
        return None

    now = datetime.now(UTC)
    for p in products:
        # Not on this store's shelf (a chain-wide match it doesn't carry):
        # leave it to the estimates.
        if not p.regular or not p.in_store:
            continue
        for ingredient_id in matches.get(p.product_id, []):
            info = inputs["ingredients"][ingredient_id]
            rows = _quotes(ingredient_id, p, info, store["id"], now)
            if not rows:
                continue
            inputs.setdefault("prices", []).extend(rows)
            info.update(_package(p, info))
    inputs["store_name"] = store["name"]
    return str(store["id"])


def _fetch(product_ids: list[str], location_id: str) -> list[Product]:
    with httpx.Client(timeout=10.0) as client:
        return Kroger(client).products(product_ids, location_id)
