"""Prices for items the user adds to the shopping list themselves (TYL-146)."""

from collections.abc import Iterator
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.auth import current_user_id
from app.main import app
from app.plans import routes
from app.plans.own_items import candidates_for, price_own_items
from app.recipes.store import StoreError
from tests.unit.test_plan_cost import EGGS, INGREDIENTS, PRICES, RICE, seed

MONDAY = date(2026, 10, 12)
AVOCADO = "avocado"


def inputs(**extra: Any) -> dict[str, Any]:
    return {
        "entries": [],
        "ingredients": {
            **INGREDIENTS,
            AVOCADO: {
                "name": "avocado",
                "aisle": "produce",
                "sold_by": "loose",
                "grams_per_each": 200,
            },
        },
        "prices": [*PRICES, seed(AVOCADO, 150, 1, "each")],
        **extra,
    }


def test_a_typed_name_tries_what_a_recipe_line_would() -> None:
    assert candidates_for("Eggs")[0] in {"eggs", "egg"}
    assert "ground beef" in candidates_for("2 lb ground beef")


def test_a_matched_item_is_one_package() -> None:
    [eggs] = price_own_items([("i1", EGGS)], inputs(), on=MONDAY, store_id=None)
    assert (eggs.ingredient_id, eggs.cents, eggs.estimated) == (EGGS, 360, True)


def test_a_loose_item_is_one_of_it() -> None:
    [avocado] = price_own_items([("i1", AVOCADO)], inputs(), on=MONDAY, store_id=None)
    assert avocado.cents == 150


def test_an_unmatched_item_is_left_unpriced() -> None:
    [thing] = price_own_items([("i1", None)], inputs(), on=MONDAY, store_id=None)
    assert (thing.ingredient_id, thing.cents) == (None, None)


def test_each_item_is_priced_on_its_own() -> None:
    # Two bags of rice typed twice: two packages, not one shared one.
    priced = price_own_items([("a", RICE), ("b", RICE)], inputs(), on=MONDAY, store_id=None)
    assert [p.cents for p in priced] == [400, 400]


class TestRoute:
    @pytest.fixture
    def client(self, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
        seen: dict[str, Any] = {}

        async def fake_match(candidates: list[str]) -> str | None:
            if "boom" in candidates:
                raise StoreError("down")
            return {"eggs": EGGS, "wheat bread": RICE}.get(candidates[0]) if candidates else None

        async def fake_inputs(
            user_id: str,
            week: date,
            candidates: list[str] | None = None,
            extra: list[str] | None = None,
        ) -> dict[str, Any]:
            seen["extra"] = extra
            return inputs(entries=[{"id": "e", "scale": 1, "lines": []}])

        monkeypatch.setattr(routes, "match_ingredient", fake_match)
        monkeypatch.setattr(routes, "cost_inputs", fake_inputs)
        app.dependency_overrides[current_user_id] = lambda: "user-1"
        test_client = TestClient(app)
        test_client.seen = seen  # type: ignore[attr-defined]
        yield test_client
        app.dependency_overrides.clear()

    def test_prices_the_matched_items_and_totals_them(self, client: TestClient) -> None:
        resp = client.post(
            "/plans/2026-10-12/own-items",
            json={
                "items": [
                    {"id": "i1", "name": "Eggs"},
                    {"id": "i2", "name": "Wheat bread"},
                    {"id": "i3", "name": "veggie dogs"},
                ]
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert [(i["id"], i["cents"]) for i in body["items"]] == [
            ("i1", 360),
            ("i2", 400),
            ("i3", None),
        ]
        assert body["total_cents"] == 760
        assert client.seen["extra"] == sorted([EGGS, RICE])  # type: ignore[attr-defined]

    def test_nothing_matched_needs_no_plan(self, client: TestClient) -> None:
        resp = client.post(
            "/plans/2026-10-12/own-items", json={"items": [{"id": "i", "name": "x"}]}
        )
        assert resp.json()["total_cents"] == 0
        assert "extra" not in client.seen  # type: ignore[attr-defined]

    def test_limits_and_weeks(self, client: TestClient) -> None:
        many = {"items": [{"id": "i", "name": "eggs"}] * 101}
        assert client.post("/plans/2026-10-12/own-items", json=many).status_code == 422
        empty = {"items": [{"id": "i", "name": ""}]}
        assert client.post("/plans/2026-10-12/own-items", json=empty).status_code == 422
        eggs = {"items": [{"id": "i", "name": "eggs"}]}
        assert client.post("/plans/2026-10-13/own-items", json=eggs).status_code == 422

    def test_database_trouble(self, client: TestClient) -> None:
        resp = client.post(
            "/plans/2026-10-12/own-items", json={"items": [{"id": "i", "name": "boom"}]}
        )
        assert resp.status_code == 502

    def test_needs_sign_in(self) -> None:
        resp = TestClient(app).post("/plans/2026-10-12/own-items", json={"items": []})
        assert resp.status_code == 401
