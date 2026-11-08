"""Package sizes for an item the user typed on the list (TYL-142).

"Eggs" typed on the list: which sizes the user's store sells it in, at
today's prices (6 ct $2.19, 12 ct $3.49, 18 ct $4.99), so they pick one
instead of guessing an amount. Looked up live and never stored: only the
product id the user picks is kept on the list item (Kroger's terms, §5e.1).
"""

import asyncio
from dataclasses import dataclass
from datetime import date
from typing import Any

import httpx2 as httpx

from app.config import settings
from app.plans.live_prices import _fetch, _rest, _store
from app.plans.own_items import candidates_for
from app.plans.store import match_ingredient
from app.pricing.kroger import Kroger, Product
from app.pricing.kroger_match import candidates, parse_size, search_term

MAX_SIZES = 6


@dataclass
class SizeOption:
    """One size the store sells, as its cheapest product of that size."""

    product_id: str
    # Kroger's size, as they write it ("12 ct"); shown, never stored.
    size: str
    cents: int
    on_sale: bool
    # The product Sous prices the item as when the user hasn't picked one.
    default: bool = False


def price_cents(p: Product, today: date) -> tuple[int, bool] | None:
    """Today's price in cents, and whether it's a sale price."""
    if p.promo and p.promo_ends and p.promo_ends >= today:
        return round(p.promo * 100), True
    if p.regular:
        return round(p.regular * 100), False
    return None


def size_options(
    name: str,
    products: list[Product],
    *,
    aisle: str | None,
    default_id: str | None,
    today: date,
) -> list[SizeOption]:
    """The distinct package sizes among the products that are this
    ingredient, in one unit, smallest first, each as its cheapest product (or
    the one Sous buys by default, for its size). Products sold by weight have
    no sizes to pick and are left out."""
    groups: dict[tuple[float, str], list[Product]] = {}
    for p in candidates(name, products, [], aisle):
        if p.sold_by == "WEIGHT" or price_cents(p, today) is None:
            continue
        size = parse_size(p.size)
        if size is None:
            continue
        groups.setdefault(size, []).append(p)
    # One kind of size: the default product's unit, or the most common one
    # (eggs in counts, without the "6 ct / 12 oz" egg bites).
    units = [u for (_, u), g in groups.items() for _ in g]
    default_unit = next(
        (u for (_, u), g in groups.items() if any(p.product_id == default_id for p in g)), None
    )
    unit = default_unit or (max(set(units), key=units.count) if units else None)
    groups = {k: g for k, g in groups.items() if k[1] == unit}
    out = []
    for size in sorted(groups, key=lambda s: s[0]):
        group = groups[size]
        pick = next((p for p in group if p.product_id == default_id), None)
        pick = pick or min(group, key=lambda p: price_cents(p, today) or 0)
        cents, on_sale = price_cents(pick, today) or (0, False)
        out.append(
            SizeOption(
                product_id=pick.product_id,
                size=pick.size or "",
                cents=cents,
                on_sale=on_sale,
                default=pick.product_id == default_id,
            )
        )
    if len(out) > MAX_SIZES:
        # Keep the default, then the smallest of the rest, in size order.
        default = [o for o in out if o.default]
        rest = [o for o in out if not o.default][: MAX_SIZES - len(default)]
        out = sorted(default + rest, key=out.index)
    return out


def _search(term: str, location_id: str) -> list[Product]:
    """Kroger's products for a search term at a store."""
    with httpx.Client(timeout=10.0) as client:
        return Kroger(client).search(term, location_id, limit=30)


async def item_sizes(user_id: str, name: str, today: date) -> dict[str, Any]:
    """The sizes a typed item comes in at the user's store. Empty when it
    matches no ingredient, there's no store with live prices, or Kroger
    can't be reached: the list just doesn't offer sizes."""
    empty: dict[str, Any] = {"ingredient_id": None, "sizes": []}
    if not settings.kroger_client_id:
        return empty
    ingredient_id = await match_ingredient(candidates_for(name))
    if not ingredient_id:
        return empty
    async with httpx.AsyncClient(timeout=10.0) as client:
        store = await _store(client, user_id)
        if store is None:
            return {**empty, "ingredient_id": ingredient_id}
        found = await _rest(
            client, "ingredients", {"select": "name,aisle,buy_as", "id": f"eq.{ingredient_id}"}
        )
        found.raise_for_status()
        rows = found.json()
        if not rows:
            return empty
        info = rows[0]
        # Bought as another (egg yolks are bought as eggs): offer its sizes.
        if info.get("buy_as"):
            ingredient_id = str(info["buy_as"])
            found = await _rest(
                client, "ingredients", {"select": "name,aisle", "id": f"eq.{ingredient_id}"}
            )
            found.raise_for_status()
            info = (found.json() or [info])[0]
        match = await _rest(
            client,
            "kroger_product_matches",
            {
                "select": "product_id,store_id,stores!inner(chain_slug)",
                "stores.chain_slug": f"eq.{store['chain_slug']}",
                "ingredient_id": f"eq.{ingredient_id}",
            },
        )
        match.raise_for_status()
        # A match made at this store first, as live pricing picks it.
        matches = sorted(match.json(), key=lambda m: m["store_id"] != store["id"])
        default_id = matches[0]["product_id"] if matches else None
    try:
        products = await asyncio.to_thread(
            _search, search_term(info["name"]), store["external_location_id"]
        )
    except (httpx.HTTPError, RuntimeError):
        return {**empty, "ingredient_id": ingredient_id}
    options = size_options(
        info["name"], products, aisle=info.get("aisle"), default_id=default_id, today=today
    )
    return {"ingredient_id": ingredient_id, "sizes": options}


async def picked_prices(
    user_id: str, product_ids: list[str], today: date
) -> dict[str, tuple[int, bool]]:
    """Today's price of each product the user picked a size as, at their
    store: product id -> (cents, on sale). Missing when it can't be priced
    (no store, not carried, Kroger down): the item falls back to the default."""
    if not product_ids or not settings.kroger_client_id:
        return {}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            store = await _store(client, user_id)
        if store is None:
            return {}
        products = await asyncio.to_thread(
            _fetch, sorted(set(product_ids)), store["external_location_id"]
        )
    except (httpx.HTTPError, RuntimeError):
        # The store or Kroger can't be reached: picked items use the default.
        return {}
    out = {}
    for p in products:
        price = price_cents(p, today) if p.in_store else None
        if price is not None:
            out[p.product_id] = price
    return out
