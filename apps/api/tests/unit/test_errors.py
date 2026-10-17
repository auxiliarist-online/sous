"""Unhandled API errors go to PostHog with the route and the error's type,
never its message or the request's contents; without a key nothing is set
up."""

import time
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import errors


def test_off_without_a_key() -> None:
    assert errors.reporter("") is None


class FakePostHog:
    def __init__(self, delay: float = 0) -> None:
        self.calls: list[tuple[BaseException, dict[str, Any]]] = []
        self.delay = delay

    def capture_exception(self, exc: BaseException, **kwargs: Any) -> None:
        time.sleep(self.delay)
        self.calls.append((exc, kwargs))


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
