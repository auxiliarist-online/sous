"""Package sizes for items typed on the list (TYL-142)."""

from collections.abc import Iterator
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.auth import current_user_id
from app.main import app
from app.plans import routes
from app.plans.item_sizes import SizeOption, price_cents, size_options
from app.recipes.store import StoreError
from tests.unit.test_live_prices import kroger_product
from tests.unit.test_plan_cost import EGGS, INGREDIENTS, PRICES

TODAY = date(2026, 11, 8)


def eggs(pid: str, size: str, regular: float, **kw: Any) -> Any:
    return kroger_product(pid, description=f"Large Eggs {size}", size=size, regular=regular, **kw)


def test_offers_each_size_once_smallest_first_at_its_cheapest() -> None:
    products = [
        eggs("12a", "12 ct", 3.49),
        eggs("6", "6 ct", 2.19),
        eggs("12b", "12 ct", 2.99),  # the cheaper dozen stands for 12 ct
        eggs("18", "18 ct", 4.99, promo=3.99, promo_ends=date(2026, 11, 10)),
        kroger_product("x", description="Egg Noodles", size="12 oz", regular=1.5),
        eggs("lb", "1 lb", 3.0, sold_by="WEIGHT"),
        eggs("bites", "6 ct / 12 oz", 5.0),  # another unit: left out
    ]
    out = size_options("eggs", products, aisle=None, default_id=None, today=TODAY)
    assert [(o.size, o.cents, o.on_sale) for o in out] == [
        ("6 ct", 219, False),
        ("12 ct", 299, False),
        ("18 ct", 399, True),
    ]


def test_marks_the_product_sous_buys_by_default() -> None:
    products = [eggs("12a", "12 ct", 3.49), eggs("12b", "12 ct", 2.99)]
    [dozen] = size_options("eggs", products, aisle=None, default_id="12a", today=TODAY)
    assert (dozen.product_id, dozen.default, dozen.cents) == ("12a", True, 349)


def test_keeps_the_default_when_there_are_many_sizes() -> None:
    products = [eggs(str(n), f"{n} ct", n * 0.3) for n in range(2, 12)]
    out = size_options("eggs", products, aisle=None, default_id="11", today=TODAY)
    assert len(out) == 6
    assert out[-1].product_id == "11" and out[-1].default


def test_a_sale_that_ended_is_the_regular_price() -> None:
    p = eggs("12", "12 ct", 3.49, promo=2.49, promo_ends=date(2026, 11, 7))
    assert price_cents(p, TODAY) == (349, False)


class TestRoutes:
    @pytest.fixture
    def client(self, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
        async def fake_sizes(user_id: str, name: str, today: date) -> dict[str, Any]:
            if name == "boom":
                raise StoreError("down")
            return {
                "ingredient_id": EGGS,
                "sizes": [SizeOption("12a", "12 ct", 349, False, default=True)],
            }

        async def fake_picked(
            user_id: str, product_ids: list[str], today: date
        ) -> dict[str, tuple[int, bool]]:
            return {"18": (399, True)} if "18" in product_ids else {}

        async def fake_match(candidates: list[str]) -> str | None:
            return EGGS

        async def fake_inputs(
            user_id: str,
            week: date,
            candidates: list[str] | None = None,
            extra: list[str] | None = None,
        ) -> dict[str, Any]:
            return {"entries": [], "ingredients": INGREDIENTS, "prices": PRICES}

        monkeypatch.setattr(routes, "item_sizes", fake_sizes)
        monkeypatch.setattr(routes, "picked_prices", fake_picked)
        monkeypatch.setattr(routes, "match_ingredient", fake_match)
        monkeypatch.setattr(routes, "cost_inputs", fake_inputs)
        app.dependency_overrides[current_user_id] = lambda: "user-1"
        yield TestClient(app)
        app.dependency_overrides.clear()

    def test_lists_sizes(self, client: TestClient) -> None:
        resp = client.post("/plans/item-sizes", json={"name": "eggs"})
        assert resp.status_code == 200
        assert resp.json() == {
            "ingredient_id": EGGS,
            "sizes": [
                {
                    "product_id": "12a",
                    "size": "12 ct",
                    "cents": 349,
                    "on_sale": False,
                    "default": True,
                }
            ],
        }
        assert client.post("/plans/item-sizes", json={"name": ""}).status_code == 422
        assert client.post("/plans/item-sizes", json={"name": "boom"}).status_code == 502

    def test_prices_a_picked_size_as_that_product(self, client: TestClient) -> None:
        resp = client.post(
            "/plans/2026-10-12/own-items",
            json={
                "items": [
                    {"id": "a", "name": "eggs", "product_id": "18"},
                    {"id": "b", "name": "eggs"},
                ]
            },
        )
        body = resp.json()
        assert [(i["id"], i["cents"], i["on_sale"]) for i in body["items"]] == [
            ("a", 399, True),
            ("b", 360, False),
        ]
        assert body["total_cents"] == 759
        bad = {"items": [{"id": "a", "name": "eggs", "product_id": "not-an-id"}]}
        assert client.post("/plans/2026-10-12/own-items", json=bad).status_code == 422

    def test_needs_sign_in(self) -> None:
        assert TestClient(app).post("/plans/item-sizes", json={"name": "x"}).status_code == 401
