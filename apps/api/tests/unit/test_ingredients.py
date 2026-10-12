"""Ingredient line parsing (TYL-9). Lines are written for Sous in the usual
recipe style; no real blog content (docs/policies/recipe-sources.md)."""

import pytest

from app.recipes import ingredients
from app.recipes.ingredients import CONFIDENT, candidates, parse_line

# line -> (name, quantity, quantity_max, unit)
LINES = [
    ("2 cups all-purpose flour", ("all-purpose flour", 2.0, None, "cup")),
    ("1 1/2 cups whole milk", ("whole milk", 1.5, None, "cup")),
    ("3/4 cup granulated sugar", ("granulated sugar", 0.75, None, "cup")),
    ("2 large eggs, beaten", ("eggs", 2.0, None, "each")),
    ("1/2 teaspoon baking soda", ("baking soda", 0.5, None, "tsp")),
    ("1 tablespoon olive oil", ("olive oil", 1.0, None, "tbsp")),
    ("2 tbsp unsalted butter, melted", ("unsalted butter", 2.0, None, "tbsp")),
    ("1 medium yellow onion, finely chopped", ("yellow onion", 1.0, None, "each")),
    ("4 cloves garlic, minced", ("garlic", 4.0, None, "clove")),
    ("1 can coconut milk", ("coconut milk", 1.0, None, "can")),
    ("1 lb ground beef", ("ground beef", 1.0, None, "lb")),
    ("8 oz cremini mushrooms, sliced", ("cremini mushrooms", 8.0, None, "oz")),
    ("500 g dried pasta", ("dried pasta", 500.0, None, "g")),
    ("250ml vegetable stock", ("vegetable stock", 250.0, None, "ml")),
    ("1 cup basmati rice, rinsed", ("basmati rice", 1.0, None, "cup")),
    ("1 bunch cilantro, chopped", ("cilantro", 1.0, None, "bunch")),
    ("3 green onions, thinly sliced", ("green onions", 3.0, None, "each")),
    ("1 red bell pepper, diced", ("red bell pepper", 1.0, None, "each")),
    ("juice of 2 limes", ("limes", 2.0, None, "each")),
    ("1-2 tablespoons sriracha", ("sriracha", 1.0, 2.0, "tbsp")),
    ("2 to 3 cups water", ("water", 2.0, 3.0, "cup")),
    ("4 oz feta cheese, crumbled", ("feta cheese", 4.0, None, "oz")),
    ("1 block extra-firm tofu, pressed and cubed", ("extra-firm tofu", 1.0, None, "block")),
    ("1 cup red lentils", ("red lentils", 1.0, None, "cup")),
    ("1 tsp ground cumin", ("ground cumin", 1.0, None, "tsp")),
    ("pinch of red pepper flakes", ("red pepper flakes", 1.0, None, "pinch")),
    ("2 sprigs fresh thyme", ("fresh thyme", 2.0, None, "sprig")),
    ("1 head cauliflower, cut into florets", ("cauliflower", 1.0, None, "head")),
    ("1 small head broccoli", ("broccoli", 1.0, None, "head")),
    ("1 pint cherry tomatoes, halved", ("cherry tomatoes", 1.0, None, "pint")),
    ("1/3 cup raisins", ("raisins", 0.3333, None, "cup")),
    ("2 slices bacon, chopped", ("bacon", 2.0, None, "slice")),
    ("1 quart vegetable broth", ("vegetable broth", 1.0, None, "quart")),
    ("1 lb spaghetti", ("spaghetti", 1.0, None, "lb")),
    ("2 celery stalks, diced", ("celery", 2.0, None, "stalk")),
    ("8 oz tempeh, sliced", ("tempeh", 8.0, None, "oz")),
    ("kosher salt", ("kosher salt", None, None, None)),
    ("freshly ground black pepper", ("black pepper", None, None, None)),
]


@pytest.mark.parametrize(("line", "expected"), LINES, ids=[line for line, _ in LINES])
def test_reads_the_amount_unit_and_name(line: str, expected: tuple[object, ...]) -> None:
    (row,) = parse_line(3, line)
    assert (row.name, row.quantity, row.quantity_max, row.unit) == expected
    assert (row.line_no, row.option_no, row.raw_text) == (3, 1, line)


class TestAmounts:
    def test_a_can_size_becomes_the_amount(self) -> None:
        (row,) = parse_line(0, "2 (15 oz) cans black beans, drained and rinsed")
        assert (row.quantity, row.unit, row.note) == (30.0, "oz", "2 cans")
        assert row.preparation == "drained and rinsed"
        assert row.candidates[0] == "canned black beans"

    def test_pounds_and_ounces_add_up(self) -> None:
        (row,) = parse_line(0, "1 lb 4 oz pork chops")
        assert (row.quantity, row.quantity_max, row.unit, row.note) == (
            1.25,
            None,
            "lb",
            "1 lb 4 oz",
        )

    def test_about_is_noted(self) -> None:
        (row,) = parse_line(0, "about 1 cup grated parmesan")
        assert (row.name, row.quantity, row.note) == ("parmesan", 1.0, "about")


class TestLines:
    def test_or_gives_alternatives_on_the_same_line(self) -> None:
        rows = parse_line(5, "2 cups rice or quinoa")
        assert [(r.line_no, r.option_no, r.name) for r in rows] == [
            (5, 1, "rice"),
            (5, 2, "quinoa"),
        ]
        assert all(r.quantity == 2.0 and r.unit == "cup" for r in rows)

    def test_an_unsure_alternative_is_flagged(self) -> None:
        main, alt = parse_line(0, "1 tbsp fish sauce (or soy sauce)")
        assert (main.name, alt.name) == ("fish sauce", "soy sauce")
        assert alt.parse_confidence is not None
        assert alt.needs_review == (alt.parse_confidence < CONFIDENT)

    def test_and_keeps_one_ingredient_and_asks_for_review(self) -> None:
        (row,) = parse_line(0, "salt and pepper, to taste")
        assert ((row.name or "").lower(), row.note, row.needs_review) == (
            "salt and pepper",
            "to taste",
            True,
        )

    def test_optional_is_flagged(self) -> None:
        (row,) = parse_line(0, "1/4 cup chopped fresh basil, optional")
        assert (row.name, row.is_optional, row.preparation) == ("fresh basil", True, "chopped")

    def test_a_heading_is_kept_without_a_name(self) -> None:
        (row,) = parse_line(0, "For the dressing:", "Dressing")
        assert (row.name, row.quantity, row.section, row.needs_review) == (
            None,
            None,
            "Dressing",
            False,
        )

    @pytest.mark.parametrize("bullet", ["\u25a2 ", "\u2610 ", "\u2022 ", "- ", "* "])
    def test_leading_checkboxes_and_bullets_are_dropped(self, bullet: str) -> None:
        (row,) = parse_line(0, f"{bullet}1/2 teaspoon sea salt")
        assert (row.raw_text, row.name, row.needs_review) == (
            "1/2 teaspoon sea salt",
            "sea salt",
            False,
        )

    def test_blank_lines_are_dropped(self) -> None:
        assert parse_line(0, "   ") == []

    @pytest.mark.parametrize(
        ("line", "qty", "unit"),
        [
            ("1 cup + 2 Tablespoons (200 g + 25 g) granulated sugar", 1.125, "cup"),
            ("1 cup plus 2 tablespoons flour", 1.125, "cup"),
            ("2 cups and 3 tablespoons milk", 2.1875, "cup"),
            ("1 lb 4 oz ground beef", 1.25, "lb"),
        ],
    )
    def test_compound_amounts_add_up_with_the_unit_table(
        self, line: str, qty: float, unit: str
    ) -> None:
        (row,) = parse_line(0, line)
        assert (row.quantity, row.unit) == (qty, unit)
        assert row.note  # the amount as written

    @pytest.mark.parametrize(
        ("line", "unit"),
        [
            ("a pinch of salt", "pinch"),
            ("2 dashes hot sauce", "dash"),
            ("1 stick butter", "stick"),
            ("1/2 bunch cilantro", "bunch"),
            ("2 sprigs thyme", "sprig"),
            ("3 cloves garlic", "clove"),
        ],
    )
    def test_kitchen_units(self, line: str, unit: str) -> None:
        assert parse_line(0, line)[0].unit == unit

    def test_a_line_the_parser_cant_read_is_kept_for_review(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def broken(text: str) -> None:
            raise TypeError("Incompatible quantity <Fraction> and unit <str>")

        monkeypatch.setattr(ingredients, "_parser", lambda: broken)
        (row,) = parse_line(3, "1 cup sugar")
        assert (row.raw_text, row.name, row.quantity, row.needs_review) == (
            "1 cup sugar",
            None,
            None,
            True,
        )

    def test_payload_has_every_column(self) -> None:
        (row,) = parse_line(0, "1 cup rolled oats")
        assert set(row.payload()) >= {
            "line_no", "option_no", "raw_text", "section", "name", "candidates", "quantity",
            "quantity_max", "unit", "preparation", "note", "is_optional", "parse_confidence",
            "needs_review",
        }  # fmt: skip


class TestCandidates:
    def test_drops_descriptors_one_at_a_time(self) -> None:
        assert candidates("Large Ripe Avocados") == [
            "large ripe avocados",
            "large ripe avocado",
            "ripe avocados",
            "ripe avocado",
            "avocados",
            "avocado",
        ]

    def test_keeps_the_full_name_first(self) -> None:
        assert candidates("ground cumin")[:3] == ["ground cumin", "ground cumins", "cumin"]

    def test_tries_canned_first_for_cans(self) -> None:
        assert candidates("chickpeas", canned=True)[:2] == ["canned chickpeas", "chickpeas"]

    def test_plain_ascii_and_no_trailing_detail(self) -> None:
        assert candidates("Jalapeños")[:2] == ["jalapenos", "jalapeno"]
        assert candidates("coconut milk, full fat")[0] == "coconut milk"

    @pytest.mark.parametrize(
        ("name", "form"),
        [("berries", "berry"), ("tomatoes", "tomato"), ("onion", "onions"), ("mango", "mangoes")],
    )
    def test_singular_and_plural(self, name: str, form: str) -> None:
        assert form in candidates(name)
