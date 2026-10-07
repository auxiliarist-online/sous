from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.auth import current_user_id
from app.main import app
from app.recipes import routes
from app.recipes.extract import RecipeDraft
from app.recipes.fetch import FetchError, Page
from tests.helpers import RECIPE_LD, page_html


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    async def fake_fetch(url: str) -> Page:
        if "blocked" in url:
            raise FetchError("blocked", "This site blocks automated imports.")
        return Page(url=url, html=page_html(RECIPE_LD))

    saved: list[tuple[RecipeDraft, str]] = []

    async def fake_save(draft: RecipeDraft, user_id: str) -> dict[str, Any]:
        saved.append((draft, user_id))
        return {
            "recipe_id": "r-1",
            "created": True,
            "visibility": "private",
            "status": "needs_review",
        }

    monkeypatch.setattr(routes, "fetch_page", fake_fetch)
    monkeypatch.setattr(routes, "save_recipe", fake_save)
    app.dependency_overrides[current_user_id] = lambda: "user-1"
    test_client = TestClient(app)
    test_client.saved = saved  # type: ignore[attr-defined]
    yield test_client
    app.dependency_overrides.clear()


def test_import_saves_the_recipe_for_the_user(client: TestClient) -> None:
    resp = client.post("/recipes/import", json={"url": "example-blog.com/tacos/"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["recipe_id"] == "r-1"
    assert body["title"] == "Weeknight Black Bean Tacos"
    assert body["source_name"] == "Example Blog"
    draft, user = client.saved[0]  # type: ignore[attr-defined]
    assert user == "user-1"
    assert draft.source_url == "https://example-blog.com/tacos/"


def test_import_explains_why_a_page_cant_be_imported(client: TestClient) -> None:
    resp = client.post("/recipes/import", json={"url": "https://blocked.example/tacos/"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "blocked"


def test_import_requires_sign_in() -> None:
    resp = TestClient(app).post("/recipes/import", json={"url": "https://example.com/"})
    assert resp.status_code == 401
