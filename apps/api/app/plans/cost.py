"""Estimate what a week's meal plan costs (TYL-15), using the price lookup in
app.pricing.estimate. Each recipe is scaled to the servings planned, and each
ingredient line is priced on its own (prorated); rounding up to whole packages
and sharing a bag of rice across recipes belongs to the shopping list.
"""

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from app.pricing.estimate import Ingredient, PriceQuote, estimate_cost


@dataclass(frozen=True)
class EntryCost:
    id: str
    cents: int
    priced_lines: int
    unpriced_lines: int


@dataclass(frozen=True)
class PlanCost:
    budget_cents: int | None
    total_cents: int
    # True when any price is a baseline guess rather than a real store price.
    estimated: bool
    unpriced_lines: int
    entries: list[EntryCost]


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


def plan_cost(inputs: dict[str, Any], *, on: date, store_id: str | None = None) -> PlanCost:
    """`inputs` is what plan_cost_inputs() returns."""
    quotes: dict[str, list[PriceQuote]] = {}
    for row in inputs.get("prices", []):
        quotes.setdefault(row["ingredient_id"], []).append(_quote(row))
    ingredients = {
        id_: Ingredient(
            grams_per_cup=float(i["grams_per_cup"]) if i.get("grams_per_cup") else None,
            grams_per_each=float(i["grams_per_each"]) if i.get("grams_per_each") else None,
        )
        for id_, i in inputs.get("ingredients", {}).items()
    }

    entries: list[EntryCost] = []
    estimated = False
    for entry in inputs.get("entries", []):
        recipe_servings = entry.get("recipe_servings")
        scale = float(entry["servings"]) / float(recipe_servings) if recipe_servings else 1.0
        cents = priced = unpriced = 0
        for line in entry["lines"]:
            ingredient_id = line.get("ingredient_id")
            quantity = line.get("quantity")
            if not ingredient_id or not quantity:
                # "Salt to taste" or an unmatched ingredient: nothing to price.
                unpriced += 1
                continue
            found = estimate_cost(
                float(quantity) * scale,
                line.get("unit") or "each",
                quotes.get(ingredient_id, []),
                ingredient=ingredients.get(ingredient_id, Ingredient()),
                store_id=store_id,
                on=on,
            )
            if found is None:
                unpriced += 1
                continue
            cents += found.cents
            priced += 1
            estimated = estimated or found.is_estimate
        entries.append(EntryCost(entry["id"], cents, priced, unpriced))

    return PlanCost(
        budget_cents=inputs.get("budget_cents"),
        total_cents=sum(e.cents for e in entries),
        estimated=estimated,
        unpriced_lines=sum(e.unpriced_lines for e in entries),
        entries=entries,
    )
