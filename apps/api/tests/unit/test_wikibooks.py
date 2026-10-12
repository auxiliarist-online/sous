"""Parsing Wikibooks Cookbook pages (synthetic wikitext, in the Cookbook's style)."""

from app.recipes.wikibooks import clean, page_url, parse

PAGE = """__NOTOC__
{{recipesummary|category=Indian recipes|servings=4|time=1 hour 15 minutes|difficulty=2
}}
{{recipe}}
Intro text about the dish.<ref>A source</ref>

== Ingredients ==
* {{convert|8|oz|g|abbr=on}} dried [[Cookbook:Chickpea|chickpeas]], soaked
* 1 [[Cookbook:Onion]], [[Cookbook:Dicing|diced]]
* '''2''' cloves [[Cookbook:Garlic|garlic]]<!-- or more -->
=== For the tempering ===
* 1 [[Cookbook:Teaspoon|tsp]] [[Cookbook:Cumin|cumin]] seeds
*

== Procedure ==
# [[Cookbook:Boiling|Boil]] the chickpeas until soft.
# Fry the onion and garlic.
#: A note under the step.
# Add the tempering. [[File:Pot.jpg|thumb]]

[[Category:Recipes using chickpea]]
[[Category:Southern U.S. recipes]]
[[Category:Indian_recipes]]
[[Category:Main course recipes]]
[[Category:Recipes for soup]]

== Notes, tips, and variations ==
* Use canned chickpeas to save time.
"""


def test_parses_ingredients_sections_steps_and_summary() -> None:
    draft = parse("Cookbook:Chana Masala", PAGE)
    assert draft is not None
    assert draft.title == "Chana Masala"
    assert draft.source_url == "https://en.wikibooks.org/wiki/Cookbook:Chana_Masala"
    assert draft.site_name == "Wikibooks Cookbook"
    assert [(i.raw_text, i.section) for i in draft.ingredients] == [
        ("8 oz dried chickpeas, soaked", None),
        ("1 Onion, diced", None),
        ("2 cloves garlic", None),
        ("1 tsp cumin seeds", "For the tempering"),
    ]
    assert draft.instructions == [
        "Boil the chickpeas until soft.",
        "Fry the onion and garlic. A note under the step.",
        "Add the tempering.",
    ]
    assert (draft.servings, draft.total_minutes, draft.cuisines) == (4, 75, ["indian", "southern"])
    assert draft.courses == ["main", "soup"]


def test_skips_pages_that_arent_usable_recipes() -> None:
    article = "Pancakes are a kind of flatbread.\n== Varieties ==\n* Crêpes\n* Blini"
    assert parse("Cookbook:Pancake", article) is None
    no_steps = "== Ingredients ==\n* 1 egg\n* 1 cup milk\n"
    assert parse("Cookbook:Batter", no_steps) is None
    one_ingredient = "== Ingredients ==\n* 1 egg\n== Procedure ==\n# Boil it."
    assert parse("Cookbook:Boiled Egg", one_ingredient) is None
    assert parse("Cookbook:Chili/Vegetarian", PAGE) is None  # subpages


def test_nested_ingredient_bullets_are_ingredients() -> None:
    page = "==Ingredients==\n* Dressing:\n** 2 tbsp oil\n** 1 tbsp vinegar\n==Procedure==\n# Mix."
    draft = parse("Cookbook:Dressing", page)
    assert draft is not None
    assert [(i.raw_text, i.section) for i in draft.ingredients] == [
        ("2 tbsp oil", "Dressing"),
        ("1 tbsp vinegar", "Dressing"),
    ]


def test_accepts_other_step_headings_and_bullets() -> None:
    page = "==Ingredients==\n* 1 egg\n* salt\n==Directions==\n* Beat.\n* Fry.\n"
    draft = parse("Cookbook:Omelette", page)
    assert draft is not None
    assert draft.instructions == ["Beat.", "Fry."]
    assert draft.servings is None and draft.total_minutes is None


def test_cleans_markup() -> None:
    assert clean("{{convert|1|-|2|cup}} [[w:Rice|rice]] [http://x.example a link]") == (
        "1–2 cup rice a link"
    )
    assert clean("a {{nested|{{inner}}}} b &nbsp;c<br/>d") == "a b c d"
    assert page_url("Cookbook:Mac and Cheese (Baked)") == (
        "https://en.wikibooks.org/wiki/Cookbook:Mac_and_Cheese_(Baked)"
    )


def test_courses_from_categories() -> None:
    page = "==Ingredients==\n* 1 egg\n* salt\n==Procedure==\n# Mix.\n"
    for category, courses in [
        ("Recipes for dessert", ["dessert"]),
        ("Sauce recipes", ["sauce"]),
        ("Side dish recipes", ["side"]),
        ("Breakfast recipes", ["breakfast"]),
        ("Beverage recipes", ["drink"]),
        ("Recipes using sugar", []),
        ("Baking recipes", []),
    ]:
        draft = parse("Cookbook:Test", page + f"[[Category:{category}]]")
        assert draft is not None and draft.courses == courses, category
