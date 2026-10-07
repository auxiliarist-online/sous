"""Real websites, run with `pytest --live`. Not part of CI: sites change and
we don't want to send them traffic on every push. One request per site per run.

If one starts failing, check the site by hand before changing code: it may have
moved the recipe, changed its markup, or changed its bot protection. The sites
come from docs/research/0002-recipe-sources.md.
"""

import asyncio

import pytest

from app.recipes.extract import extract_recipe
from app.recipes.fetch import FetchError, fetch_page

REACHABLE = "https://minimalistbaker.com/honey-almond-snack-cake/"
BLOCKED = "https://www.budgetbytes.com/vegetarian-black-bean-chili/"


def test_imports_a_recipe_from_a_reachable_blog() -> None:
    page = asyncio.run(fetch_page(REACHABLE))
    draft = extract_recipe(page.html, page.url)
    assert draft.domain == "minimalistbaker.com"
    assert draft.title
    assert len(draft.ingredients) >= 3
    assert draft.total_minutes and draft.total_minutes > 0


def test_reports_a_bot_protected_blog_as_blocked() -> None:
    with pytest.raises(FetchError) as err:
        asyncio.run(fetch_page(BLOCKED))
    assert err.value.code == "blocked"
