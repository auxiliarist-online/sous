"""Error reporting is off without a DSN, and sends no personal data with one."""

from typing import Any

import pytest
import sentry_sdk

from app import errors


def test_off_without_a_dsn(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[Any] = []
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: calls.append(kw))
    assert errors.start_error_reporting("") is False
    assert calls == []


def test_sends_no_personal_data_or_bodies(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[Any] = []
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: calls.append(kw))
    assert errors.start_error_reporting("https://k@o1.ingest.sentry.io/1") is True
    assert calls[0]["send_default_pii"] is False
    assert calls[0]["max_request_body_size"] == "never"
    assert calls[0]["include_local_variables"] is False
    assert calls[0]["before_send"] is errors.scrub


def test_scrubs_what_a_request_carries() -> None:
    event = {
        "request": {
            "url": "https://sous/api/recipes?q=tofu",
            "method": "GET",
            "query_string": "q=tofu",
            "data": {"images": ["..."]},
            "cookies": {"a": "b"},
            "headers": {"Authorization": "Bearer t"},
        },
        "exception": {},
    }
    assert errors.scrub(event, {}) == {
        "request": {"url": "https://sous/api/recipes", "method": "GET"},
        "exception": {},
    }
    assert errors.scrub({"message": "no request"}, {}) == {"message": "no request"}
