"""Save a recipe to the user's library.

POST /recipes/import       from a link; Sous fetches the page (TYL-8).
POST /recipes/import-page  from the page data the user's own browser sends,
                           for sites that block Sous's server (TYL-35).
POST /recipes/manual       a recipe the user types in; PUT /recipes/manual/{id} edits it.
"""

import re
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth import current_user_id
from app.recipes.extract import (
    MAX_LD_BLOCKS,
    MAX_LD_CHARS,
    RecipeDraft,
    extract_recipe,
    page_from_json_ld,
)
from app.recipes.fetch import FetchError, fetch_page
from app.recipes.ingredients import parse_line
from app.recipes.store import NotYours, save_manual, save_recipe

router = APIRouter(prefix="/recipes", tags=["recipes"])


class ImportRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class PageImportRequest(BaseModel):
    """What the bookmarklet reads from a recipe page in the user's browser."""

    url: str = Field(min_length=1, max_length=2048)
    site_name: str | None = Field(default=None, max_length=200)
    ld: list[str] = Field(min_length=1, max_length=MAX_LD_BLOCKS)


class ImportResult(BaseModel):
    recipe_id: str
    created: bool
    title: str
    source_name: str | None
    source_url: str
    visibility: Literal["public", "private"]
    status: str


@router.post("/import", status_code=status.HTTP_200_OK)
async def import_recipe(
    body: ImportRequest, user_id: Annotated[str, Depends(current_user_id)]
) -> ImportResult:
    url = body.url.strip()
    if "://" not in url:
        url = f"https://{url}"
    try:
        page = await fetch_page(url)
        draft = extract_recipe(page.html, page.url)
    except FetchError as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, {"code": e.code, "message": e.message}
        ) from e
    return _result(draft, await save_recipe(draft, user_id))


@router.post("/import-page", status_code=status.HTTP_200_OK)
async def import_page(
    body: PageImportRequest, user_id: Annotated[str, Depends(current_user_id)]
) -> ImportResult:
    """No fetch happens here: the user's browser already visited the page, so
    there's no robots.txt or block to respect. The data is only trusted for
    this user and is kept as their private copy."""
    if sum(len(b) for b in body.ld) > MAX_LD_CHARS:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            {"code": "too_large", "message": "That page has too much data to import."},
        )
    try:
        draft = extract_recipe(page_from_json_ld(body.url, body.ld, body.site_name), body.url)
    except FetchError as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, {"code": e.code, "message": e.message}
        ) from e
    return _result(draft, await save_recipe(draft, user_id, origin="browser"))


def _result(draft: RecipeDraft, saved: dict[str, Any]) -> ImportResult:
    return ImportResult(
        recipe_id=saved["recipe_id"],
        created=saved["created"],
        title=draft.title,
        source_name=draft.site_name,
        source_url=draft.source_url,
        visibility=saved["visibility"],
        status=saved["status"],
    )


class ManualRecipe(BaseModel):
    """A recipe typed in by hand. Ingredients and steps are one per line; an
    ingredient line ending in ":" starts a section ("For the sauce:")."""

    title: str = Field(min_length=1, max_length=200)
    ingredients: str = Field(default="", max_length=20_000)
    instructions: str = Field(default="", max_length=50_000)
    servings: float | None = Field(default=None, gt=0, le=100)
    prep_minutes: int | None = Field(default=None, ge=0, le=10_000)
    cook_minutes: int | None = Field(default=None, ge=0, le=10_000)
    total_minutes: int | None = Field(default=None, ge=0, le=10_000)
    source_note: str | None = Field(default=None, max_length=300)
    cuisines: list[str] = Field(default_factory=list, max_length=10)


class ManualResult(BaseModel):
    recipe_id: str
    created: bool


STEP_NUMBER = re.compile(r"^\s*(?:step\s*)?\d+[.):]\s*", re.I)


def _manual_payload(body: ManualRecipe, user_id: str, recipe_id: UUID | None) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    section: str | None = None
    for raw in body.ingredients.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.endswith(":"):
            section = line[:-1].strip() or None
            continue
        rows += [p.payload() for p in parse_line(len(rows), line, section)]
    steps = [STEP_NUMBER.sub("", s).strip() for s in body.instructions.splitlines()]
    steps = [s for s in steps if s]
    return {
        "added_by": user_id,
        "recipe_id": str(recipe_id) if recipe_id else None,
        "recipe": {
            "title": body.title.strip(),
            "servings": body.servings,
            "prep_minutes": body.prep_minutes,
            "cook_minutes": body.cook_minutes,
            "total_minutes": body.total_minutes,
            "instructions": steps or None,
            "source_note": (body.source_note or "").strip() or None,
        },
        "cuisines": body.cuisines,
        "ingredients": rows,
    }


@router.post("/manual", status_code=status.HTTP_201_CREATED)
async def create_manual(
    body: ManualRecipe, user_id: Annotated[str, Depends(current_user_id)]
) -> ManualResult:
    saved = await save_manual(_manual_payload(body, user_id, None))
    return ManualResult(recipe_id=saved["recipe_id"], created=True)


@router.put("/manual/{recipe_id}")
async def edit_manual(
    recipe_id: UUID, body: ManualRecipe, user_id: Annotated[str, Depends(current_user_id)]
) -> ManualResult:
    try:
        saved = await save_manual(_manual_payload(body, user_id, recipe_id))
    except NotYours as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such recipe of yours.") from e
    return ManualResult(recipe_id=saved["recipe_id"], created=False)
