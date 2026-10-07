"""Page → extract → payload → import_recipe(), against real Postgres.

The unit tests check the Python side and supabase/tests checks the SQL side;
these make sure the two agree on the payload.
"""

import json
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Any

import psycopg

from app.recipes.extract import CUISINES, RecipeDraft, extract_recipe
from tests.helpers import RECIPE_LD, page_html

URL = "https://www.example-blog.com/black-bean-tacos/"


def import_draft(db: psycopg.Connection, draft: RecipeDraft, user_id: str | None) -> Any:
    row = db.execute(
        "select import_recipe(%s::jsonb)", [json.dumps(draft.payload(user_id))]
    ).fetchone()
    assert row is not None
    return row[0]


def test_an_extracted_page_is_stored_as_the_policy_says(
    db: psycopg.Connection, make_user: Callable[[], str]
) -> None:
    user = make_user()
    draft = extract_recipe(page_html(RECIPE_LD), URL)
    result = import_draft(db, draft, user)
    assert result["created"] is True
    assert result["visibility"] == "private"
    assert result["status"] == "needs_review"

    row = db.execute(
        """
        select r.title, r.source_url, r.image_url, r.servings, r.prep_minutes,
               r.cook_minutes, r.total_minutes, r.summary, r.instructions,
               s.domain, s.name, s.content_rights
        from recipes r join recipe_sources s on s.id = r.source_id
        where r.id = %s
        """,
        [result["recipe_id"]],
    ).fetchone()
    assert row is not None
    (title, url, image, servings, prep, cook, total, summary, steps, domain, name, rights) = row
    assert (title, url, image) == (draft.title, draft.source_url, draft.image_url)
    assert (float(servings), prep, cook, total) == (4.0, 10, 15, 25)
    assert (domain, name, rights) == ("example-blog.com", "Example Blog", "link_only")
    # link-only source: the author's headnote and instructions are not stored
    assert summary is None
    assert steps is None

    lines = db.execute(
        "select line_no, raw_text from recipe_ingredients where recipe_id = %s order by line_no",
        [result["recipe_id"]],
    ).fetchall()
    assert lines == [(i.line_no, i.raw_text) for i in draft.ingredients]

    cuisines = db.execute(
        "select cuisine_slug from recipe_cuisines where recipe_id = %s", [result["recipe_id"]]
    ).fetchall()
    assert cuisines == [("mexican",)]


def test_a_second_import_reuses_the_recipe_and_shares_it(
    db: psycopg.Connection,
    make_user: Callable[[], str],
    as_user: Callable[[str | None], AbstractContextManager[None]],
) -> None:
    alice, bob = make_user(), make_user()
    draft = extract_recipe(page_html(RECIPE_LD), URL)
    first = import_draft(db, draft, alice)
    second = import_draft(db, extract_recipe(page_html(RECIPE_LD), URL + "?utm_source=x"), bob)
    assert second["created"] is False
    assert second["recipe_id"] == first["recipe_id"]

    for user in (alice, bob):
        with as_user(user):
            seen = db.execute("select id from recipes where id = %s", [first["recipe_id"]])
            assert seen.fetchone() is not None
    with as_user(None):
        hidden = db.execute("select id from recipes where id = %s", [first["recipe_id"]])
        assert hidden.fetchone() is None


def test_every_mapped_cuisine_exists_in_the_database(db: psycopg.Connection) -> None:
    known = {slug for (slug,) in db.execute("select slug from cuisines").fetchall()}
    assert set(CUISINES.values()) <= known


def test_the_crawler_refreshes_a_changed_page(db: psycopg.Connection) -> None:
    db.execute(
        "insert into recipe_sources (name, domain, crawl_enabled) "
        "values ('Example Blog', 'example-blog.com', true)"
    )
    first = extract_recipe(page_html(RECIPE_LD), URL)
    created = import_draft(db, first, None)
    assert (created["created"], created["visibility"]) == (True, "public")

    changed_ld = {**RECIPE_LD, "recipeIngredient": ["2 cans black beans", "8 corn tortillas"]}
    changed = extract_recipe(page_html(changed_ld), URL)
    row = db.execute(
        "select import_recipe(%s::jsonb)", [json.dumps({**changed.payload(None), "refresh": True})]
    ).fetchone()
    assert row is not None
    assert (row[0]["recipe_id"], row[0]["updated"]) == (created["recipe_id"], True)
    lines = db.execute(
        "select raw_text from recipe_ingredients where recipe_id = %s order by line_no",
        [created["recipe_id"]],
    ).fetchall()
    assert lines == [("2 cans black beans",), ("8 corn tortillas",)]
