"""Prices for the items users add to the shopping list themselves (TYL-146).

"Wheat bread" or "Eggs" typed on the list is matched to an ingredient with
the same candidates as a recipe line, then priced as one package (or one, for
things sold loose), the store's live price first. Nothing is stored: the names
are matched each time, so an edited name is matched again.
"""

from dataclasses import dataclass
from datetime import date
from typing import Any

from app.plans.cost import _cost
from app.recipes.ingredients import parse_line


@dataclass
class OwnItem:
    """One list item's match and price; cents is None when it couldn't be
    matched or priced."""

    id: str
    ingredient_id: str | None = None
    cents: int | None = None
    estimated: bool = False
    on_sale: bool = False


def candidates_for(name: str) -> list[str]:
    """Names to look up for a typed list item, as for a recipe line: "2 lb
    ground beef" tries "ground beef", then "beef"."""
    parsed = parse_line(0, name)
    return parsed[0].candidates if parsed else []


def price_own_items(
    items: list[tuple[str, str | None]],
    inputs: dict[str, Any],
    *,
    on: date,
    store_id: str | None,
) -> list[OwnItem]:
    """Price (list item id, matched ingredient id) pairs against `inputs`
    (plan_cost_inputs() with the matches as extras, plus live prices). Each is
    priced on its own, as an extra purchase beside the plan's."""
    info = inputs.get("ingredients", {})
    out = []
    for item_id, ingredient_id in items:
        own = OwnItem(id=item_id, ingredient_id=ingredient_id)
        out.append(own)
        if not ingredient_id or ingredient_id not in info:
            continue
        # A package of it; one of a loose thing (an avocado), if it's counted.
        loose = info[ingredient_id].get("sold_by") != "package"
        line = {"ingredient_id": ingredient_id, "quantity": 1 if loose else None, "unit": "each"}
        entry = {"id": item_id, "scale": 1, "lines": [line]}
        cost = _cost({**inputs, "entries": [entry]}, on=on, store_id=store_id)
        priced = cost.items[0] if cost.items else None
        if priced is not None and priced.cents is not None:
            own.cents = priced.cents
            own.estimated = priced.estimated
            own.on_sale = priced.on_sale
    return out
