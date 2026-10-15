"""Save a recipe to the user's library.

POST /recipes/import       from a link; Sous fetches the page (TYL-8).
POST /recipes/import-page  from the page data the user's own browser sends,
                           for sites that block Sous's server (TYL-35).
POST /recipes/import-text  a link plus ingredient lines the user copied from
                           a page that blocks Sous (TYL-59).
POST /recipes/manual       a recipe the user types in; PUT /recipes/manual/{id} edits it.
POST /recipes/read-photos  photos of a cookbook's pages, read into a draft for the
                           manual-entry form (TYL-52); nothing is saved.
"""

import base64
import binascii
import re
from dataclasses import asdict
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth import current_user_id
from app.recipes.extract import (
    MAX_LD_BLOCKS,
    MAX_LD_CHARS,
    Ingredient,
    RecipeDraft,
    canonical_url,
    domain_of,
    extract_recipe,
    page_from_json_ld,
)
from app.recipes.fetch import FetchError, fetch_page
from app.recipes.ingredients import parse_line
from app.recipes.photos import PhotoError, read_pages, recipe_from_pages, record_read
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


class TextImportRequest(BaseModel):
    """A recipe from a site that blocks Sous: its link, a title, and the
    ingredient lines the user copied from the page. A line ending in ":"
    starts a section. No steps: those stay on the author's page."""

    url: str = Field(min_length=1, max_length=2048)
    title: str = Field(min_length=1, max_length=200)
    ingredients: list[Annotated[str, Field(max_length=500)]] = Field(
        default_factory=list, max_length=200
    )


@router.post("/import-text", status_code=status.HTTP_200_OK)
async def import_text(
    body: TextImportRequest, user_id: Annotated[str, Depends(current_user_id)]
) -> ImportResult:
    """Like import-page, this is only the user's word for what the page says,
    so it's kept as their private copy. With no ingredients it's still saved,
    as a link to come back to."""
    url = body.url.strip()
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            {"code": "invalid_url", "message": "That doesn't look like a web address."},
        )
    title = body.title.strip()
    if not title:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            {"code": "no_title", "message": "Give the recipe a name."},
        )
    ingredients: list[Ingredient] = []
    section: str | None = None
    for raw in body.ingredients:
        line = raw.strip()
        if not line:
            continue
        if line.endswith(":"):
            section = line[:-1].strip() or None
            continue
        ingredients.append(Ingredient(len(ingredients), line, section))
    source_url = canonical_url(url)
    draft = RecipeDraft(
        source_url=source_url,
        domain=domain_of(source_url),
        # The page's own name isn't known; the source is shown by its domain.
        site_name=None,
        title=title,
        ingredients=ingredients,
    )
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


# Photos come from the phone already shrunk (about 1,600 px, JPEG); a request
# must stay under Vercel's 4.5 MB body limit, so 4 pages of 1 MB at most.
MAX_PHOTO_BYTES = 1_000_000
PHOTO_KINDS = (b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n", b"RIFF")


class PhotoPages(BaseModel):
    """One recipe's pages, in order, as base64 JPEG, PNG or WebP."""

    images: list[str] = Field(min_length=1, max_length=4)


def _photo(data: str) -> bytes:
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That isn't a photo.") from exc
    if len(raw) > MAX_PHOTO_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "A photo is too large.")
    if not raw.startswith(PHOTO_KINDS) or (raw.startswith(b"RIFF") and raw[8:12] != b"WEBP"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That isn't a photo.")
    return raw


@router.post("/read-photos")
async def read_photos(
    body: PhotoPages, user_id: Annotated[str, Depends(current_user_id)]
) -> dict[str, Any]:
    """Read photos of one recipe's pages into a draft: title, servings, times,
    ingredients and steps, and the lines to check. Nothing is saved; the user
    checks the draft in the manual-entry form, and the photos aren't kept."""
    images = [_photo(i) for i in body.images]
    try:
        if not await record_read(user_id, len(images)):
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "That's a lot of pages for now. Try again tomorrow, or type the recipe in.",
            )
        pages = await read_pages(images)
    except PhotoError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "We couldn't read the photos. Try again."
        ) from exc
    return asdict(recipe_from_pages(pages))
