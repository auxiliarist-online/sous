"""Live Harris Teeter prices for a plan (TYL-80)."""

import asyncio
import copy
from typing import Any

import httpx2 as httpx
import pytest

from app.config import settings
from app.plans import live_prices
from app.plans.cost import plan_cost
from app.plans.live_prices import add_live_prices
from app.pricing.kroger import Product
from tests.unit.conftest import Install
from tests.unit.test_plan_cost import CARROTS, EGGS, INGREDIENTS, MONDAY, PRICES, entry, line

STORE = {
    "id": "store-ht",
    "name": "Harris Teeter – Village at Chestnut Street",
    "external_location_id": "09700348",
}
MATCHES = [
    {"ingredient_id": EGGS, "product_id": "0007203663218"},
    {"ingredient_id": CARROTS, "product_id": "0001111091637"},
]


def kroger_product(pid: str, **kw: Any) -> Product:
    base: dict[str, Any] = {
        "product_id": pid,
        "description": "x",
        "brand": "Harris Teeter",
        "size": "18 ct",
        "sold_by": "UNIT",
        "regular": 2.79,
        "promo": None,
        "promo_ends": None,
        "in_store": True,
    }
    return Product(**{**base, **kw})


EGGS_18 = kroger_product("0007203663218", promo=1.99, promo_ends="2026-10-14T03:59:59.999Z")
CARROTS_LB = kroger_product("0001111091637", size="1 lb", sold_by="WEIGHT", regular=1.69)


def inputs() -> dict[str, Any]:
    return {
        "budget_cents": 5000,
        "entries": [entry([line(EGGS, 20, None), line(CARROTS, 2, "lb")])],
        "ingredients": copy.deepcopy(INGREDIENTS),
        "prices": list(PRICES),
    }


@pytest.fixture
def db(supabase: Install, monkeypatch: pytest.MonkeyPatch) -> list[httpx.Request]:
    monkeypatch.setattr(settings, "kroger_client_id", "id")

    def handle(r: httpx.Request) -> httpx.Response:
        if r.url.path.endswith("/user_stores"):
            return httpx.Response(200, json=[])  # no store picked
        if r.url.path.endswith("/stores"):
            return httpx.Response(200, json=[STORE])
        return httpx.Response(200, json=MATCHES)

    return supabase(handle)


def fetched(monkeypatch: pytest.MonkeyPatch, *products: Product) -> list[list[str]]:
    asked: list[list[str]] = []

    def fetch(ids: list[str], location: str) -> list[Product]:
        assert location == "09700348"
        asked.append(ids)
        return list(products)

    monkeypatch.setattr(live_prices, "_fetch", fetch)
    return asked


def test_prices_the_week_at_todays_store_prices(
    db: list[httpx.Request], monkeypatch: pytest.MonkeyPatch
) -> None:
    asked = fetched(monkeypatch, EGGS_18, CARROTS_LB)
    plan = inputs()
    store_id = asyncio.run(add_live_prices("user-1", plan))
    assert store_id == "store-ht"
    assert asked == [["0007203663218", "0001111091637"]]
    cost = plan_cost(plan, on=MONDAY, store_id=store_id)
    eggs = next(i for i in cost.items if i.name == "eggs")
    # The store sells 18s, not our guessed dozen: 20 eggs is two packs, on sale.
    assert (eggs.package_quantity, eggs.packages, eggs.cents) == (18, 2, 398)
    assert eggs.on_sale and not eggs.estimated
    carrots = next(i for i in cost.items if i.name == "carrots")
    assert (carrots.sold_by, carrots.cents, carrots.on_sale) == ("loose", 338, False)
    assert cost.store_name == STORE["name"]


def test_after_the_sale_ends_the_regular_price(
    db: list[httpx.Request], monkeypatch: pytest.MonkeyPatch
) -> None:
    fetched(monkeypatch, EGGS_18)
    plan = inputs()
    store_id = asyncio.run(add_live_prices("user-1", plan))
    later = plan_cost(plan, on=MONDAY.replace(day=19), store_id=store_id)
    eggs = next(i for i in later.items if i.name == "eggs")
    assert (eggs.cents, eggs.on_sale) == (558, False)


def test_unmatched_ingredients_keep_their_estimates(
    db: list[httpx.Request], monkeypatch: pytest.MonkeyPatch
) -> None:
    fetched(monkeypatch, EGGS_18)
    plan = inputs()
    cost = plan_cost(plan, on=MONDAY, store_id=asyncio.run(add_live_prices("user-1", plan)))
    carrots = next(i for i in cost.items if i.name == "carrots")
    assert carrots.cents == 200  # the seed price, still there


def test_kroger_down_means_estimates(
    db: list[httpx.Request], monkeypatch: pytest.MonkeyPatch
) -> None:
    def down(ids: list[str], location: str) -> list[Product]:
        raise httpx.ConnectError("down")

    monkeypatch.setattr(live_prices, "_fetch", down)
    plan = inputs()
    assert asyncio.run(add_live_prices("user-1", plan)) is None
    assert plan == inputs()


def test_the_users_own_store_comes_first(
    supabase: Install, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "kroger_client_id", "id")
    mine = {**STORE, "id": "store-mine"}

    def handle(r: httpx.Request) -> httpx.Response:
        if r.url.path.endswith("/user_stores"):
            assert r.url.params["user_id"] == "eq.user-1"
            return httpx.Response(200, json=[{"stores": mine}])
        assert not r.url.path.endswith("/stores"), "no need for the default"
        assert r.url.params["store_id"] == "eq.store-mine"
        return httpx.Response(200, json=MATCHES)

    seen = supabase(handle)
    fetched(monkeypatch, EGGS_18)
    assert asyncio.run(add_live_prices("user-1", inputs())) == "store-mine"
    assert len(seen) == 2


def test_without_credentials_nothing_is_called(supabase: Install) -> None:
    seen = supabase(lambda r: httpx.Response(500))
    assert asyncio.run(add_live_prices("user-1", inputs())) is None
    assert seen == []
