"""Save a recipe to the user's library.

POST /recipes/import       from a link; Sous fetches the page (TYL-8).
POST /recipes/import-page  from the page data the user's own browser sends,
                           for sites that block Sous's server (TYL-35).
"""

from typing import Annotated, Any, Literal

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
from app.recipes.store import save_recipe

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
