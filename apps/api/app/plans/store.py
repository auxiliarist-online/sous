"""Read a user's meal plan through the plan_cost_inputs() database function,
and the recipes "Plan my week" can pick from through plan_draft_pool()."""

from datetime import date
from typing import Any

import httpx2 as httpx

from app.config import settings
from app.recipes.store import StoreError


async def _rpc(name: str, body: dict[str, Any]) -> Any:
    """Call a database function as the service role (the functions check the
    user they're given; the browser can't call them)."""
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise StoreError("Supabase is not configured")
    key = settings.supabase_service_role_key
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{settings.supabase_url}/rest/v1/rpc/{name}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            json=body,
        )
    if resp.status_code != 200:
        raise StoreError(f"{name} failed: {resp.status_code} {resp.text[:300]}")
    return resp.json()


async def draft_pool(user_id: str, week_start: date) -> list[dict[str, Any]]:
    """The user's saved recipes "Plan my week" can pick from (TYL-65), with
    fit, favorite rhythm, weeks since last had, and cuisines."""
    result: list[dict[str, Any]] = await _rpc(
        "plan_draft_pool", {"p_user": user_id, "p_week": week_start.isoformat()}
    )
    return result


async def cost_inputs(
    user_id: str, week_start: date, candidates: list[str] | None = None
) -> dict[str, Any]:
    """The week's plan, ingredients and prices for pricing it. `candidates`
    are recipes the user might add (TYL-30): they come back as entries marked
    "candidate", at full size."""
    body: dict[str, Any] = {"p_user": user_id, "p_week": week_start.isoformat()}
    if candidates:
        body["p_candidates"] = candidates
    result: dict[str, Any] = await _rpc("plan_cost_inputs", body)
    return result
