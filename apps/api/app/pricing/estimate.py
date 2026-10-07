"""Pick the best known price for an ingredient and estimate what a quantity costs.

Lookup order (TYL-13, TYL-28): the user's own price, then a live store price,
then a current deal, then a baseline estimate (BLS/USDA), then a hand seed.
"""

from dataclasses import dataclass
from datetime import date, datetime

from app.pricing.units import UnknownUnitError, convert

SOURCE_RANK = {
    "user": 0,
    "store_api": 1,
    "deal": 2,
    "baseline_bls": 3,
    "baseline_usda": 3,
    "seed": 4,
}
ESTIMATE_SOURCES = frozenset({"baseline_bls", "baseline_usda", "seed"})


@dataclass(frozen=True)
class PriceQuote:
    """One row of the prices table: price_cents buys `quantity` of `unit`."""

    source: str
    price_cents: int
    quantity: float
    unit: str
    store_id: str | None = None
    valid_from: date | None = None
    valid_to: date | None = None
    observed_at: datetime | None = None

    def is_valid_on(self, day: date) -> bool:
        if self.valid_from and day < self.valid_from:
            return False
        return not (self.valid_to and day > self.valid_to)


@dataclass(frozen=True)
class Ingredient:
    grams_per_cup: float | None = None
    grams_per_each: float | None = None


@dataclass(frozen=True)
class Estimate:
    cents: int
    quote: PriceQuote

    @property
    def is_estimate(self) -> bool:
        """True when the price is a baseline guess, so the UI shows "~$4"."""
        return self.quote.source in ESTIMATE_SOURCES


def _sort_key(quote: PriceQuote, store_id: str | None) -> tuple[int, int, float]:
    same_store = 0 if store_id is not None and quote.store_id == store_id else 1
    newest_first = -quote.observed_at.timestamp() if quote.observed_at else 0.0
    return (SOURCE_RANK.get(quote.source, 99), same_store, newest_first)


def estimate_cost(
    quantity: float,
    unit: str,
    quotes: list[PriceQuote],
    *,
    ingredient: Ingredient,
    store_id: str | None,
    on: date,
) -> Estimate | None:
    """Estimate the cost of `quantity` `unit` of an ingredient at a store.

    Prices tied to a different store are ignored; prices with no store (baselines,
    or a user's "anywhere" price) apply everywhere. Quotes whose unit can't be
    converted to the requested unit are skipped. The cost is prorated; rounding up
    to whole packages belongs to the shopping list.
    """
    usable = [
        q for q in quotes if q.is_valid_on(on) and (q.store_id is None or q.store_id == store_id)
    ]
    for quote in sorted(usable, key=lambda q: _sort_key(q, store_id)):
        try:
            covered = convert(
                quote.quantity,
                quote.unit,
                unit,
                grams_per_cup=ingredient.grams_per_cup,
                grams_per_each=ingredient.grams_per_each,
            )
        except UnknownUnitError:
            continue
        if not covered:
            continue
        return Estimate(cents=round(quote.price_cents * quantity / covered), quote=quote)
    return None
