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
