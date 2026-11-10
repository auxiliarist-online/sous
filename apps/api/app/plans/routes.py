"""Weekly meal plans (TYL-15).

GET /plans/{week_start}/cost   cost of the user's plan for that week, at today's
                               store prices where there are some (TYL-80), with
                               each recipe's share (TYL-30); ?list=1 for the
                               reviewed entries only (TYL-150).
POST /plans/{week_start}/added what adding each of some recipes would add to
                               that week's cost (TYL-30).
POST /plans/{week_start}/draft "Plan my week" (TYL-65): a draft of the open
                               dinners from the user's saved recipes.
POST /plans/{week_start}/own-items prices for items the user added to the
                               shopping list themselves (TYL-146).
POST /plans/item-sizes         the sizes a typed item comes in at the user's
                               store, with today's prices (TYL-142).

Adding, editing and copying plans happens in the web app, straight against
Supabase under row-level security; pricing needs the API's unit conversions.
"""

import asyncio
from dataclasses import asdict
from datetime import date, datetime
from typing import Annotated, Any
from uuid import UUID

import httpx2 as httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth import current_user_id
from app.plans.cost import added_costs, plan_cost
from app.plans.draft import Candidate, Variety, draft_week
from app.plans.item_sizes import item_sizes, picked_prices
from app.plans.live_prices import add_live_prices, no_store
from app.plans.own_items import candidates_for, price_own_items
from app.plans.store import cost_inputs, draft_pool, match_ingredient
from app.pricing.kroger import STORE_TZ
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
    week_start: date,
    user_id: Annotated[str, Depends(current_user_id)],
    list: bool = False,  # noqa: A002 - the query parameter's name
) -> dict[str, Any]:
    """The week's buy list and cost, and each planned recipe's share. With
    `list`, only the entries reviewed for the list (TYL-150): a new one
    reaches the shopping list once the user has checked what they have."""
    inputs, store_id = await _inputs(user_id, week_start)
    if list:
        inputs["entries"] = [e for e in inputs.get("entries", []) if e.get("reviewed", True)]
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


class OwnItemName(BaseModel):
    """A list item the user typed: its id on the list and its name."""

    id: str = Field(max_length=64)
    name: str = Field(min_length=1, max_length=200)
    # The store product the user picked a size as (TYL-142), if any.
    product_id: str | None = Field(default=None, pattern=r"^\d{1,20}$")


class OwnItems(BaseModel):
    """The user's own items on the week's list."""

    items: list[OwnItemName] = Field(max_length=100)


@router.post("/{week_start}/own-items")
async def own_items(
    week_start: date, body: OwnItems, user_id: Annotated[str, Depends(current_user_id)]
) -> dict[str, Any]:
    """Each item matched to an ingredient and priced as one package, with
    their total; an item that doesn't match is left unpriced (TYL-146)."""
    # A few lookups at a time, not one connection per item.
    gate = asyncio.Semaphore(8)

    async def match(name: str) -> str | None:
        """The ingredient a typed name matches, if any."""
        async with gate:
            return await match_ingredient(candidates_for(name))

    try:
        matched = await asyncio.gather(*(match(i.name) for i in body.items))
    except StoreError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "We couldn't price your items. Try again."
        ) from exc
    extra = sorted({m for m in matched if m})
    inputs: dict[str, Any] = {}
    store_id = None
    if extra:
        if week_start.isoweekday() != 1:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Weeks start on Monday.")
        try:
            inputs = await cost_inputs(user_id, week_start, extra=extra)
        except StoreError as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY, "We couldn't price your items. Try again."
            ) from exc
        # Only the items' own ingredients, so live prices look up just those.
        inputs["entries"] = []
        found = inputs.get("ingredients", {})
        keep = set(extra) | {found[e]["buy_as"] for e in extra if found.get(e, {}).get("buy_as")}
        inputs["ingredients"] = {k: v for k, v in found.items() if k in keep}
        store_id = await add_live_prices(user_id, inputs)
    priced = price_own_items(
        [(i.id, m) for i, m in zip(body.items, matched, strict=True)],
        inputs,
        on=week_start,
        store_id=store_id,
    )
    # A size the user picked is priced as that product, live (TYL-142).
    picked = await picked_prices(
        user_id, [i.product_id for i in body.items if i.product_id], store_today()
    )
    for item, own in zip(body.items, priced, strict=True):
        if item.product_id and item.product_id in picked:
            own.cents, own.on_sale = picked[item.product_id]
            own.estimated = False
    return {
        "total_cents": sum(i.cents or 0 for i in priced),
        "items": [asdict(i) for i in priced],
    }


def store_today() -> date:
    """Today where the stores are (Eastern): a sale that ends today still
    holds after midnight UTC."""
    return datetime.now(STORE_TZ).date()


class ItemName(BaseModel):
    """An item the user typed on the list."""

    name: str = Field(min_length=1, max_length=200)


@router.post("/item-sizes")
async def sizes(
    body: ItemName, user_id: Annotated[str, Depends(current_user_id)]
) -> dict[str, Any]:
    """The package sizes a typed item comes in at the user's store, with
    today's prices, to pick from (TYL-142). Looked up live; nothing stored."""
    try:
        found = await item_sizes(user_id, body.name, store_today())
    except (StoreError, httpx.HTTPError) as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "We couldn't look up sizes. Try again."
        ) from exc
    return {"ingredient_id": found["ingredient_id"], "sizes": [asdict(o) for o in found["sizes"]]}


# Ratings ahead of others in the pool, best first.
RATED = {"love": 0, "up": 1}

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
        found = await draft_pool(user_id, week_start)
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
            tags=list(r.get("tags") or []),
            in_season=list(r.get("in_season") or []),
            out_of_season=int(r.get("out_of_season") or 0),
            rating=r.get("rating"),
        )
        for r in found.get("candidates") or []
    ]
    locked = [str(r) for r in body.locked]
    # Kept ones first, then favorites due, then what the user loved or liked
    # (TYL-16), so the cap below can't drop them before their bonus counts.
    pool.sort(
        key=lambda c: (
            c.recipe_id not in locked,
            not c.due,
            RATED.get(c.rating or "", len(RATED)),
            c.weeks_ago is not None,
        )
    )
    # Left out before the cap: ones that break the user's rules, ones they
    # swapped out, and ones they rated down after cooking (TYL-16), unless
    # they kept it themselves.
    swapped = {str(r) for r in body.exclude}
    pool = [
        c
        for c in pool
        if c.fit != "excluded"
        and c.recipe_id not in swapped
        and (c.rating != "down" or c.recipe_id in locked)
    ][:DRAFT_POOL]
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
        cook_with_seasons=bool(found.get("cook_with_seasons")),
        variety=Variety.from_json(found.get("variety")),
    )
    return asdict(result)
