"""Identify the signed-in user from their Supabase access token."""

from typing import Annotated

import httpx2 as httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings

bearer = HTTPBearer(auto_error=False)


async def current_user_id(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> str:
    """Ask Supabase Auth who the token belongs to; 401 if it's missing or invalid."""
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to import recipes.")
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(
            f"{settings.supabase_url}/auth/v1/user",
            headers={
                "apikey": settings.supabase_service_role_key,
                "Authorization": f"Bearer {creds.credentials}",
            },
        )
    if resp.status_code != 200:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Your session has expired.")
    user_id: str = resp.json()["id"]
    return user_id
