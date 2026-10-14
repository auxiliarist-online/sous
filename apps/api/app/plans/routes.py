"""Weekly meal plans (TYL-15).

GET /plans/{week_start}/cost   cost of the user's plan for that week, at today's
                               store prices where there are some (TYL-80), with
                               each recipe's share (TYL-30).
POST /plans/{week_start}/added what adding each of some recipes would add to
                               that week's cost (TYL-30).

Adding, editing and copying plans happens in the web app, straight against
Supabase under row-level security; pricing needs the API's unit conversions.
"""

from dataclasses import asdict
from datetime import date
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth import current_user_id
from app.plans.cost import added_costs, plan_cost
from app.plans.live_prices import add_live_prices
from app.plans.store import cost_inputs
from app.recipes.store import StoreError

router = APIRouter(prefix="/plans", tags=["plans"])


async def _inputs(
    user_id: str, week_start: date, candidates: list[str] | None = None
) -> tuple[dict[str, Any], str | None]:
    """The week's pricing inputs with today's store prices, and the store."""
    if week_start.isoweekday() != 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Weeks start on Monday.")
    try:
        inputs = await cost_inputs(user_id, week_start, candidates)
    except StoreError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "We couldn't load your plan. Try again."
        ) from exc
    return inputs, await add_live_prices(user_id, inputs)


@router.get("/{week_start}/cost")
async def week_cost(
    week_start: date, user_id: Annotated[str, Depends(current_user_id)]
) -> dict[str, Any]:
    """The week's buy list and cost, and each planned recipe's share."""
    inputs, store_id = await _inputs(user_id, week_start)
    return asdict(plan_cost(inputs, on=week_start, store_id=store_id))


class Candidates(BaseModel):
    """Recipes the user might add to the week: their saved ones, say."""

    recipe_ids: list[UUID] = Field(min_length=1, max_length=100)


@router.post("/{week_start}/added")
async def added(
    week_start: date, body: Candidates, user_id: Annotated[str, Depends(current_user_id)]
) -> dict[str, Any]:
    """What adding each recipe at full size would add to the week's cost, with
    the week's total and budget to compare against (TYL-30)."""
    ids = list(dict.fromkeys(str(r) for r in body.recipe_ids))
    inputs, store_id = await _inputs(user_id, week_start, ids)
    week = plan_cost(inputs, on=week_start, store_id=store_id)
    return {
        "budget_cents": week.budget_cents,
        "total_cents": week.total_cents,
        "recipes": [asdict(a) for a in added_costs(inputs, on=week_start, store_id=store_id)],
    }
