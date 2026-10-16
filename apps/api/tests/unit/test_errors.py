"""Unhandled API errors go to PostHog with the route, never the request's
contents; without a key nothing is set up."""

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import errors


def test_off_without_a_key() -> None:
    assert errors.reporter("") is None


class FakePostHog:
    def __init__(self) -> None:
        self.calls: list[tuple[BaseException, dict[str, Any]]] = []

    def capture_exception(self, exc: BaseException, **kwargs: Any) -> None:
        self.calls.append((exc, kwargs))


def test_reports_an_error_with_only_its_route() -> None:
    app = FastAPI()
    fake = FakePostHog()
    errors.report_errors(app, fake)  # type: ignore[arg-type]

    @app.post("/boom")
    def boom() -> None:
        raise RuntimeError("broke")

    resp = TestClient(app, raise_server_exceptions=False).post(
        "/boom?q=tofu", json={"secret": "recipe"}, headers={"Authorization": "Bearer t"}
    )
    assert resp.status_code == 500
    exc, kwargs = fake.calls[0]
    assert str(exc) == "broke"
    assert kwargs["properties"] == {"route": "/boom", "method": "POST"}
    assert "tofu" not in repr(kwargs) and "recipe" not in repr(kwargs)
