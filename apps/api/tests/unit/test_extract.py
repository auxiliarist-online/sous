import pytest

from app.recipes.extract import canonical_url, extract_recipe
from app.recipes.fetch import FetchError
from tests.helpers import RECIPE_LD, page_html


class TestExtract:
    def test_reads_the_recipe_fields_we_store(self) -> None:
        url = "https://www.example-blog.com/black-bean-tacos/?utm_source=pin"
        draft = extract_recipe(page_html(RECIPE_LD), url)
        assert draft.title == "Weeknight Black Bean Tacos"
        assert draft.domain == "example-blog.com"
        assert draft.site_name == "Example Blog"
        assert draft.source_url == "https://www.example-blog.com/black-bean-tacos/"
        assert draft.image_url == "https://example-blog.com/img/tacos.jpg"
        assert (draft.prep_minutes, draft.cook_minutes, draft.total_minutes) == (10, 15, 25)
        assert draft.servings == 4
        assert draft.cuisines == ["mexican"]  # "Gluten-Free" isn't a cuisine
        assert [i.raw_text for i in draft.ingredients] == RECIPE_LD["recipeIngredient"]
        assert [i.line_no for i in draft.ingredients] == [0, 1, 2]

    def test_numbers_lines_through_every_section(self) -> None:
        # TYL-99: lines in sections ("For the sauce") were numbered from each
        # section's start, so two lines shared a number and the save failed.
        ld = {**RECIPE_LD, "recipeIngredient": ["1 cup cream", "1 clove garlic", "8 mushrooms"]}
        groups = (
            '<div class="wprm-recipe-ingredient-group">'
            '<h4 class="wprm-recipe-group-name">For the sauce</h4><ul>'
            '<li class="wprm-recipe-ingredient">1 cup cream</li>'
            '<li class="wprm-recipe-ingredient">1 clove garlic</li></ul></div>'
            '<div class="wprm-recipe-ingredient-group">'
            '<h4 class="wprm-recipe-group-name">For the mushrooms</h4><ul>'
            '<li class="wprm-recipe-ingredient">8 mushrooms</li></ul></div>'
        )
        html = page_html(ld).replace("</body>", f"{groups}</body>")
        draft = extract_recipe(html, "https://example-blog.com/mushrooms/")
        assert [(i.line_no, i.section) for i in draft.ingredients] == [
            (0, "For the sauce"),
            (1, "For the sauce"),
            (2, "For the mushrooms"),
        ]

    def test_prefers_the_pages_canonical_link_on_the_same_site(self) -> None:
        html = page_html(RECIPE_LD, canonical="https://example-blog.com/tacos/")
        draft = extract_recipe(html, "https://example-blog.com/tacos/print/")
        assert draft.source_url == "https://example-blog.com/tacos/"

    def test_ignores_a_canonical_link_to_another_site(self) -> None:
        html = page_html(RECIPE_LD, canonical="https://elsewhere.example/tacos/")
        draft = extract_recipe(html, "https://example-blog.com/tacos/")
        assert draft.source_url == "https://example-blog.com/tacos/"

    def test_rejects_pages_without_a_recipe(self) -> None:
        with pytest.raises(FetchError) as err:
            extract_recipe(page_html(None), "https://example-blog.com/about/")
        assert err.value.code == "not_a_recipe"

    def test_payload_matches_import_recipe(self) -> None:
        draft = extract_recipe(page_html(RECIPE_LD), "https://example-blog.com/tacos/")
        p = draft.payload("user-1")
        assert p["added_by"] == "user-1"
        assert p["source"]["domain"] == "example-blog.com"
        first = p["ingredients"][0]
        assert (first["line_no"], first["option_no"], first["raw_text"], first["section"]) == (
            0,
            1,
            "1 (15 oz) can black beans, drained",
            None,
        )
        # Parsed: the can's size becomes the amount, so it can be priced.
        assert (first["name"], first["quantity"], first["unit"], first["note"]) == (
            "black beans",
            15.0,
            "oz",
            "1 can",
        )
        assert first["candidates"][0] == "canned black beans"


def test_canonical_url_drops_tracking_and_fragments() -> None:
    assert (
        canonical_url("https://Example.com/a/?utm_medium=x&page=2&fbclid=1#recipe")
        == "https://example.com/a/?page=2"
    )


def test_keeps_the_publishers_diet_tags_as_hints() -> None:
    ld = {
        **RECIPE_LD,
        "suitableForDiet": [
            "https://schema.org/VegetarianDiet",
            "http://schema.org/GlutenFreeDiet",
            "LowLactoseDiet",
        ],
    }
    draft = extract_recipe(page_html(ld), "https://example-blog.com/tacos/")
    assert draft.publisher_diets == ["gluten_free", "vegetarian"]
    assert draft.payload(None)["publisher_diets"] == ["gluten_free", "vegetarian"]


def test_no_diet_tags_means_no_hints() -> None:
    draft = extract_recipe(page_html(RECIPE_LD), "https://example-blog.com/tacos/")
    assert draft.publisher_diets == []
