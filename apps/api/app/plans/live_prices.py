"""Today's Harris Teeter prices for a plan, fetched live (TYL-80).

Kroger's terms don't allow keeping their prices or product details, so they're
added to this request's cost inputs and never stored. Sous stores only which
product it buys for each ingredient (kroger_product_matches, written by
scripts/match_kroger.py). Anything going wrong here falls back to the
estimates: a plan never fails to price because Kroger is down.
"""

import asyncio
import logging
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
    """The user's primary store if it has live prices, else the default one."""
    select = "id,name,external_location_id,store_chains!inner(price_source)"
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
    if rows:
        store: dict[str, Any] = rows[0]["stores"]
        return store
    if not settings.kroger_default_location_id:
        return None
    resp = await _rest(
        client,
        "stores",
        {"select": select, "external_location_id": f"eq.{settings.kroger_default_location_id}"},
    )
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else None


def _size(p: Product, info: dict[str, Any]) -> tuple[float, str, bool] | None:
    """What one of the product holds, and whether it's our own package.

    Kroger sells a bunch of scallions or cilantro, or a head of garlic, as
    "1 each". In Sous an "each" of scallion is one stalk, so a product of one
    "each" for an ingredient bought by its own unit (a bunch, a head) is one of
    those, priced by its weight: 1 bunch of scallions = 100 g."""
    if p.sold_by == "WEIGHT":
        return 1.0, "lb", False  # Kroger prices weighed items per pound
    size = parse_size(p.size)
    if size is None:
        return None
    own = info.get("units") or {}
    unit = info.get("package_unit")
    if size == (1.0, "each") and unit in own and info.get("package_quantity"):
        return float(info["package_quantity"]) * float(own[unit]), "g", True
    return size[0], size[1], False


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
    if size is None or size[2]:
        return {}  # unknown, or already our own package (a bunch)
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
            resp = await _rest(
                client,
                "kroger_product_matches",
                {
                    "select": "ingredient_id,product_id",
                    "store_id": f"eq.{store['id']}",
                    "ingredient_id": f"in.({ids})",
                },
            )
            resp.raise_for_status()
            matches = {m["product_id"]: m["ingredient_id"] for m in resp.json()}
        if not matches:
            return None
        products = await asyncio.to_thread(_fetch, list(matches), store["external_location_id"])
    except (httpx.HTTPError, RuntimeError, KeyError, ValueError) as exc:
        log.warning("live prices unavailable, using estimates: %s", exc)
        return None

    now = datetime.now(UTC)
    for p in products:
        ingredient_id = matches.get(p.product_id)
        if ingredient_id is None or not p.regular:
            continue
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
