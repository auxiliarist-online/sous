"""NHLBI's public-domain recipes: what's kept and how it's read (TYL-42).
The pages here are written for the tests, shaped like NHLBI's."""

from app.recipes.nhlbi import INDEX_PATH, federal, parse, recipe_links, source_of

URL = f"https://www.nhlbi.nih.gov{INDEX_PATH}/test-bean-soup"


def page(source: str = "Deliciously Healthy Dinners", body_extra: str = "") -> str:
    return f"""<html><body>
<div class="field field--name-body"><p>Site news: a banner, not the recipe.</p></div>
<main><article class="node node--type-recipe">
<h1><span>Test Bean Soup</span></h1>
<div class="clearfix field field--name-body">
  <p><strong>A hearty soup for a cold night.</strong></p>
  <p>Recipe Source: <em>{source}</em></p>
  <h2>Ingredients</h2>
  <ul><li>2 C cooked white beans</li><li>1 Tbsp olive oil</li></ul>
  <h3>For the topping</h3>
  <ul><li>2 Tbsp chopped parsley</li></ul>
  <h2>Directions</h2>
  <ol><li>Warm the oil.</li><li>Add the beans and simmer 10 minutes.</li></ol>
  {body_extra}
</div>
<table class="cooking-facts"><tbody>
  <tr><th>Prep Time</th><td><div>10 minutes</div></td></tr>
  <tr><th>Cook Time</th><td><div>1 hour 5 minutes</div></td></tr>
  <tr><th>Yields</th><td><div>4 servings</div></td></tr>
</tbody></table>
</article></main>
<div class="field field--name-body"><p>Recipe Source: a footer, not this</p></div>
</body></html>"""


def test_reads_a_recipe_with_its_steps() -> None:
    draft = parse(URL, page())
    assert draft is not None
    assert draft.title == "Test Bean Soup"
    assert draft.summary == "A hearty soup for a cold night."
    assert [i.raw_text for i in draft.ingredients] == [
        "2 C cooked white beans",
        "1 Tbsp olive oil",
        "2 Tbsp chopped parsley",
    ]
    assert draft.ingredients[2].section == "For the topping"
    assert [i.line_no for i in draft.ingredients] == [0, 1, 2]
    assert draft.instructions == ["Warm the oil.", "Add the beans and simmer 10 minutes."]
    assert (draft.servings, draft.prep_minutes, draft.cook_minutes, draft.total_minutes) == (
        4.0,
        10,
        65,
        75,
    )
    assert draft.domain == "www.nhlbi.nih.gov"


def test_keeps_only_federal_cookbooks() -> None:
    assert source_of(page()) == "Deliciously Healthy Dinners"
    assert federal("Keep the Beat™ Recipes: Deliciously Healthy Dinners")
    assert not federal("A State University Extension Cookbook")
    assert not federal(None)
    assert parse(URL, page(source="A State University Extension Cookbook")) is None


def test_leaves_out_pages_that_arent_recipes() -> None:
    no_steps = page().replace("<h2>Directions</h2>", "<h2>Notes</h2>")
    assert parse(URL, no_steps) is None


def test_lists_recipe_links_once() -> None:
    index = f"""<a href="{INDEX_PATH}/test-bean-soup">Soup</a>
    <a href="{INDEX_PATH}/test-bean-soup?x=1">Soup again</a>
    <a href="{INDEX_PATH}/greens">Greens</a>
    <a href="{INDEX_PATH}?page=1">Next</a>
    <a href="/health/other">Other</a>"""
    assert recipe_links(index) == [URL, f"https://www.nhlbi.nih.gov{INDEX_PATH}/greens"]
