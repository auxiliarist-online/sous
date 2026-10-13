import functools
from collections.abc import Callable

import httpx2 as httpx
import pytest

from app.config import settings
from app.recipes import fetch


@pytest.fixture(autouse=True)
def fresh_fetch_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fetch, "robots", fetch.Robots())
    monkeypatch.setattr(fetch, "throttle", fetch.Throttle(0))
    # Never reach the Kroger API from tests, whatever .env says.
    monkeypatch.setattr(settings, "kroger_client_id", "")
    monkeypatch.setattr(settings, "kroger_client_secret", "")


@pytest.fixture
def no_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    """Let mock hostnames through the public-address check (scheme/port still checked)."""
    real = fetch._check_public_host

    async def check(url: str) -> None:
        if "example" not in url:
            await real(url)

    monkeypatch.setattr(fetch, "_check_public_host", check)


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
