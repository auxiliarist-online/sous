"""Unhandled API errors go to PostHog with the route and the error's type,
never its message or the request's contents; without a key nothing is set
up."""

import asyncio
import time
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import errors


@pytest.fixture(autouse=True)
def keep_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests set up reporting with fakes; put the real setting back after."""
    monkeypatch.setattr(errors, "_client", errors._client)


def test_off_without_a_key() -> None:
    assert errors.reporter("") is None


class FakePostHog:
    def __init__(self, delay: float = 0) -> None:
        self.calls: list[tuple[BaseException, dict[str, Any]]] = []
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.delay = delay

    def capture_exception(self, exc: BaseException, **kwargs: Any) -> None:
        time.sleep(self.delay)
        self.calls.append((exc, kwargs))

    def capture(self, event: str, **kwargs: Any) -> None:
        time.sleep(self.delay)
        self.events.append((event, kwargs))


def app_with(fake: FakePostHog) -> TestClient:
    app = FastAPI()
    errors.report_errors(app, fake)  # type: ignore[arg-type]

    @app.post("/boom")
    def boom() -> None:
        raise RuntimeError("upstream said: Grandma's secret stew")

    return TestClient(app, raise_server_exceptions=False)


def test_reports_the_errors_type_and_route_only() -> None:
    fake = FakePostHog()
    resp = app_with(fake).post(
        "/boom?q=tofu", json={"secret": "recipe"}, headers={"Authorization": "Bearer t"}
    )
    assert resp.status_code == 500
    exc, kwargs = fake.calls[0]
    assert isinstance(exc, errors.ApiError)
    assert str(exc) == "builtins.RuntimeError"
    assert exc.__traceback__ is not None  # where it happened
    assert kwargs["properties"] == {"route": "/boom", "method": "POST"}
    sent = repr((exc, kwargs))
    for private in ("Grandma", "tofu", "recipe", "Bearer"):
        assert private not in sent


def test_a_slow_report_doesnt_hold_up_the_response(monkeypatch: Any) -> None:
    monkeypatch.setattr(errors, "REPORT_SECONDS", 0.05)
    started = time.monotonic()
    assert app_with(FakePostHog(delay=1.0)).post("/boom").status_code == 500
    assert time.monotonic() - started < 0.9


def test_events_go_out_with_only_their_properties() -> None:
    fake = FakePostHog()
    errors.report_errors(FastAPI(), fake)  # type: ignore[arg-type]
    asyncio.run(errors.report_event("import_failed", {"reason": "blocked"}))
    assert fake.events == [
        ("import_failed", {"distinct_id": "sous-api", "properties": {"reason": "blocked"}})
    ]


def test_a_slow_event_gives_up(monkeypatch: Any) -> None:
    monkeypatch.setattr(errors, "REPORT_SECONDS", 0.05)
    errors.report_errors(FastAPI(), FakePostHog(delay=1.0))  # type: ignore[arg-type]
    started = time.monotonic()
    asyncio.run(errors.report_event("import_failed", {"reason": "blocked"}))
    assert time.monotonic() - started < 0.9


def test_no_events_without_a_key() -> None:
    errors.report_errors(FastAPI(), None)
    asyncio.run(errors.report_event("import_failed", {"reason": "blocked"}))  # no error
