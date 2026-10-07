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
        assert p["ingredients"][0] == {
            "line_no": 0,
            "raw_text": "1 (15 oz) can black beans, drained",
            "section": None,
        }


def test_canonical_url_drops_tracking_and_fragments() -> None:
    assert (
        canonical_url("https://Example.com/a/?utm_medium=x&page=2&fbclid=1#recipe")
        == "https://example.com/a/?page=2"
    )
