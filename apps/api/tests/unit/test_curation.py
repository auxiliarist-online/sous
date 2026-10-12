"""The catalog's exclusion rules (data/catalog_exclusions.csv)."""

import pytest

from app.recipes.curation import excluded
from app.recipes.extract import Ingredient, RecipeDraft


def draft(title: str, *lines: str) -> RecipeDraft:
    return RecipeDraft(
        source_url="https://en.wikibooks.org/wiki/Cookbook:X",
        domain="en.wikibooks.org",
        site_name=None,
        title=title,
        ingredients=[Ingredient(n, line) for n, line in enumerate(lines)],
    )


@pytest.mark.parametrize(
    ("recipe", "reason"),
    [
        (draft("Placenta with Broccoli", "1/3 cup chopped fresh human placenta"), "human placenta"),
        (draft("Spicy Noodles", "250 g fresh human placenta"), "human placenta"),
        (draft("Dog Biscuits", "2 cups flour"), "pet food"),
        (draft("Grilled Dog", "1 medium dog, humanely slaughtered"), "dog meat"),
        (draft("Pezzetti di Cavallo (Italian Horse and Tomato)", "1 kg horse meat"), "horse meat"),
        (draft("Green Turtle Soup", "1 green turtle"), "endangered species"),
    ],
)
def test_leaves_out_what_doesnt_belong(recipe: RecipeDraft, reason: str) -> None:
    assert excluded(recipe) == reason


@pytest.mark.parametrize(
    "recipe",
    [
        draft("Corn Dogs", "8 hot dogs"),
        draft("Angels on Horseback (Bacon-wrapped Oysters)", "12 oysters"),
        draft("Liver and Onions", "1 lb calf liver"),
        draft("Dinuguan (Pork Blood Stew)", "1½ cups pork blood"),
        draft("Steak with Horseradish", "2 tbsp horseradish"),
        draft("Mock Turtle Soup", "1 lb beef"),
    ],
)
def test_keeps_ordinary_and_regional_dishes(recipe: RecipeDraft) -> None:
    assert excluded(recipe) is None
