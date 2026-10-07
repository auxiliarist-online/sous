"""POST /recipes/import: save a recipe from a link (TYL-8)."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth import current_user_id
from app.recipes.extract import extract_recipe
from app.recipes.fetch import FetchError, fetch_page
from app.recipes.store import save_recipe

router = APIRouter(prefix="/recipes", tags=["recipes"])


class ImportRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


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
    saved = await save_recipe(draft, user_id)
    return ImportResult(
        recipe_id=saved["recipe_id"],
        created=saved["created"],
        title=draft.title,
        source_name=draft.site_name,
        source_url=draft.source_url,
        visibility=saved["visibility"],
        status=saved["status"],
    )
