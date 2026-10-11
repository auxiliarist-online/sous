"""Pricing a week's meal plan from plan_cost_inputs() rows, and the route."""

import asyncio
import json
from collections.abc import Iterator
from datetime import date
from typing import Any

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import current_user_id
from app.main import app
from app.plans import routes, store
from app.plans.cost import plan_cost
from app.recipes.store import StoreError
from tests.unit.conftest import Install

MONDAY = date(2026, 10, 12)
RICE = "ing-rice"
EGGS = "ing-eggs"


def seed(ingredient: str, cents: int, qty: float, unit: str, **extra: Any) -> dict[str, Any]:
    return {
        "ingredient_id": ingredient,
        "source": "seed",
        "price_cents": cents,
        "quantity": qty,
        "unit": unit,
        **extra,
    }


def inputs(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "budget_cents": 5000,
        "entries": [
            {
                "id": "e-1",
                "recipe_id": "r-1",
                "servings": 8,
                "recipe_servings": 4,
                "lines": [
                    {"ingredient_id": RICE, "quantity": 1, "unit": "lb"},
                    {"ingredient_id": EGGS, "quantity": 2, "unit": None},
                    {"ingredient_id": None, "quantity": None, "unit": None},
                ],
            }
        ],
        "ingredients": {RICE: {"grams_per_cup": 185, "grams_per_each": None}, EGGS: {}},
        "prices": [seed(RICE, 200, 2, "lb"), seed(EGGS, 360, 12, "each")],
    }
    return {**base, **overrides}


class TestPlanCost:
    def test_scales_each_recipe_to_the_servings_planned(self) -> None:
        cost = plan_cost(inputs(), on=MONDAY)
        # Doubled: 2 lb rice at $1/lb, 4 eggs at 30¢.
        assert cost.entries[0].cents == 200 + 120
        assert cost.total_cents == 320
        assert cost.budget_cents == 5000
        assert cost.estimated

    def test_counts_lines_it_cannot_price(self) -> None:
        cost = plan_cost(inputs(prices=[seed(RICE, 200, 2, "lb")]), on=MONDAY)
        assert (cost.entries[0].priced_lines, cost.entries[0].unpriced_lines) == (1, 2)
        assert cost.unpriced_lines == 2

    def test_unknown_servings_means_the_recipe_as_written(self) -> None:
        entry = {**inputs()["entries"][0], "recipe_servings": None}
        assert plan_cost(inputs(entries=[entry]), on=MONDAY).total_cents == 100 + 60

    def test_a_users_own_price_wins_and_is_not_an_estimate(self) -> None:
        mine = {
            **seed(RICE, 100, 2, "lb"),
            "source": "user",
            "observed_at": "2026-10-01T12:00:00+00:00",
            "valid_from": "2026-10-01",
            "valid_to": None,
        }
        entry = {**inputs()["entries"][0], "lines": inputs()["entries"][0]["lines"][:1]}
        cost = plan_cost(
            inputs(entries=[entry], prices=[seed(RICE, 200, 2, "lb"), mine]), on=MONDAY
        )
        assert cost.total_cents == 100
        assert not cost.estimated

    def test_an_empty_week(self) -> None:
        cost = plan_cost({"budget_cents": None, "entries": []}, on=MONDAY)
        assert (cost.total_cents, cost.budget_cents, cost.estimated) == (0, None, False)


class TestCostInputs:
    def test_calls_plan_cost_inputs_for_the_user(self, supabase: Install) -> None:
        seen = supabase(lambda r: httpx.Response(200, json={"entries": []}))
        assert asyncio.run(store.cost_inputs("user-1", MONDAY)) == {"entries": []}
        assert seen[0].url == "https://proj.supabase.co/rest/v1/rpc/plan_cost_inputs"
        assert json.loads(seen[0].content) == {"p_user": "user-1", "p_week": "2026-10-12"}

    def test_failures(self, supabase: Install) -> None:
        supabase(lambda r: httpx.Response(500, text="boom"))
        with pytest.raises(StoreError):
            asyncio.run(store.cost_inputs("user-1", MONDAY))


class TestRoute:
    @pytest.fixture
    def client(self, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
        calls: list[tuple[str, date]] = []

        async def fake_inputs(user_id: str, week: date) -> dict[str, Any]:
            calls.append((user_id, week))
            if week.year == 1999:
                raise StoreError("down")
            return inputs()

        monkeypatch.setattr(routes, "cost_inputs", fake_inputs)
        app.dependency_overrides[current_user_id] = lambda: "user-1"
        test_client = TestClient(app)
        test_client.calls = calls  # type: ignore[attr-defined]
        yield test_client
        app.dependency_overrides.clear()

    def test_prices_the_users_week(self, client: TestClient) -> None:
        resp = client.get("/plans/2026-10-12/cost")
        assert resp.status_code == 200
        body = resp.json()
        assert body["total_cents"] == 320
        assert body["entries"][0] == {
            "id": "e-1",
            "cents": 320,
            "priced_lines": 2,
            "unpriced_lines": 1,
        }
        assert client.calls == [("user-1", MONDAY)]  # type: ignore[attr-defined]

    def test_weeks_start_on_monday(self, client: TestClient) -> None:
        assert client.get("/plans/2026-10-13/cost").status_code == 422
        assert client.get("/plans/not-a-date/cost").status_code == 422

    def test_database_trouble(self, client: TestClient) -> None:
        assert client.get("/plans/1999-01-04/cost").status_code == 502

    def test_needs_sign_in(self) -> None:
        assert TestClient(app).get("/plans/2026-10-12/cost").status_code == 401
