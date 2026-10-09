"""Calls to Supabase (Auth and the import_recipe RPC), with HTTP mocked."""

import asyncio
import functools
import json
from collections.abc import Callable

import httpx2 as httpx
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app.auth import current_user_id
from app.config import settings
from app.recipes import store
from app.recipes.extract import extract_recipe
from tests.helpers import RECIPE_LD, page_html

Handler = Callable[[httpx.Request], httpx.Response]
Install = Callable[[Handler], list[httpx.Request]]


@pytest.fixture
def supabase(monkeypatch: pytest.MonkeyPatch) -> Install:
    """Route every AsyncClient through `handler`; returns the requests made."""
    monkeypatch.setattr(settings, "supabase_url", "https://proj.supabase.co")
    monkeypatch.setattr(settings, "supabase_service_role_key", "service-key")

    def install(handler: Handler) -> list[httpx.Request]:
        seen: list[httpx.Request] = []

        def record(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return handler(request)

        client = functools.partial(httpx.AsyncClient, transport=httpx.MockTransport(record))
        monkeypatch.setattr(httpx, "AsyncClient", client)
        return seen

    return install


def bearer(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


class TestCurrentUser:
    def test_returns_the_user_id_supabase_reports(self, supabase: Install) -> None:
        seen = supabase(lambda r: httpx.Response(200, json={"id": "user-1"}))
        assert asyncio.run(current_user_id(bearer("good-token"))) == "user-1"
        assert seen[0].url == "https://proj.supabase.co/auth/v1/user"
        assert seen[0].headers["authorization"] == "Bearer good-token"

    def test_rejects_an_invalid_token(self, supabase: Install) -> None:
        supabase(lambda r: httpx.Response(401, json={"msg": "invalid JWT"}))
        with pytest.raises(HTTPException) as err:
            asyncio.run(current_user_id(bearer("bad")))
        assert err.value.status_code == 401

    def test_requires_a_token(self) -> None:
        with pytest.raises(HTTPException) as err:
            asyncio.run(current_user_id(None))
        assert err.value.status_code == 401


class TestSaveRecipe:
    draft = extract_recipe(page_html(RECIPE_LD), "https://example-blog.com/tacos/")

    def test_calls_import_recipe_with_the_service_role(self, supabase: Install) -> None:
        result = {
            "recipe_id": "r-1",
            "created": True,
            "visibility": "private",
            "status": "needs_review",
        }
        seen = supabase(lambda r: httpx.Response(200, json=result))
        assert asyncio.run(store.save_recipe(self.draft, "user-1")) == result
        request = seen[0]
        assert request.url == "https://proj.supabase.co/rest/v1/rpc/import_recipe"
        assert request.headers["apikey"] == "service-key"
        assert json.loads(request.content)["p"] == {
            **self.draft.payload("user-1"),
            "origin": "fetched",
        }

    def test_marks_a_browser_import(self, supabase: Install) -> None:
        seen = supabase(lambda r: httpx.Response(200, json={"recipe_id": "r-1"}))
        asyncio.run(store.save_recipe(self.draft, "user-1", origin="browser"))
        assert json.loads(seen[0].content)["p"]["origin"] == "browser"

    def test_raises_when_the_database_refuses(self, supabase: Install) -> None:
        supabase(lambda r: httpx.Response(400, json={"message": "required"}))
        with pytest.raises(store.StoreError):
            asyncio.run(store.save_recipe(self.draft, "user-1"))

    def test_raises_when_not_configured(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "supabase_url", "")
        with pytest.raises(store.StoreError):
            asyncio.run(store.save_recipe(self.draft, "user-1"))
