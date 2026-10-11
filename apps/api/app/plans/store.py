"""Read a user's meal plan through the plan_cost_inputs() database function."""

from datetime import date
from typing import Any

import httpx2 as httpx

from app.config import settings
from app.recipes.store import StoreError


async def cost_inputs(user_id: str, week_start: date) -> dict[str, Any]:
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise StoreError("Supabase is not configured")
    key = settings.supabase_service_role_key
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{settings.supabase_url}/rest/v1/rpc/plan_cost_inputs",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            json={"p_user": user_id, "p_week": week_start.isoformat()},
        )
    if resp.status_code != 200:
        raise StoreError(f"plan_cost_inputs failed: {resp.status_code} {resp.text[:300]}")
    result: dict[str, Any] = resp.json()
    return result
