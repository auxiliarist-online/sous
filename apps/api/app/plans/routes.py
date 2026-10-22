"""Weekly meal plans (TYL-15).

GET /plans/{week_start}/cost   cost of the user's plan for that week, at today's
                               store prices where there are some (TYL-80), with
                               each recipe's share (TYL-30).
POST /plans/{week_start}/added what adding each of some recipes would add to
                               that week's cost (TYL-30).
POST /plans/{week_start}/draft "Plan my week" (TYL-65): a draft of the open
                               dinners from the user's saved recipes.

Adding, editing and copying plans happens in the web app, straight against
Supabase under row-level security; pricing needs the API's unit conversions.
"""

import asyncio
from dataclasses import asdict
from datetime import date
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth import current_user_id
from app.plans.cost import added_costs, plan_cost
from app.plans.draft import Candidate, draft_week
from app.plans.live_prices import add_live_prices, no_store
from app.plans.store import cost_inputs, draft_pool
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
    cost = asdict(plan_cost(inputs, on=week_start, store_id=store_id))
    # Priced from a store, or not, and why (for the plan page to say so).
    cost.update(
        {"store_status": "store", "home_zip": None} if store_id else await no_store(user_id)
    )
    return cost


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


# The most saved recipes a draft considers: favorites that are due first, then
# the ones not had lately, newest saved first.
DRAFT_POOL = 100


class DraftRequest(BaseModel):
    """How many dinners the week should have (planned ones count), picks to
    keep, and recipes not to pick (swapped out)."""

    dinners: int = Field(default=5, ge=1, le=14)
    locked: list[UUID] = Field(default_factory=list, max_length=14)
    exclude: list[UUID] = Field(default_factory=list, max_length=100)


@router.post("/{week_start}/draft")
async def draft(
    week_start: date, body: DraftRequest, user_id: Annotated[str, Depends(current_user_id)]
) -> dict[str, Any]:
    """Draft the week's open dinners (TYL-65). Nothing is saved: the web app
    adds the picks the user accepts as normal plan entries."""
    try:
        rows = await draft_pool(user_id, week_start)
    except StoreError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "We couldn't load your recipes. Try again."
        ) from exc
    pool = [
        Candidate(
            recipe_id=str(r["recipe_id"]),
            title=r["title"],
            fit=r.get("fit") or "unknown",
            favorite=r.get("favorite"),
            weeks_ago=r.get("weeks_ago"),
            cuisines=list(r.get("cuisines") or []),
        )
        for r in rows
    ]
    locked = [str(r) for r in body.locked]
    pool.sort(key=lambda c: (c.recipe_id not in locked, not c.due, c.weeks_ago is not None))
    pool = [c for c in pool if c.fit != "excluded"][:DRAFT_POOL]
    inputs, store_id = await _inputs(user_id, week_start, [c.recipe_id for c in pool])
    # CPU work (scoring many weeks): off the event loop, so other requests
    # aren't held up. draft_week keeps all its state per call.
    result = await asyncio.to_thread(
        draft_week,
        inputs,
        pool,
        dinners=body.dinners,
        locked=locked,
        exclude=[str(r) for r in body.exclude],
        on=week_start,
        store_id=store_id,
    )
    return asdict(result)
