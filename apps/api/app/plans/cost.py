"""What a week's meal plan costs to buy (TYL-15, TYL-18).

Each ingredient is added up across the week's recipes (each at half, full or
double size), then bought the way it's sold:

* package: whole packages, rounded up (two recipes needing 1 and 1½ cups of
  rice buy one 2 lb bag; "salt to taste" buys one container if needed);
* loose: just the amount needed (carrots by the pound, meat from the counter).

The user's pantry decides what's already on hand. Until it says otherwise,
pantry staples (salt, oil, spices) are on hand and everything else is bought.
"""

import math
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Literal

from app.pricing.estimate import Ingredient, PriceQuote, estimate_cost
from app.pricing.units import UnknownUnitError, convert

# Allow for rounding in recipe amounts: 16.2 oz of a 16 oz can is one can.
PACKAGE_SLACK = 0.02


@dataclass
class Item:
    """One thing on the week's list."""

    name: str
    ingredient_id: str | None = None
    aisle: str | None = None
    # What the recipes need, added up, when the amounts could be added.
    quantity: float | None = None
    unit: str | None = None
    # Some lines gave no amount ("salt to taste") or one that can't be added
    # to the others (cups of something sold by weight, with no density).
    amount_unknown: bool = False
    sold_by: Literal["package", "loose"] | None = None
    package_quantity: float | None = None
    package_unit: str | None = None
    packages: int | None = None
    # How much of the last package is left over, in the package's unit.
    leftover: float | None = None
    staple: bool = False
    pantry: Literal["have", "out"] | None = None
    # False when it's already on hand, so it isn't bought or counted.
    buy: bool = True
    cents: int | None = None
    estimated: bool = False


@dataclass
class PlanCost:
    budget_cents: int | None
    total_cents: int
    # True when any price is a baseline guess rather than a real store price.
    estimated: bool
    # Items to buy that have no price yet.
    unpriced: int
    items: list[Item] = field(default_factory=list)


def _date(value: str | None) -> date | None:
    return date.fromisoformat(value[:10]) if value else None


def _quote(row: dict[str, Any]) -> PriceQuote:
    observed = row.get("observed_at")
    return PriceQuote(
        source=row["source"],
        price_cents=int(row["price_cents"]),
        quantity=float(row["quantity"]),
        unit=row["unit"],
        store_id=row.get("store_id"),
        valid_from=_date(row.get("valid_from")),
        valid_to=_date(row.get("valid_to")),
        observed_at=datetime.fromisoformat(observed) if observed else None,
    )


def _float(value: Any) -> float | None:
    return float(value) if value not in (None, "") else None


def _convert(qty: float, unit: str, to: str, conv: Ingredient) -> float | None:
    try:
        return convert(
            qty, unit, to, grams_per_cup=conv.grams_per_cup, grams_per_each=conv.grams_per_each
        )
    except UnknownUnitError:
        return None


def plan_cost(inputs: dict[str, Any], *, on: date, store_id: str | None = None) -> PlanCost:
    """`inputs` is what plan_cost_inputs() returns."""
    quotes: dict[str, list[PriceQuote]] = {}
    for row in inputs.get("prices", []):
        quotes.setdefault(row["ingredient_id"], []).append(_quote(row))
    info: dict[str, dict[str, Any]] = inputs.get("ingredients", {})
    conversions = {
        id_: Ingredient(
            grams_per_cup=_float(i.get("grams_per_cup")),
            grams_per_each=_float(i.get("grams_per_each")),
        )
        for id_, i in info.items()
    }

    items: dict[str, Item] = {}
    unmatched: list[Item] = []
    for entry in inputs.get("entries", []):
        scale = float(entry.get("scale") or 1)
        for line in entry["lines"]:
            ingredient_id = line.get("ingredient_id")
            if not ingredient_id or ingredient_id not in info:
                unmatched.append(Item(name=line.get("raw_text") or "?", amount_unknown=True))
                continue
            item = items.get(ingredient_id)
            if item is None:
                i = info[ingredient_id]
                item = items[ingredient_id] = Item(
                    name=i["name"],
                    ingredient_id=ingredient_id,
                    aisle=i.get("aisle"),
                    sold_by=i.get("sold_by"),
                    package_quantity=_float(i.get("package_quantity")),
                    package_unit=i.get("package_unit"),
                    staple=bool(i.get("pantry_staple")),
                    pantry=i.get("pantry"),
                )
                if item.sold_by == "package":
                    item.unit = item.package_unit
            quantity = _float(line.get("quantity"))
            if quantity is None:
                item.amount_unknown = True
                continue
            unit = line.get("unit") or "each"
            if item.unit is None:
                if _convert(1, unit, unit, conversions[ingredient_id]) is None:
                    item.amount_unknown = True  # a unit we can't count, like "clove"
                    continue
                item.unit = unit
            added = _convert(quantity * scale, unit, item.unit, conversions[ingredient_id])
            if added is None:
                item.amount_unknown = True
                continue
            item.quantity = (item.quantity or 0) + added

    total = 0
    estimated = False
    for item in items.values():
        item.buy = item.pantry == "out" or (item.pantry is None and not item.staple)
        if item.sold_by == "package" and item.package_quantity and item.package_unit:
            needed = (item.quantity or 0) / item.package_quantity
            item.packages = max(1, math.ceil(needed - PACKAGE_SLACK))
            if item.quantity is not None:
                item.leftover = max(0.0, item.packages * item.package_quantity - item.quantity)
            amount, unit = item.packages * item.package_quantity, item.package_unit
        elif item.quantity is not None and item.unit:
            amount, unit = item.quantity, item.unit
        else:
            continue  # loose, with no amount to price
        if not item.buy or item.ingredient_id is None:
            continue
        found = estimate_cost(
            amount,
            unit,
            quotes.get(item.ingredient_id, []),
            ingredient=conversions[item.ingredient_id],
            store_id=store_id,
            on=on,
        )
        if found is not None:
            item.cents = found.cents
            item.estimated = found.is_estimate
            total += found.cents
            estimated = estimated or found.is_estimate

    listed = sorted(items.values(), key=lambda i: (i.aisle or "", i.name)) + unmatched
    return PlanCost(
        budget_cents=inputs.get("budget_cents"),
        total_cents=total,
        estimated=estimated,
        unpriced=sum(1 for i in listed if i.buy and i.cents is None),
        items=listed,
    )
