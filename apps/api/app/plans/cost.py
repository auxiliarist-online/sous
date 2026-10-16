"""What a week's meal plan costs to buy (TYL-15, TYL-18).

Each ingredient is added up across the week's recipes (each at half, full or
double size), then bought the way it's sold:

* package: whole packages, rounded up (two recipes needing 1 and 1½ cups of
  rice buy one 2 lb bag; "salt to taste" buys one container if needed);
* loose: just the amount needed (carrots by the pound, meat from the counter).

The user's pantry decides what's already on hand: only what they've marked
"have" is left off (TYL-88). Nothing is assumed, staples included, so the
list never quietly skips something the user doesn't have.

Each recipe's share of the week (TYL-30) splits every item's cost among the
recipes that use it, by how much each uses, so the shares add up to the total.
What a recipe would add (added_costs) is the week's total with it minus
without it: a recipe that uses up the rest of a bag of rice adds little.
"""

import math
from dataclasses import dataclass, field, replace
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
    # Where the price came from (TYL-61): the user's own, the store's, or a
    # rough estimate.
    price_source: Literal["user", "store", "estimate"] | None = None
    on_sale: bool = False
    # For a sale price: its last day, and what it would cost after.
    sale_ends: date | None = None
    regular_cents: int | None = None


@dataclass
class EntryCost:
    """One planned recipe's share of the week's cost (TYL-30)."""

    entry_id: str
    cents: int


@dataclass
class PlanCost:
    """A week's buy list and cost against the budget, with each planned
    recipe's share and the store whose prices were used."""

    budget_cents: int | None
    total_cents: int
    # True when any price is a baseline guess rather than a real store price.
    estimated: bool
    # Items to buy that have no price yet.
    unpriced: int
    items: list[Item] = field(default_factory=list)
    # The store whose live prices were used ("Prices from Harris Teeter"),
    # and its id, for saving the user's own price there (TYL-34).
    store_name: str | None = None
    store_id: str | None = None
    entries: list[EntryCost] = field(default_factory=list)


@dataclass
class AddedCost:
    """What adding a recipe at full size would add to the week (TYL-30)."""

    recipe_id: str
    cents: int
    # True when it brings items with no price, so it would add more than this.
    unpriced: bool
    estimated: bool


SOURCES: dict[str, Literal["user", "store", "estimate"]] = {
    "user": "user",
    "store_api": "store",
    "deal": "store",
}


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
        on_sale=bool(row.get("on_sale")),
    )


def _float(value: Any) -> float | None:
    return float(value) if value not in (None, "") else None


def _convert(
    qty: float, unit: str, to: str, conv: Ingredient, units: dict[str, float] | None = None
) -> float | None:
    """Convert between units for one ingredient. Its own units (a clove of
    garlic, a bunch of cilantro: ingredient_units) go through grams; standard
    ones use app/pricing/units.py."""
    own = units or {}
    try:
        if unit in own:
            qty, unit = qty * own[unit], "g"
        if to in own:
            grams = convert(
                qty, unit, "g", grams_per_cup=conv.grams_per_cup, grams_per_each=conv.grams_per_each
            )
            return grams / own[to] if grams is not None else None
        return convert(
            qty, unit, to, grams_per_cup=conv.grams_per_cup, grams_per_each=conv.grams_per_each
        )
    except UnknownUnitError:
        return None


def _bought_as(
    line: dict[str, Any],
    ingredient_id: str,
    info: dict[str, dict[str, Any]],
    conversions: dict[str, Ingredient],
    own_units: dict[str, dict[str, float]],
    scale: float,
) -> dict[str, Any]:
    """A line for an ingredient that's bought as another (egg yolks are bought
    as eggs) becomes a line for what's bought, in grams: 5 yolks -> 5 x 17 g
    of yolk x 2.94 = 250 g of eggs, which the eggs item turns into 5 eggs."""
    source = info[ingredient_id].get("buy_as")
    ratio = _float(info[ingredient_id].get("buy_ratio"))
    if not source or source not in info or not ratio:
        return line
    quantity = _float(line.get("quantity"))
    if quantity is None:
        return {**line, "ingredient_id": source}
    grams = _convert(
        quantity * scale,
        line.get("unit") or "each",
        "g",
        conversions[ingredient_id],
        own_units.get(ingredient_id),
    )
    if grams is None:
        return {**line, "ingredient_id": source, "quantity": None}
    return {**line, "ingredient_id": source, "quantity": grams * ratio, "unit": "g", "scaled": True}


def _shares(cents: int, used: dict[str, float | None]) -> dict[str, int]:
    """Split an item's cost among the entries that use it: by how much each
    uses when every amount is known, else evenly. Whole cents that add up."""
    known = all(q is not None for q in used.values()) and sum(q or 0 for q in used.values()) > 0
    weights = {e: (q or 0.0) if known else 1.0 for e, q in used.items()}
    total = sum(weights.values())
    exact = {e: cents * w / total for e, w in weights.items()}
    out = {e: math.floor(x) for e, x in exact.items()}
    # Hand the leftover cents to the largest remainders.
    for e in sorted(exact, key=lambda e: exact[e] - out[e], reverse=True)[
        : cents - sum(out.values())
    ]:
        out[e] += 1
    return out


def plan_cost(inputs: dict[str, Any], *, on: date, store_id: str | None = None) -> PlanCost:
    """`inputs` is what plan_cost_inputs() returns. Candidate entries (recipes
    the user might add) are left out; added_costs() prices them."""
    info: dict[str, dict[str, Any]] = inputs.get("ingredients", {})
    conversions = {
        id_: Ingredient(
            grams_per_cup=_float(i.get("grams_per_cup")),
            grams_per_each=_float(i.get("grams_per_each")),
        )
        for id_, i in info.items()
    }
    own_units: dict[str, dict[str, float]] = {
        id_: {u: float(g) for u, g in (i.get("units") or {}).items()} for id_, i in info.items()
    }
    quotes: dict[str, list[PriceQuote]] = {}
    for row in inputs.get("prices", []):
        quote = _quote(row)
        # A price per bunch (the user's own, TYL-34) is priced by weight, as
        # the list is.
        grams = own_units.get(row["ingredient_id"], {}).get(quote.unit)
        if grams:
            quote = replace(quote, quantity=quote.quantity * grams, unit="g")
        quotes.setdefault(row["ingredient_id"], []).append(quote)

    items: dict[str, Item] = {}
    # How much of each item each entry uses, in the item's unit (None when
    # that entry's amount isn't known), for splitting the cost.
    used: dict[str, dict[str, float | None]] = {}
    unmatched: list[Item] = []
    planned = [e for e in inputs.get("entries", []) if not e.get("candidate")]
    for entry in planned:
        entry_id = str(entry.get("id"))
        scale = float(entry.get("scale") or 1)
        for line in entry["lines"]:
            ingredient_id = line.get("ingredient_id")
            if not ingredient_id or ingredient_id not in info:
                unmatched.append(Item(name=line.get("raw_text") or "?", amount_unknown=True))
                continue
            line = _bought_as(line, ingredient_id, info, conversions, own_units, scale)
            ingredient_id = line["ingredient_id"]
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
            share = used.setdefault(ingredient_id, {})
            share.setdefault(entry_id, 0.0)
            quantity = _float(line.get("quantity"))
            if quantity is None:
                item.amount_unknown = True
                share[entry_id] = None
                continue
            unit = line.get("unit") or "each"
            conv, units = conversions[ingredient_id], own_units[ingredient_id]
            if item.unit is None:
                if _convert(1, unit, unit, conv, units) is None:
                    item.amount_unknown = True  # a unit we can't count, like "pinch" of a herb
                    share[entry_id] = None
                    continue
                item.unit = unit
            # Lines converted to what's bought are already at the planned size.
            factor = 1.0 if line.get("scaled") else scale
            added = _convert(quantity * factor, unit, item.unit, conv, units)
            if added is None:
                item.amount_unknown = True
                share[entry_id] = None
                continue
            item.quantity = (item.quantity or 0) + added
            if share[entry_id] is not None:
                share[entry_id] = (share[entry_id] or 0) + added

    total = 0
    estimated = False
    by_entry = {str(e.get("id")): 0 for e in planned}
    for item in items.values():
        item.buy = item.pantry != "have"
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
        units = own_units[item.ingredient_id]
        if unit in units:  # "1 bunch": price it by weight
            amount, unit = amount * units[unit], "g"
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
            item.price_source = SOURCES.get(found.quote.source, "estimate")
            item.on_sale = found.quote.on_sale
            if found.quote.on_sale:
                item.sale_ends = found.quote.valid_to
                regular = estimate_cost(
                    amount,
                    unit,
                    [q for q in quotes.get(item.ingredient_id, []) if not q.on_sale],
                    ingredient=conversions[item.ingredient_id],
                    store_id=store_id,
                    on=on,
                )
                item.regular_cents = regular.cents if regular else None
            total += found.cents
            estimated = estimated or found.is_estimate
            for entry_id, cents in _shares(found.cents, used[item.ingredient_id]).items():
                by_entry[entry_id] += cents

    listed = sorted(items.values(), key=lambda i: (i.aisle or "", i.name)) + unmatched
    return PlanCost(
        budget_cents=inputs.get("budget_cents"),
        total_cents=total,
        estimated=estimated,
        unpriced=sum(1 for i in listed if i.buy and i.cents is None),
        items=listed,
        store_name=inputs.get("store_name") if store_id else None,
        store_id=store_id,
        entries=[EntryCost(entry_id=e, cents=c) for e, c in by_entry.items()],
    )


def added_costs(
    inputs: dict[str, Any], *, on: date, store_id: str | None = None
) -> list[AddedCost]:
    """For each candidate entry in `inputs`, what adding it would add to the
    week's cost: the total with it minus the total without it."""
    planned = [e for e in inputs.get("entries", []) if not e.get("candidate")]
    base = plan_cost({**inputs, "entries": planned}, on=on, store_id=store_id)
    before = {i.ingredient_id: i.cents for i in base.items}
    out = []
    for candidate in (e for e in inputs.get("entries", []) if e.get("candidate")):
        withit = plan_cost(
            {**inputs, "entries": [*planned, {**candidate, "candidate": False}]},
            on=on,
            store_id=store_id,
        )
        changed = [
            i for i in withit.items if i.ingredient_id and i.cents != before.get(i.ingredient_id)
        ]
        out.append(
            AddedCost(
                recipe_id=str(candidate["recipe_id"]),
                cents=withit.total_cents - base.total_cents,
                unpriced=withit.unpriced > base.unpriced,
                estimated=any(i.estimated for i in changed),
            )
        )
    return out
