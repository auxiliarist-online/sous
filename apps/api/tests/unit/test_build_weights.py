"""Reading USDA portions into cup and item weights (TYL-60)."""

from scripts.build_weights import migration, per_cup, per_each


def test_a_plain_cup_comes_first() -> None:
    assert per_cup([("tbsp", 15), ("cup", 240)]) == 240


def test_a_cup_not_packed_counts_but_packed_doesnt() -> None:
    assert per_cup([("cup, packed", 165), ("cup (not packed)", 145)]) == 145


def test_spoons_fluid_ounces_and_servings_scale_to_a_cup() -> None:
    assert per_cup([("tbsp", 6)]) == 96
    assert per_cup([("fl oz", 29.4)]) == 29.4 * 8
    assert per_cup([("serving 1/2 cup", 66)]) == 132
    assert per_cup([("envelope (1 tbsp)", 7)]) == 112


def test_no_cup_from_weights_alone() -> None:
    assert per_cup([("oz", 28.35), ("package (10 oz)", 283)]) is None


def test_one_is_a_medium_one_first() -> None:
    assert per_each([("large", 150), ("medium", 123)], "") == 123


def test_one_can_be_a_portion_named_after_the_food() -> None:
    assert (
        per_each(
            [("oz", 28), ("croissant, small", 42), ("croissant, medium", 57)], "", "croissants"
        )
        == 57
    )
    assert per_each([("oz, boneless", 28), ("anchovy", 4)], "", "anchovies") == 4
    assert per_each([("tsp", 2.6), ("cube", 3.6)], "", "bouillon cubes") == 3.6


def test_a_chosen_portion_or_none() -> None:
    assert per_each([("pepper", 17)], "pepper") == 17
    assert per_each([("cup", 30)], "-", "mixed greens") is None


def test_hand_cup_and_each_weights_fill_what_usda_lacks() -> None:
    rows = [{"name": "chaat masala", "grams_per_cup": "", "grams_per_each": ""}]
    units = [
        {"ingredient": "chaat masala", "unit": "cup", "grams": "96", "source": "hand"},
        {"ingredient": "bay leaves", "unit": "each", "grams": "0.2", "source": "hand"},
        {"ingredient": "cilantro", "unit": "bunch", "grams": "60", "source": "hand"},
    ]
    sql = migration(rows, units)
    cup = sql[sql.index("-- A cup of these") : sql.index("-- Ingredient-specific units")]
    assert "('chaat masala', 96)" in cup and "grams_per_cup = coalesce" in cup
    assert "('bay leaves', 0.2)" in sql
    # A cup isn't stored as a unit of its own; a bunch is.
    units_part = sql[sql.index("-- Ingredient-specific units") :]
    assert "'cup'" not in units_part and "('cilantro', 'bunch', 60, 'hand')" in units_part


def test_a_hand_cup_weight_wins_over_usdas() -> None:
    rows = [{"name": "powdered milk", "grams_per_cup": "120.0", "grams_per_each": ""}]
    units = [{"ingredient": "powdered milk", "unit": "cup", "grams": "68", "source": "hand"}]
    sql = migration(rows, units)
    assert "120.0" not in sql
    assert "('powdered milk', 68)" in sql
