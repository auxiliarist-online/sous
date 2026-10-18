"""Filing problem reports in Linear: only the reporter's own, once, with the
replay and device, and nothing filed without a Linear key."""

import json
from collections.abc import Iterator
from typing import Any

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from tests.unit.conftest import Install

REPORT = {
    "id": 7,
    "user_id": "user-1",
    "kind": "problem",
    "message": "The list is blank after I add a recipe\nIt was fine yesterday.",
    "page": "/list",
    "device": "iPhone Safari 18",
    "replay_url": "https://us.posthog.com/replay/abc",
    "linear_url": None,
    "created_at": "2026-10-16T23:00:00Z",
}


@pytest.fixture
def client() -> Iterator[TestClient]:
    from app.auth import current_user_id
    from app.main import app

    app.dependency_overrides[current_user_id] = lambda: "user-1"
    yield TestClient(app)
    app.dependency_overrides.clear()


def routes(
    report: dict[str, Any], linear_ok: bool = True, claimed: bool = True, linear_down: bool = False
) -> Any:
    def handle(r: httpx.Request) -> httpx.Response:
        if r.url.host == "api.linear.app":
            if linear_down:
                raise httpx.ConnectTimeout("timed out", request=r)
            if not linear_ok:
                return httpx.Response(200, json={"errors": [{"message": "nope"}]})
            return httpx.Response(
                200,
                json={
                    "data": {
                        "issueCreate": {
                            "success": True,
                            "issue": {"identifier": "TYL-99", "url": "https://linear.app/t/TYL-99"},
                        }
                    }
                },
            )
        if r.method == "GET":
            return httpx.Response(200, json=[report])
        if r.headers.get("prefer") == "return=representation":
            return httpx.Response(200, json=[{"id": 7}] if claimed else [])
        return httpx.Response(204)

    return handle


def test_files_a_problem_in_linear_with_its_replay(
    supabase: Install, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "linear_api_key", "lin_api_key")
    seen = supabase(routes(REPORT))
    resp = client.post("/feedback/7/file")
    assert resp.json() == {"filed": True, "url": "https://linear.app/t/TYL-99"}
    linear = next(r for r in seen if r.url.host == "api.linear.app")
    assert linear.headers["authorization"] == "lin_api_key"
    issue = json.loads(linear.content)["variables"]["input"]
    assert issue["title"] == "Beta report: The list is blank after I add a recipe"
    assert "> It was fine yesterday." in issue["description"]
    assert "(https://us.posthog.com/replay/abc)" in issue["description"]
    assert "iPhone Safari 18" in issue["description"]
    assert issue["labelIds"] == [settings.linear_bug_label_id, settings.linear_report_label_id]
    claim, done = [r for r in seen if r.method == "PATCH"]
    assert claim.url.params["linear_url"] == "is.null"
    assert json.loads(claim.content) == {"linear_url": "filing"}
    assert json.loads(done.content) == {"linear_url": "https://linear.app/t/TYL-99"}


def test_two_requests_at_once_file_it_once(
    supabase: Install, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "linear_api_key", "lin_api_key")
    seen = supabase(routes(REPORT, claimed=False))
    assert client.post("/feedback/7/file").json() == {"filed": True, "url": None}
    assert not any(r.url.host == "api.linear.app" for r in seen)
    seen = supabase(routes({**REPORT, "linear_url": "filing"}))
    assert client.post("/feedback/7/file").json() == {"filed": True, "url": None}
    assert not any(r.url.host == "api.linear.app" for r in seen)


def test_only_the_reporters_own_problem_once(
    supabase: Install, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "linear_api_key", "lin_api_key")
    supabase(routes({**REPORT, "user_id": "someone-else"}))
    assert client.post("/feedback/7/file").status_code == 404
    supabase(routes({**REPORT, "kind": "idea"}))
    assert client.post("/feedback/7/file").status_code == 400
    seen = supabase(routes({**REPORT, "linear_url": "https://linear.app/t/TYL-98"}))
    assert client.post("/feedback/7/file").json()["url"] == "https://linear.app/t/TYL-98"
    assert not any(r.url.host == "api.linear.app" for r in seen)


def test_without_a_key_or_when_linear_fails(
    supabase: Install, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "linear_api_key", "")
    supabase(routes(REPORT))
    assert client.post("/feedback/7/file").json() == {"filed": False}
    monkeypatch.setattr(settings, "linear_api_key", "lin_api_key")
    seen = supabase(routes(REPORT, linear_ok=False))
    assert client.post("/feedback/7/file").status_code == 502
    # The claim is let go, so a later try can file it.
    release = [r for r in seen if r.method == "PATCH"][-1]
    assert release.url.params["linear_url"] == "eq.filing"
    assert json.loads(release.content) == {"linear_url": None}
    # A timeout lets it go too.
    seen = supabase(routes(REPORT, linear_down=True))
    assert client.post("/feedback/7/file").status_code == 502
    assert json.loads([r for r in seen if r.method == "PATCH"][-1].content) == {"linear_url": None}


def test_needs_sign_in() -> None:
    from app.main import app

    assert TestClient(app).post("/feedback/7/file").status_code == 401
