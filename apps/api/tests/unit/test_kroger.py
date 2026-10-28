from collections.abc import Callable
from datetime import date

import httpx2 as httpx
import pytest

from app.config import settings
from app.pricing import kroger
from app.pricing.kroger import Kroger, Product, parse_product
from app.pricing.kroger_match import (
    candidates,
    choose,
    head,
    name_words,
    parse_size,
    search_term,
    words,
)

NAMES = ["butter", "peanut butter", "eggs", "egg noodles", "cumin", "carrots", "lime"]


def product(
    description: str,
    size: str = "1 ct",
    brand: str | None = None,
    regular: float | None = 2.0,
    in_store: bool = True,
    pid: str | None = None,
    categories: tuple[str, ...] = (),
) -> Product:
    return Product(
        product_id=pid or str(abs(hash((description, size))) % 10**13).zfill(13),
        description=description,
        brand=brand,
        size=size,
        sold_by="UNIT",
        regular=regular,
        promo=None,
        promo_ends=None,
        in_store=in_store,
        categories=categories,
    )


class TestWords:
    def test_plural_and_singular_find_each_other(self) -> None:
        assert name_words("eggs") <= words("Large White Egg")
        assert name_words("lime") <= words("Limes, each")
        assert name_words("tomatoes") <= words("Roma Tomato")
        assert name_words("cherries") <= words("Dark Sweet Cherry")

    @pytest.mark.parametrize(
        ("size", "parsed"),
        [
            ("12 ct", (12, "each")),
            ("large 18 ct", (18, "each")),
            ("5 lbs", (5, "lb")),
            ("2.31 oz", (2.31, "oz")),
            ("64 fl oz", (64, "fl_oz")),
            ("1 gal", (1, "gallon")),
            ("each", None),
            (None, None),
            # TYL-143: what Harris Teeter's Asheville store had unreadable.
            ("2 pk", (2, "each")),
            ("1 pk", None),  # a pack of okra: how much isn't said
            ("6-pack", (6, "each")),
            ("1 ea", (1, "each")),
            ("24 bottles/16.9 fl oz", (24 * 16.9, "fl_oz")),
            ("12 cans/12 fl oz", (144, "fl_oz")),
        ],
    )
    def test_sizes(self, size: str | None, parsed: tuple[float, str] | None) -> None:
        assert parse_size(size) == parsed


class TestChoose:
    def test_a_longer_ingredient_isnt_ours(self) -> None:
        found = candidates(
            "butter",
            [product("Jif Creamy Peanut Butter"), product("Land O Lakes Salted Butter")],
            NAMES,
        )
        assert [p.description for p in found] == ["Land O Lakes Salted Butter"]

    def test_every_word_must_be_there(self) -> None:
        assert candidates("cumin", [product("Badia Ground Black Pepper")], NAMES) == []

    def test_skips_products_not_in_the_store_or_without_a_price(self) -> None:
        found = candidates(
            "cumin",
            [product("Badia Cumin Seed", in_store=False), product("McCormick Cumin", regular=None)],
            NAMES,
        )
        assert found == []

    def test_store_brand_beats_a_name_brand(self) -> None:
        pick = choose(
            "eggs",
            [
                product("Eggland's Best Large Eggs", "12 ct", "Eggland's Best"),
                product("Harris Teeter Large Grade A White Eggs", "12 ct", "Harris Teeter"),
            ],
            NAMES,
            (12, "each"),
        )
        assert pick is not None and pick.brand == "Harris Teeter"

    def test_store_brand_by_description_when_brand_is_missing(self) -> None:
        pick = choose(
            "carrots",
            [
                product("Grimmway Carrot Sticks Bag", "12 oz", "Grimmway"),
                product("Harris Teeter Farmers Market Whole Carrots Bag", "1 lb"),
            ],
            NAMES,
        )
        assert pick is not None and pick.description.startswith("Harris Teeter")

    def test_organic_only_when_asked(self) -> None:
        offered = [
            product("Simple Truth Organic Brown Eggs", "12 ct", "Simple Truth Organic"),
            product("Highland Crest Large White Eggs", "12 ct", "Highland Crest"),
        ]
        pick = choose("eggs", offered, NAMES, (12, "each"))
        assert pick is not None and pick.brand == "Highland Crest"
        # When organic is all there is, it's still a match.
        assert choose("eggs", offered[:1], NAMES) is not None

    def test_the_closest_size_among_store_brands(self) -> None:
        pick = choose(
            "eggs",
            [
                product("Harris Teeter Large White Eggs", "30 ct", "Harris Teeter"),
                product("Harris Teeter Large White Eggs", "12 ct", "Harris Teeter"),
                product("Harris Teeter Large White Eggs", "18 ct", "Harris Teeter"),
            ],
            NAMES,
            (12, "each"),
        )
        assert pick is not None and pick.size == "12 ct"

    def test_size_compares_across_units(self) -> None:
        # We expect a 2 oz jar; a 1 lb bag is much further off.
        pick = choose(
            "cumin",
            [product("Kroger Cumin", "1 lb", "Kroger"), product("Kroger Cumin", "2 oz", "Kroger")],
            NAMES,
            (2, "oz"),
        )
        assert pick is not None and pick.size == "2 oz"

    def test_nothing_matches(self) -> None:
        assert choose("lime", [product("Lemon")], NAMES) is None


class TestRelevance:
    def test_the_department_must_fit_the_aisle(self) -> None:
        offered = [
            product("Ice Breakers Cool Mint Mints", categories=("Candy",)),
            product("Mint", categories=("Produce", "Natural & Organic")),
        ]
        assert [p.description for p in candidates("mint", offered, [], "produce")] == ["Mint"]

    def test_organic_is_a_tag_not_a_department(self) -> None:
        tofu = product("Organic Tofu", categories=("Natural & Organic",))
        assert candidates("tofu", [tofu], [], "produce") == []

    def test_never_pet_food(self) -> None:
        cat = product("Delicate White Fish & Tuna Entree", categories=("Pet Care",))
        assert candidates("white fish", [cat], [], None) == []

    def test_the_ingredient_must_be_the_head_noun(self) -> None:
        pick = choose(
            "celery",
            [
                product("Harris Teeter Cream of Celery Soup", brand="Harris Teeter"),
                product("Fresh Celery"),
            ],
            NAMES,
        )
        assert pick is not None and pick.description == "Fresh Celery"
        wine = product("Private Selection Bourbon Barrel Aged Red Wine")
        assert choose("bourbon", [wine], NAMES) is None

    def test_fresh_prefers_not_dried(self) -> None:
        offered = [product("Gourmet Garden Lightly Dried Basil"), product("Fresh Basil")]
        pick = choose("basil", offered, NAMES)
        assert pick is not None and pick.description == "Fresh Basil"

    def test_head_skips_packaging_and_joining_words(self) -> None:
        assert "carrot" in head("Harris Teeter Whole Carrots Bag")
        assert "cumin" in head("Private Selection Ground Cumin Shaker 1.72 oz")
        assert "sauce" in head("Chipotle Peppers in Adobo Sauce")

    def test_canned_and_dried_arent_needed_but_steer(self) -> None:
        offered = [product("Harris Teeter Dry Black Beans"), product("Harris Teeter Black Beans")]
        canned = choose("canned black beans", offered, [])
        dried = choose("dried black beans", offered, [])
        assert canned is not None and canned.description == "Harris Teeter Black Beans"
        assert dried is not None and dried.description == "Harris Teeter Dry Black Beans"
        assert search_term("canned black beans") == "black beans"


KROGER_EGGS = {
    "productId": "0007203663220",
    "brand": "Harris Teeter",
    "description": "Harris Teeter Large Grade A White Eggs",
    "items": [
        {
            "size": "12 ct",
            "soldBy": "UNIT",
            "price": {
                "regular": 2.19,
                "promo": 1.99,
                "expirationDate": {"value": "2026-10-14T03:59:59.999Z"},
            },
            "fulfillment": {"inStore": True},
        }
    ],
}


class TestClient:
    @pytest.fixture(autouse=True)
    def creds(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "kroger_client_id", "id")
        monkeypatch.setattr(settings, "kroger_client_secret", "secret")
        monkeypatch.setattr(kroger, "RETRY_WAITS", (0.0, 0.0, 0.0))

    def client(
        self, products: Callable[[httpx.Request], httpx.Response]
    ) -> tuple[Kroger, list[httpx.Request]]:
        seen: list[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            if request.url.path.endswith("/token"):
                return httpx.Response(200, json={"access_token": "t", "expires_in": 1800})
            return products(request)

        return Kroger(httpx.Client(transport=httpx.MockTransport(handle))), seen

    def test_parses_price_promo_and_size(self) -> None:
        p = parse_product(KROGER_EGGS)
        assert (p.size, p.regular, p.promo, p.in_store) == ("12 ct", 2.19, 1.99, True)
        # 03:59 UTC on the 14th is still the 13th in Asheville.
        assert p.promo_ends == date(2026, 10, 13)

    def test_retries_a_dropped_connection(self) -> None:
        # Matching at a Kroger once died on "Server disconnected" (TYL-19).
        tries = []

        def flaky(r: httpx.Request) -> httpx.Response:
            tries.append(r)
            if len(tries) < 3:
                raise httpx.RemoteProtocolError("Server disconnected")
            return httpx.Response(200, json={"data": [KROGER_EGGS]})

        k, _ = self.client(flaky)
        assert [p.product_id for p in k.search("eggs", "09700348")] == [KROGER_EGGS["productId"]]
        assert len(tries) == 3

    def test_gives_up_after_the_last_dropped_connection(self) -> None:
        def down(r: httpx.Request) -> httpx.Response:
            raise httpx.RemoteProtocolError("Server disconnected")

        k, _ = self.client(down)
        with pytest.raises(httpx.RemoteProtocolError):
            k.search("eggs", "09700348")

    def test_gets_one_token_and_searches_the_store(self) -> None:
        k, seen = self.client(lambda r: httpx.Response(200, json={"data": [KROGER_EGGS]}))
        k.search("eggs", "09700348")
        k.search("milk", "09700348")
        assert sum(r.url.path.endswith("/token") for r in seen) == 1
        assert seen[1].url.params["filter.locationId"] == "09700348"
        assert seen[1].headers["Authorization"] == "Bearer t"

    def test_looks_up_products_50_at_a_time(self) -> None:
        k, seen = self.client(lambda r: httpx.Response(200, json={"data": []}))
        k.products([str(n).zfill(13) for n in range(120)], "09700348")
        lookups = [r for r in seen if r.url.path.endswith("/products")]
        assert [len(r.url.params["filter.productId"].split(",")) for r in lookups] == [50, 50, 20]

    def test_retries_a_brief_outage(self) -> None:
        replies = iter([httpx.Response(503), httpx.Response(200, json={"data": [KROGER_EGGS]})])
        k, _ = self.client(lambda r: next(replies))
        assert [p.product_id for p in k.search("eggs", "09700348")] == ["0007203663220"]

    def test_a_search_that_finds_nothing(self) -> None:
        k, _ = self.client(lambda r: httpx.Response(404))
        assert k.search("ground bison", "09700348") == []

    def test_gives_up_after_three_tries(self) -> None:
        k, _ = self.client(lambda r: httpx.Response(503))
        with pytest.raises(httpx.HTTPStatusError):
            k.search("eggs", "09700348")

    def test_needs_credentials(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, "kroger_client_id", "")
        k, _ = self.client(lambda r: httpx.Response(200, json={"data": []}))
        with pytest.raises(RuntimeError, match="KROGER_CLIENT_ID"):
            k.search("eggs", "09700348")
