"""The user's grocery store (TYL-19).

GET    /stores/nearby?zip=23451   Kroger-family stores near a zip code
GET    /stores/mine               the user's store, or none
PUT    /stores/mine               choose a store by its Kroger location id
DELETE /stores/mine               no store: prices are estimates

Live prices come from the user's store (app/plans/live_prices.py). Kroger's
store details are looked up live; only the chosen store is kept, as the user's
own choice (its name, address and location id), not a copy of Kroger's list.
"""

import asyncio
import re
from dataclasses import asdict
from typing import Annotated, Any

import httpx2 as httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.auth import current_user_id
from app.config import settings
from app.pricing.kroger import Kroger, Location

router = APIRouter(prefix="/stores", tags=["stores"])

ZIP = re.compile(r"^[0-9]{5}$")
# Kroger's chain codes; every other Kroger-family chain (Kroger, Ralphs, Fred
# Meyer...) sells Kroger's own brand, so they share one set of product matches.
CHAINS = {"HART": "harris_teeter"}


def chain_slug(chain: str) -> str:
    """Our store_chains slug for a Kroger chain code."""
    return CHAINS.get(chain.upper(), "kroger")


def _headers() -> dict[str, str]:
    """The service role's headers for Supabase's REST API."""
    key = settings.supabase_service_role_key
    return {"apikey": key, "Authorization": f"Bearer {key}"}


def _kroger(call: str, *args: Any) -> Any:
    """Run one Kroger client call (it's synchronous) with a fresh client."""
    with httpx.Client(timeout=10.0) as client:
        return getattr(Kroger(client), call)(*args)


def _out(loc: Location) -> dict[str, Any]:
    """A store as the web app reads it, with our chain slug."""
    return {**asdict(loc), "chain_slug": chain_slug(loc.chain)}


@router.get("/nearby")
async def nearby(
    user_id: Annotated[str, Depends(current_user_id)],
    zip_code: Annotated[str, Query(alias="zip", pattern=ZIP.pattern)],
) -> list[dict[str, Any]]:
    """Kroger-family stores near a zip code, nearest first."""
    try:
        stores: list[Location] = await asyncio.to_thread(_kroger, "stores_near", zip_code)
    except (httpx.HTTPError, RuntimeError) as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "We couldn't look up stores. Try again."
        ) from exc
    return [_out(s) for s in stores]


@router.get("/mine")
async def mine(user_id: Annotated[str, Depends(current_user_id)]) -> dict[str, Any]:
    """The user's store, or none: without one, Sous prices from estimates."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"{settings.supabase_url}/rest/v1/user_stores",
            params={
                "select": "stores(name,address,zip,external_location_id,chain_slug)",
                "user_id": f"eq.{user_id}",
                "is_primary": "is.true",
            },
            headers=_headers(),
        )
    if resp.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "We couldn't load your store.")
    rows = resp.json()
    return {"store": rows[0]["stores"] if rows else None}


class Choice(BaseModel):
    """A Kroger location id, from /stores/nearby."""

    location_id: str = Field(pattern=r"^[0-9A-Za-z]{1,20}$")


@router.put("/mine")
async def choose(body: Choice, user_id: Annotated[str, Depends(current_user_id)]) -> dict[str, Any]:
    """Make a Kroger-family store the user's store, checked with Kroger."""
    try:
        loc: Location | None = await asyncio.to_thread(_kroger, "store", body.location_id)
    except (httpx.HTTPError, RuntimeError) as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "We couldn't check that store. Try again."
        ) from exc
    if loc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Kroger doesn't know that store.")
    address = ", ".join(p for p in (loc.address, loc.city, loc.state) if p)
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{settings.supabase_url}/rest/v1/rpc/set_my_store",
            json={
                "p_user": user_id,
                "p_chain": chain_slug(loc.chain),
                "p_name": loc.name,
                "p_address": address,
                "p_zip": loc.zip if ZIP.match(loc.zip) else None,
                "p_location_id": loc.location_id,
            },
            headers=_headers(),
        )
    if resp.status_code != 200:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "We couldn't save your store.")
    return {"store": _out(loc), "default": False}


@router.delete("/mine", status_code=status.HTTP_204_NO_CONTENT)
async def forget(user_id: Annotated[str, Depends(current_user_id)]) -> None:
    """No store any more: prices are estimates until the user chooses one."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.patch(
            f"{settings.supabase_url}/rest/v1/user_stores",
            params={"user_id": f"eq.{user_id}", "is_primary": "is.true"},
            json={"is_primary": False},
            headers=_headers(),
        )
    if resp.status_code not in (200, 204):
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "We couldn't change your store.")
