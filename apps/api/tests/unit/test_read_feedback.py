"""The feedback script fetches every page, newest first."""

import importlib.util
from pathlib import Path
from typing import Any

import httpx2 as httpx

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "read_feedback.py"
spec = importlib.util.spec_from_file_location("read_feedback", SCRIPT)
assert spec and spec.loader
read_feedback: Any = importlib.util.module_from_spec(spec)
spec.loader.exec_module(read_feedback)


def test_fetches_every_page(monkeypatch: Any) -> None:
    monkeypatch.setattr(read_feedback, "PAGE", 2)
    rows = [{"message": str(i)} for i in range(5)]
    seen = []

    def handle(r: httpx.Request) -> httpx.Response:
        offset = int(r.url.params["offset"])
        seen.append((offset, r.url.params["order"]))
        return httpx.Response(200, json=rows[offset : offset + 2])

    with httpx.Client(base_url="https://db", transport=httpx.MockTransport(handle)) as db:
        assert read_feedback.fetch_all(db, "2026-10-01") == rows
    assert seen == [
        (0, "created_at.desc,id.desc"),
        (2, "created_at.desc,id.desc"),
        (4, "created_at.desc,id.desc"),
    ]
