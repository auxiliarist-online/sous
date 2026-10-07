"""Save an extracted recipe through the import_recipe() database function."""

from typing import Any

import httpx2 as httpx

from app.config import settings
from app.recipes.extract import RecipeDraft


class StoreError(Exception):
    pass


async def save_recipe(draft: RecipeDraft, user_id: str) -> dict[str, Any]:
    """Returns {recipe_id, created, visibility, status}."""
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise StoreError("Supabase is not configured")
    key = settings.supabase_service_role_key
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{settings.supabase_url}/rest/v1/rpc/import_recipe",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            json={"p": draft.payload(user_id)},
        )
    if resp.status_code != 200:
        raise StoreError(f"import_recipe failed: {resp.status_code} {resp.text[:300]}")
    result: dict[str, Any] = resp.json()
    return result
