"""Reading USDA portions into cup and item weights (TYL-60)."""

from scripts.build_weights import per_cup, per_each


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
