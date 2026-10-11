"""Weekly meal plans (TYL-15).

GET /plans/{week_start}/cost   estimated cost of the user's plan for that week.

Adding, editing and copying plans happens in the web app, straight against
Supabase under row-level security; pricing needs the API's unit conversions.
"""

from dataclasses import asdict
from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status

from app.auth import current_user_id
from app.plans.cost import plan_cost
from app.plans.store import cost_inputs
from app.recipes.store import StoreError

router = APIRouter(prefix="/plans", tags=["plans"])


@router.get("/{week_start}/cost")
async def week_cost(
    week_start: date, user_id: Annotated[str, Depends(current_user_id)]
) -> dict[str, Any]:
    if week_start.isoweekday() != 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Weeks start on Monday.")
    try:
        inputs = await cost_inputs(user_id, week_start)
    except StoreError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "We couldn't load your plan. Try again."
        ) from exc
    return asdict(plan_cost(inputs, on=week_start))
