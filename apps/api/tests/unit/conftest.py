import pytest

from app.recipes import fetch


@pytest.fixture(autouse=True)
def fresh_fetch_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fetch, "robots", fetch.Robots())
    monkeypatch.setattr(fetch, "throttle", fetch.Throttle(0))


@pytest.fixture
def no_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    """Let mock hostnames through the public-address check (scheme/port still checked)."""
    real = fetch._check_public_host

    async def check(url: str) -> None:
        if "example" not in url:
            await real(url)

    monkeypatch.setattr(fetch, "_check_public_host", check)
