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
from app.plans.cost import Item, PlanCost, added_costs, plan_cost
from app.recipes.store import StoreError
from tests.unit.conftest import Install

MONDAY = date(2026, 10, 12)
RICE, EGGS, CARROTS, SALT, BASIL = "rice", "eggs", "carrots", "salt", "basil"
R1 = "11111111-1111-1111-1111-111111111111"

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


def entry(
    lines: list[dict[str, Any]], scale: float = 1, id_: str = "e", **extra: Any
) -> dict[str, Any]:
    return {"id": id_, "recipe_id": "r", "scale": scale, "lines": lines, **extra}


def inputs_of(
    *entries: dict[str, Any],
    pantry: dict[str, str] | None = None,
    prices: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    ingredients = {k: {**v, "pantry": (pantry or {}).get(k)} for k, v in INGREDIENTS.items()}
    return {
        "budget_cents": 5000,
        "entries": list(entries),
        "ingredients": ingredients,
        "prices": PRICES if prices is None else prices,
    }


def cost_of(*entries: dict[str, Any], pantry: dict[str, str] | None = None) -> PlanCost:
    return plan_cost(inputs_of(*entries, pantry=pantry), on=MONDAY)


def item(cost: PlanCost, name: str) -> Item:
    return next(i for i in cost.items if i.name == name)


class TestPlanCost:
    def test_fresh_produce_with_a_dried_form_says_fresh(self) -> None:
        cost = cost_of(entry([line(BASIL, 1, "bunch"), line(RICE, 1, "cup")]))
        names = {i.name for i in cost.items}
        assert "fresh basil" in names
        assert "white rice" in names

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

    def test_only_what_the_pantry_says_is_on_hand_is_left_off(self) -> None:
        # TYL-88: nothing is assumed on hand, staples included.
        salted = entry([line(SALT, 0.125, "tsp"), line(RICE, 1, "lb")])
        cost = cost_of(salted)
        salt = item(cost, "salt")
        assert (salt.buy, salt.cents, salt.staple) == (True, 130, True)  # a container
        assert cost.total_cents == 130 + 200 * 2
        have = cost_of(salted, pantry={SALT: "have"})
        assert (item(have, "salt").buy, have.total_cents) == (False, 200 * 2)
        # "out" is the default now: bought.
        assert cost_of(salted, pantry={SALT: "out"}).total_cents == cost.total_cents

    def test_an_unknown_amount_still_buys_one_package(self) -> None:
        cost = cost_of(entry([line(BASIL, None, None)]))
        basil = item(cost, "fresh basil")
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


class TestBoughtAs:
    """Egg yolks aren't sold on their own: they're bought as eggs."""

    YOLKS = {
        "name": "egg yolks",
        "aisle": "dairy_eggs",
        "grams_per_each": 17,
        "sold_by": "package",
        "package_quantity": 12,
        "package_unit": "each",
        "buy_as": EGGS,
        "buy_ratio": 2.94,
    }

    def cost(self, *entries: dict[str, Any]) -> PlanCost:
        return plan_cost(
            {
                "entries": list(entries),
                "ingredients": {EGGS: INGREDIENTS[EGGS], "yolks": self.YOLKS},
                "prices": PRICES,
            },
            on=MONDAY,
        )

    def test_yolks_are_bought_as_eggs_and_merge_with_other_eggs(self) -> None:
        cost = self.cost(entry([line("yolks", 5, None)]), entry([line(EGGS, 8, None)]))
        assert [i.name for i in cost.items] == ["eggs"]
        eggs = cost.items[0]
        # 5 yolks x 17 g x 2.94 = 250 g = 5 eggs, plus 8 eggs: 13 eggs, 2 dozen.
        assert eggs.quantity == pytest.approx(13, abs=0.01)
        assert (eggs.packages, eggs.cents) == (2, 720)

    def test_the_planned_size_applies_once(self) -> None:
        cost = self.cost(entry([line("yolks", 5, None)], scale=2))
        assert cost.items[0].quantity == pytest.approx(10, abs=0.01)

    def test_unknown_amount_buys_a_package_of_the_source(self) -> None:
        eggs = self.cost(entry([line("yolks", None, None)])).items[0]
        assert (eggs.name, eggs.amount_unknown, eggs.packages) == ("eggs", True, 1)


class TestShares:
    def test_each_recipe_gets_its_share_and_they_add_up(self) -> None:
        # A 2 lb bag of rice ($4): one recipe uses 2 cups, the other 1 cup.
        cost = cost_of(
            entry([line(RICE, 2, "cups"), line(CARROTS, 1, "lb")], id_="a"),
            entry([line(RICE, 1, "cup")], id_="b"),
        )
        shares = {e.entry_id: e.cents for e in cost.entries}
        assert shares == {"a": 267 + 100, "b": 133}
        assert sum(shares.values()) == cost.total_cents

    def test_an_unknown_amount_splits_evenly(self) -> None:
        cost = cost_of(
            entry([line(EGGS, None, None)], id_="a"),
            entry([line(EGGS, 2, None)], id_="b"),
            entry([line(EGGS, 1, None)], id_="c"),
        )
        shares = {e.entry_id: e.cents for e in cost.entries}
        assert shares == {"a": 120, "b": 120, "c": 120}

    def test_whats_on_hand_costs_nothing(self) -> None:
        cost = cost_of(entry([line(SALT, 1, "tsp")], id_="a"), pantry={SALT: "have"})
        assert [(e.entry_id, e.cents) for e in cost.entries] == [("a", 0)]


class TestPriceSource:
    def test_says_where_each_price_came_from(self) -> None:
        prices = [
            seed(RICE, 200, 1, "lb"),
            {**seed(EGGS, 300, 12, "each"), "source": "user"},
            {**seed(CARROTS, 150, 1, "lb"), "source": "store_api", "store_id": "s"},
        ]
        cost = plan_cost(
            inputs_of(
                entry([line(RICE, 1, "cup"), line(EGGS, 2, None), line(CARROTS, 1, "lb")]),
                prices=prices,
            ),
            on=MONDAY,
            store_id="s",
        )
        assert [(i.name, i.price_source, i.estimated) for i in cost.items] == [
            ("eggs", "user", False),
            ("white rice", "estimate", True),
            ("carrots", "store", False),
        ]
        assert cost.store_id == "s"

    def test_a_users_price_per_bunch_is_priced_by_weight(self) -> None:
        # TYL-34: the user says a bunch of cilantro is $1.29 at their store.
        cilantro = {
            "name": "cilantro",
            "aisle": "produce",
            "sold_by": "package",
            "package_quantity": 1,
            "package_unit": "bunch",
            "units": {"bunch": 60},
        }
        user_price = {**seed("cilantro", 129, 1, "bunch"), "source": "user"}
        cost = plan_cost(
            {
                "entries": [entry([line("cilantro", 0.5, "bunch")])],
                "ingredients": {"cilantro": cilantro},
                "prices": [user_price],
            },
            on=MONDAY,
        )
        assert (cost.items[0].cents, cost.items[0].price_source) == (129, "user")


class TestAddedCosts:
    def test_a_recipe_adds_what_the_week_would_newly_buy(self) -> None:
        planned = entry([line(RICE, 1, "cup")], id_="p")
        # More rice still fits in the bag already bought; carrots are new.
        rice_more = entry([line(RICE, 1, "cup")], id_="c1", recipe_id="more-rice", candidate=True)
        carrots = entry([line(CARROTS, 2, "lb")], id_="c2", recipe_id="carrots", candidate=True)
        unknown = entry([line(None, 1, "cup")], id_="c3", recipe_id="mystery", candidate=True)
        inputs = inputs_of(planned, rice_more, carrots, unknown)
        added = {a.recipe_id: a for a in added_costs(inputs, on=MONDAY)}
        assert {k: a.cents for k, a in added.items()} == {
            "more-rice": 0,
            "carrots": 200,
            "mystery": 0,
        }
        assert added["mystery"].unpriced and not added["carrots"].unpriced
        assert added["carrots"].estimated and not added["more-rice"].estimated

    def test_unmarked_staples_are_counted_and_said(self) -> None:
        salted = entry(
            [line(CARROTS, 2, "lb"), line(SALT, 1, "tsp")], id_="c", recipe_id="r", candidate=True
        )
        (unmarked,) = added_costs(inputs_of(salted), on=MONDAY)
        assert unmarked.staples_cents > 0
        assert unmarked.cents == 200 + unmarked.staples_cents
        # Marked on hand, salt is neither bought nor mentioned.
        (have,) = added_costs(inputs_of(salted, pantry={SALT: "have"}), on=MONDAY)
        assert (have.cents, have.staples_cents) == (200, 0)
        # Marked out, buying it is expected: no "staples" note.
        (out,) = added_costs(inputs_of(salted, pantry={SALT: "out"}), on=MONDAY)
        assert out.cents == unmarked.cents and out.staples_cents == 0

    def test_candidates_are_left_out_of_the_week(self) -> None:
        cost = plan_cost(
            inputs_of(
                entry([line(RICE, 1, "cup")], id_="p"),
                entry([line(CARROTS, 2, "lb")], id_="c", candidate=True),
            ),
            on=MONDAY,
        )
        assert cost.total_cents == 400
        assert [e.entry_id for e in cost.entries] == ["p"]


class TestCostInputs:
    def test_calls_plan_cost_inputs_for_the_user(self, supabase: Install) -> None:
        seen = supabase(lambda r: httpx.Response(200, json={"entries": []}))
        assert asyncio.run(store.cost_inputs("user-1", MONDAY)) == {"entries": []}
        assert seen[0].url == "https://proj.supabase.co/rest/v1/rpc/plan_cost_inputs"
        assert json.loads(seen[0].content) == {"p_user": "user-1", "p_week": "2026-10-12"}

    def test_asks_for_candidates_when_there_are_some(self, supabase: Install) -> None:
        seen = supabase(lambda r: httpx.Response(200, json={"entries": []}))
        asyncio.run(store.cost_inputs("user-1", MONDAY, ["r-1", "r-2"]))
        assert json.loads(seen[0].content)["p_candidates"] == ["r-1", "r-2"]

    def test_failures(self, supabase: Install) -> None:
        supabase(lambda r: httpx.Response(500, text="boom"))
        with pytest.raises(StoreError):
            asyncio.run(store.cost_inputs("user-1", MONDAY))


class TestRoute:
    @pytest.fixture
    def client(self, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
        calls: list[tuple[str, date]] = []

        async def fake_inputs(
            user_id: str, week: date, candidates: list[str] | None = None
        ) -> dict[str, Any]:
            calls.append((user_id, week))
            if week.year == 1999:
                raise StoreError("down")
            extra = [
                entry([line(CARROTS, 1, "lb")], id_=f"c-{r}", recipe_id=r, candidate=True)
                for r in candidates or []
            ]
            return {
                "budget_cents": 5000,
                "entries": [entry([line(EGGS, 2, None)], id_="e-1"), *extra],
                "ingredients": INGREDIENTS,
                "prices": PRICES,
            }

        async def no_store(user_id: str) -> dict[str, Any]:
            return {"store_status": "none_nearby", "home_zip": "02139"}

        monkeypatch.setattr(routes, "cost_inputs", fake_inputs)
        monkeypatch.setattr(routes, "no_store", no_store)
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
        assert body["items"][0]["price_source"] == "estimate"
        assert body["entries"] == [{"entry_id": "e-1", "cents": 360}]
        assert client.calls == [("user-1", MONDAY)]  # type: ignore[attr-defined]
        # No store's prices were used, and the page is told why.
        assert (body["store_status"], body["home_zip"]) == ("none_nearby", "02139")

    def test_says_what_each_recipe_would_add(self, client: TestClient) -> None:
        resp = client.post("/plans/2026-10-12/added", json={"recipe_ids": [R1, R1]})
        assert resp.status_code == 200
        assert resp.json() == {
            "budget_cents": 5000,
            "total_cents": 360,
            "recipes": [
                {
                    "recipe_id": R1,
                    "cents": 100,
                    "unpriced": False,
                    "estimated": True,
                    "staples_cents": 0,
                }
            ],
        }

    def test_added_needs_some_recipes_and_not_too_many(self, client: TestClient) -> None:
        assert client.post("/plans/2026-10-12/added", json={"recipe_ids": []}).status_code == 422
        many = {"recipe_ids": [R1] * 101}
        assert client.post("/plans/2026-10-12/added", json=many).status_code == 422
        not_ids = {"recipe_ids": ["r-1"]}
        assert client.post("/plans/2026-10-12/added", json=not_ids).status_code == 422
        assert client.post("/plans/2026-10-13/added", json={"recipe_ids": [R1]}).status_code == 422

    def test_weeks_start_on_monday(self, client: TestClient) -> None:
        assert client.get("/plans/2026-10-13/cost").status_code == 422
        assert client.get("/plans/not-a-date/cost").status_code == 422

    def test_database_trouble(self, client: TestClient) -> None:
        assert client.get("/plans/1999-01-04/cost").status_code == 502

    def test_needs_sign_in(self) -> None:
        assert TestClient(app).get("/plans/2026-10-12/cost").status_code == 401
