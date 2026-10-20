"""The user's grocery store (TYL-19): lookup, choice and the Kroger client."""

import json
from collections.abc import Iterator
from typing import Any

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import current_user_id
from app.main import app
from app.pricing.kroger import Kroger, Location, parse_location
from app.stores import routes
from tests.unit.conftest import Install

ARCTIC = Location("09700181", "HART", "Harris Teeter - Arctic Avenue", "2800 Arctic Ave",
                  "Virginia Beach", "VA", "23451")  # fmt: skip
HOLLAND = Location("02900540", "KROGER", "Kroger Marketplace - Holland Road", "3901 Holland Rd",
                   "Virginia Beach", "VA", "23452")  # fmt: skip


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    calls: list[tuple[str, tuple[Any, ...]]] = []

    def fake(call: str, *args: Any) -> Any:
        calls.append((call, args))
        if args and args[0] == "99999":
            raise httpx.ConnectError("down")
        if call == "stores_near":
            return [ARCTIC, HOLLAND]
        return {"09700181": ARCTIC, "02900540": HOLLAND}.get(args[0])

    monkeypatch.setattr(routes, "_kroger", fake)
    app.dependency_overrides[current_user_id] = lambda: "user-1"
    test_client = TestClient(app)
    test_client.calls = calls  # type: ignore[attr-defined]
    yield test_client
    app.dependency_overrides.clear()


def test_chains_share_matches_except_harris_teeter() -> None:
    assert routes.chain_slug("HART") == "harris_teeter"
    assert routes.chain_slug("KROGER") == "kroger"
    assert routes.chain_slug("RALPHS") == "kroger"


def test_finds_stores_near_a_zip(client: TestClient) -> None:
    resp = client.get("/stores/nearby", params={"zip": "23451"})
    assert resp.status_code == 200
    assert [(s["name"], s["chain_slug"]) for s in resp.json()] == [
        ("Harris Teeter - Arctic Avenue", "harris_teeter"),
        ("Kroger Marketplace - Holland Road", "kroger"),
    ]
    assert client.calls == [("stores_near", ("23451",))]  # type: ignore[attr-defined]


def test_a_zip_is_five_digits_and_kroger_trouble_says_so(client: TestClient) -> None:
    assert client.get("/stores/nearby", params={"zip": "2345"}).status_code == 422
    assert client.get("/stores/nearby", params={"zip": "abcde"}).status_code == 422
    assert client.get("/stores/nearby", params={"zip": "99999"}).status_code == 502


def test_chooses_a_store_checked_with_kroger(client: TestClient, supabase: Install) -> None:
    seen = supabase(lambda r: httpx.Response(200, json=None))
    resp = client.put("/stores/mine", json={"location_id": "02900540"})
    assert resp.status_code == 200
    assert resp.json()["store"]["chain_slug"] == "kroger"
    assert seen[0].url.path.endswith("/rpc/set_my_store")
    assert json.loads(seen[0].content) == {
        "p_user": "user-1",
        "p_chain": "kroger",
        "p_name": "Kroger Marketplace - Holland Road",
        "p_address": "3901 Holland Rd, Virginia Beach, VA",
        "p_zip": "23452",
        "p_location_id": "02900540",
    }


def test_an_unknown_or_malformed_store_is_refused(client: TestClient, supabase: Install) -> None:
    seen = supabase(lambda r: httpx.Response(200, json=None))
    assert client.put("/stores/mine", json={"location_id": "12345678"}).status_code == 404
    assert client.put("/stores/mine", json={"location_id": "../x"}).status_code == 422
    assert client.put("/stores/mine", json={"location_id": "99999"}).status_code == 502
    assert seen == []


def test_says_which_store_prices_come_from(client: TestClient, supabase: Install) -> None:
    store = {"name": "Kroger Marketplace - Holland Road", "chain_slug": "kroger"}
    supabase(lambda r: httpx.Response(200, json=[{"stores": store}]))
    assert client.get("/stores/mine").json() == {"store": store}
    # Without a choice there's no store: prices are estimates.
    seen = supabase(lambda r: httpx.Response(200, json=[]))
    assert client.get("/stores/mine").json() == {"store": None}
    assert len(seen) == 1


def test_takes_the_store_away(client: TestClient, supabase: Install) -> None:
    seen = supabase(lambda r: httpx.Response(204))
    assert client.delete("/stores/mine").status_code == 204
    assert seen[0].method == "PATCH"
    assert seen[0].url.params["user_id"] == "eq.user-1"
    assert json.loads(seen[0].content) == {"is_primary": False}


def test_store_routes_need_sign_in() -> None:
    plain = TestClient(app)
    assert plain.get("/stores/nearby", params={"zip": "23451"}).status_code == 401
    assert plain.get("/stores/mine").status_code == 401


def test_the_kroger_client_reads_locations() -> None:
    def handle(r: httpx.Request) -> httpx.Response:
        if r.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 1800})
        if r.url.path.endswith("/locations"):
            assert r.url.params["filter.zipCode.near"] == "23451"
            loc = {
                "locationId": "09700181",
                "chain": "HART",
                "name": "Harris Teeter - Arctic Avenue",
                "address": {
                    "addressLine1": "2800 Arctic Ave",
                    "city": "Virginia Beach",
                    "state": "VA",
                    "zipCode": "23451-1234",
                },
            }
            return httpx.Response(200, json={"data": [loc]})
        return httpx.Response(404)

    from app.config import settings

    settings.kroger_client_id, settings.kroger_client_secret = "id", "secret"
    try:
        with httpx.Client(transport=httpx.MockTransport(handle)) as c:
            kroger = Kroger(c)
            assert kroger.stores_near("23451") == [ARCTIC]
            assert kroger.store("00000000") is None
    finally:
        settings.kroger_client_id, settings.kroger_client_secret = "", ""
    assert parse_location({"locationId": 1}).location_id == "1"
