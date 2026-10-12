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
from app.plans.cost import Item, PlanCost, plan_cost
from app.recipes.store import StoreError
from tests.unit.conftest import Install

MONDAY = date(2026, 10, 12)
RICE, EGGS, CARROTS, SALT, BASIL = "rice", "eggs", "carrots", "salt", "basil"

INGREDIENTS: dict[str, dict[str, Any]] = {
    RICE: {
        "name": "white rice",
        "aisle": "pantry",
        "grams_per_cup": 185,
        "sold_by": "package",
        "package_quantity": 2,
        "package_unit": "lb",
    },
    EGGS: {
        "name": "eggs",
        "aisle": "dairy_eggs",
        "grams_per_each": 50,
        "sold_by": "package",
        "package_quantity": 12,
        "package_unit": "each",
    },
    CARROTS: {"name": "carrots", "aisle": "produce", "grams_per_cup": 128, "sold_by": "loose"},
    SALT: {
        "name": "salt",
        "aisle": "spices",
        "sold_by": "package",
        "package_quantity": 26,
        "package_unit": "oz",
        "pantry_staple": True,
    },
    BASIL: {
        "name": "basil",
        "aisle": "produce",
        "sold_by": "package",
        "package_quantity": 1,
        "package_unit": "each",
    },
}


def seed(ingredient: str, cents: int, qty: float, unit: str, **extra: Any) -> dict[str, Any]:
    return {
        "ingredient_id": ingredient,
        "source": "seed",
        "price_cents": cents,
        "quantity": qty,
        "unit": unit,
        **extra,
    }


PRICES = [
    seed(RICE, 200, 1, "lb"),
    seed(EGGS, 360, 12, "each"),
    seed(CARROTS, 100, 1, "lb"),
    seed(SALT, 130, 26, "oz"),
    seed(BASIL, 250, 1, "each"),
]


def line(ingredient: str | None, quantity: float | None, unit: str | None) -> dict[str, Any]:
    return {"ingredient_id": ingredient, "quantity": quantity, "unit": unit, "raw_text": "x"}


def entry(lines: list[dict[str, Any]], scale: float = 1, id_: str = "e") -> dict[str, Any]:
    return {"id": id_, "recipe_id": "r", "scale": scale, "lines": lines}


def cost_of(*entries: dict[str, Any], pantry: dict[str, str] | None = None) -> PlanCost:
    ingredients = {k: {**v, "pantry": (pantry or {}).get(k)} for k, v in INGREDIENTS.items()}
    return plan_cost(
        {
            "budget_cents": 5000,
            "entries": list(entries),
            "ingredients": ingredients,
            "prices": PRICES,
        },
        on=MONDAY,
    )


def item(cost: PlanCost, name: str) -> Item:
    return next(i for i in cost.items if i.name == name)


class TestPlanCost:
    def test_packages_round_up_across_the_week(self) -> None:
        # 1 cup + 1.5 cups of rice (185 g/cup) is about 1 lb: one 2 lb bag.
        cost = cost_of(entry([line(RICE, 1, "cup")]), entry([line(RICE, 1.5, "cups")]))
        rice = item(cost, "white rice")
        assert rice.packages == 1
        assert rice.cents == 400  # the whole bag, not the 1 lb used
        assert rice.leftover == pytest.approx(2 - 2.5 * 185 / 453.592, abs=0.01)
        assert cost.total_cents == 400
        assert cost.budget_cents == 5000

    def test_doubling_a_recipe_can_need_another_package(self) -> None:
        cost = cost_of(entry([line(EGGS, 8, None)], scale=2))
        eggs = item(cost, "eggs")
        assert (eggs.quantity, eggs.packages, eggs.cents) == (16, 2, 720)

    def test_halving_a_recipe(self) -> None:
        cost = cost_of(entry([line(CARROTS, 2, "lb")], scale=0.5))
        assert item(cost, "carrots").cents == 100

    def test_loose_items_cost_what_is_used(self) -> None:
        cost = cost_of(entry([line(CARROTS, 1.5, "lb")]), entry([line(CARROTS, 1, "cup")]))
        carrots = item(cost, "carrots")
        assert carrots.packages is None
        assert carrots.quantity == pytest.approx(1.5 + 128 / 453.592)
        assert carrots.cents == round(100 * (1.5 + 128 / 453.592))

    def test_staples_are_on_hand_until_the_pantry_says_otherwise(self) -> None:
        salted = entry([line(SALT, 0.125, "tsp"), line(RICE, 1, "lb")])
        cost = cost_of(salted)
        salt = item(cost, "salt")
        assert (salt.buy, salt.cents) == (False, None)
        assert cost.total_cents == 200 * 2  # just the rice
        out = cost_of(salted, pantry={SALT: "out"})
        assert item(out, "salt").cents == 130  # a whole container, not ⅛ tsp
        have = cost_of(salted, pantry={RICE: "have"})
        assert have.total_cents == 0

    def test_an_unknown_amount_still_buys_one_package(self) -> None:
        cost = cost_of(entry([line(BASIL, None, None)]))
        basil = item(cost, "basil")
        assert (basil.amount_unknown, basil.packages, basil.cents) == (True, 1, 250)

    def test_lists_what_it_cannot_price(self) -> None:
        cost = cost_of(
            entry([line(CARROTS, 2, "clove"), line(None, None, None), line(CARROTS, None, None)])
        )
        carrots = item(cost, "carrots")
        assert carrots.amount_unknown and carrots.cents is None
        assert [i.name for i in cost.items] == ["carrots", "x"]
        assert cost.unpriced == 2

    def test_an_empty_week(self) -> None:
        cost = plan_cost({"budget_cents": None, "entries": []}, on=MONDAY)
        assert (cost.total_cents, cost.budget_cents, cost.estimated, cost.items) == (
            0,
            None,
            False,
            [],
        )

    def test_a_users_own_price_is_not_an_estimate(self) -> None:
        mine = {
            **seed(CARROTS, 80, 1, "lb"),
            "source": "user",
            "observed_at": "2026-10-01T12:00:00+00:00",
            "valid_from": "2026-10-01",
            "valid_to": None,
        }
        cost = plan_cost(
            {
                "entries": [entry([line(CARROTS, 1, "lb")])],
                "ingredients": INGREDIENTS,
                "prices": [*PRICES, mine],
            },
            on=MONDAY,
        )
        assert (cost.total_cents, cost.estimated) == (80, False)


class TestIngredientUnits:
    """Units that belong to one ingredient (ingredient_units): cloves, bunches."""

    GARLIC = {
        "name": "garlic",
        "aisle": "produce",
        "grams_per_cup": 136,
        "grams_per_each": 50,
        "sold_by": "package",
        "package_quantity": 1,
        "package_unit": "each",
        "units": {"clove": 3, "head": 50},
    }
    SCALLIONS = {
        "name": "scallions",
        "aisle": "produce",
        "grams_per_each": 15,
        "sold_by": "package",
        "package_quantity": 1,
        "package_unit": "bunch",
        "units": {"bunch": 100},
    }

    def cost(self, *lines: dict[str, Any]) -> PlanCost:
        return plan_cost(
            {
                "entries": [entry(list(lines))],
                "ingredients": {"garlic": self.GARLIC, "scallions": self.SCALLIONS},
                "prices": [seed("garlic", 60, 1, "each"), seed("scallions", 300, 1, "lb")],
            },
            on=MONDAY,
        )

    def test_cloves_add_up_to_a_head(self) -> None:
        garlic = item(self.cost(line("garlic", 3, "clove"), line("garlic", 1, "tbsp")), "garlic")
        # 3 cloves (9 g) + 1 tbsp minced (136/16 = 8.5 g) = 17.5 g of a 50 g head.
        assert garlic.quantity == pytest.approx(17.5 / 50, abs=1e-4)
        assert (garlic.packages, garlic.cents) == (1, 60)

    def test_counted_scallions_buy_bunches_not_one_bunch_each(self) -> None:
        scallions = item(self.cost(line("scallions", 6, None)), "scallions")
        # 6 scallions x 15 g = 90 g: one 100 g bunch, priced by weight.
        assert scallions.packages == 1
        assert scallions.cents == round(300 * 100 / 453.592)
        more = item(self.cost(line("scallions", 2, "bunch")), "scallions")
        assert more.packages == 2


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
            return {
                "budget_cents": 5000,
                "entries": [entry([line(EGGS, 2, None)], id_="e-1")],
                "ingredients": INGREDIENTS,
                "prices": PRICES,
            }

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
        assert body["total_cents"] == 360
        assert body["items"][0]["name"] == "eggs"
        assert body["items"][0]["packages"] == 1
        assert client.calls == [("user-1", MONDAY)]  # type: ignore[attr-defined]

    def test_weeks_start_on_monday(self, client: TestClient) -> None:
        assert client.get("/plans/2026-10-13/cost").status_code == 422
        assert client.get("/plans/not-a-date/cost").status_code == 422

    def test_database_trouble(self, client: TestClient) -> None:
        assert client.get("/plans/1999-01-04/cost").status_code == 502

    def test_needs_sign_in(self) -> None:
        assert TestClient(app).get("/plans/2026-10-12/cost").status_code == 401
