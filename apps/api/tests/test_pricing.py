import csv
from datetime import date, datetime
from pathlib import Path

import pytest

from app.pricing.estimate import Ingredient, PriceQuote, estimate_cost
from app.pricing.units import UnknownUnitError, convert, normalize_unit

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
VALID_CONTAINS = {
    "meat", "pork", "poultry", "fish", "shellfish", "gelatin", "animal_rennet",
    "dairy", "egg", "honey", "gluten", "tree_nut", "peanut", "soy", "sesame", "alcohol",
}  # fmt: skip
TODAY = date(2026, 10, 6)


class TestUnits:
    def test_normalizes_written_units(self) -> None:
        assert normalize_unit("Tablespoons") == "tbsp"
        assert normalize_unit("fl oz") == "fl_oz"
        assert normalize_unit("lbs.") == "lb"

    def test_rejects_unknown_units(self) -> None:
        with pytest.raises(UnknownUnitError):
            normalize_unit("handful")

    def test_converts_within_a_dimension(self) -> None:
        assert convert(1, "lb", "oz") == pytest.approx(16, rel=1e-4)
        assert convert(1, "cup", "tbsp") == pytest.approx(16, rel=1e-4)
        assert convert(1, "dozen", "each") == 12

    def test_converts_volume_to_weight_with_density(self) -> None:
        # 2 cups of flour at 125 g/cup is 250 g.
        assert convert(2, "cup", "g", grams_per_cup=125) == pytest.approx(250)
        assert convert(250, "g", "cup", grams_per_cup=125) == pytest.approx(2)

    def test_converts_counts_with_item_weight(self) -> None:
        # One 150 g onion is about a third of a pound.
        assert convert(1, "each", "lb", grams_per_each=150) == pytest.approx(0.3307, rel=1e-3)

    def test_returns_none_without_conversion_data(self) -> None:
        assert convert(1, "cup", "lb") is None
        assert convert(1, "each", "cup", grams_per_each=50) is None


class TestEstimateCost:
    onion = Ingredient(grams_per_cup=160, grams_per_each=150)
    baseline = PriceQuote("baseline_usda", 113, 1, "lb")

    def test_prorates_a_baseline_price(self) -> None:
        estimate = estimate_cost(
            2, "lb", [self.baseline], ingredient=self.onion, store_id=None, on=TODAY
        )
        assert estimate is not None
        assert estimate.cents == 226
        assert estimate.is_estimate

    def test_converts_recipe_units(self) -> None:
        # 2 onions at 150 g each = 300 g = 0.661 lb -> 75 cents.
        estimate = estimate_cost(
            2, "each", [self.baseline], ingredient=self.onion, store_id=None, on=TODAY
        )
        assert estimate is not None
        assert estimate.cents == 75

    def test_prefers_user_then_store_then_deal_then_baseline(self) -> None:
        quotes = [
            self.baseline,
            PriceQuote("deal", 79, 1, "lb", store_id="ht", valid_to=date(2026, 10, 10)),
            PriceQuote("store_api", 99, 1, "lb", store_id="ht"),
            PriceQuote("user", 89, 1, "lb", store_id="ht"),
        ]
        sources = []
        while quotes:
            estimate = estimate_cost(
                1, "lb", quotes, ingredient=self.onion, store_id="ht", on=TODAY
            )
            assert estimate is not None
            sources.append(estimate.quote.source)
            quotes.remove(estimate.quote)
        assert sources == ["user", "store_api", "deal", "baseline_usda"]

    def test_ignores_other_stores_and_expired_deals(self) -> None:
        quotes = [
            PriceQuote("user", 50, 1, "lb", store_id="aldi"),
            PriceQuote("deal", 60, 1, "lb", store_id="ht", valid_to=date(2026, 10, 1)),
            self.baseline,
        ]
        estimate = estimate_cost(1, "lb", quotes, ingredient=self.onion, store_id="ht", on=TODAY)
        assert estimate is not None
        assert estimate.quote is self.baseline

    def test_uses_the_newest_price_from_the_same_source(self) -> None:
        old = PriceQuote("user", 100, 1, "lb", observed_at=datetime(2026, 1, 1))
        new = PriceQuote("user", 120, 1, "lb", observed_at=datetime(2026, 9, 1))
        estimate = estimate_cost(
            1, "lb", [old, new], ingredient=self.onion, store_id=None, on=TODAY
        )
        assert estimate is not None
        assert estimate.quote is new
        assert not estimate.is_estimate

    def test_skips_prices_it_cannot_convert(self) -> None:
        # A per-bunch price can't be turned into cups without an item weight.
        bunch = PriceQuote("seed", 100, 1, "each")
        estimate = estimate_cost(
            1, "cup", [bunch], ingredient=Ingredient(), store_id=None, on=TODAY
        )
        assert estimate is None


class TestBaselineData:
    with open(DATA_DIR / "baseline_prices.csv", newline="") as f:
        rows = list(csv.DictReader(f))

    def test_every_row_is_usable(self) -> None:
        assert len(self.rows) >= 100
        for r in self.rows:
            assert normalize_unit(r["unit"]) == r["unit"], r["ingredient"]
            assert int(r["price_cents"]) > 0, r["ingredient"]
            for column in ("contains", "may_contain"):
                categories = {c for c in r[column].split("|") if c}
                assert categories <= VALID_CONTAINS, r["ingredient"]

    def test_one_price_per_ingredient(self) -> None:
        names = [r["ingredient"] for r in self.rows]
        assert len(names) == len(set(names))

    def test_pork_is_also_meat(self) -> None:
        for r in self.rows:
            if "pork" in r["contains"].split("|"):
                assert "meat" in r["contains"].split("|"), r["ingredient"]

    def test_vegetarian_staples_are_covered(self) -> None:
        names = {r["ingredient"] for r in self.rows}
        for staple in (
            "onion",
            "garlic",
            "firm tofu",
            "lentils",
            "canned black beans",
            "white rice",
        ):
            assert staple in names
