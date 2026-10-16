"""Reading a recipe from photos of cookbook pages (TYL-52), from synthetic
Vision annotations: no real pages, no calls to Google."""

import asyncio
import base64
import json
from collections.abc import Iterator
from typing import Any

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.recipes.photos import (
    PhotoError,
    blocks_of,
    read_pages,
    reading_order,
    recipe_from_pages,
    record_read,
)
from tests.unit.conftest import Install


def word(text: str, x: int, y: int, h: int, last: bool, conf: float) -> dict[str, Any]:
    symbols: list[dict[str, Any]] = [{"text": c} for c in text]
    symbols[-1]["property"] = {"detectedBreak": {"type": "EOL_SURE_SPACE" if last else "SPACE"}}
    right = x + 10 * len(text)
    box = [{"x": x, "y": y}, {"x": right, "y": y}, {"x": right, "y": y + h}, {"x": x, "y": y + h}]
    return {"boundingBox": {"vertices": box}, "symbols": symbols, "confidence": conf}


def block(
    x: int, y: int, width: int, paragraphs: list[list[str]], h: int = 20, conf: float = 0.99
) -> dict[str, Any]:
    """A block whose paragraphs' lines are given as text; each line's words
    sit on one row, `h` pixels tall, set like print (10 px a letter, a space
    between words). A line starting with "?" reads unsure; one starting with
    ">" is indented."""
    out, top = [], y
    for lines in paragraphs:
        words = []
        for line in lines:
            indent = 30 if line.startswith(">") else 0
            line = line.lstrip(">")
            sure = conf if not line.startswith("?") else 0.5
            parts = line.lstrip("?").split()
            left = x + indent
            for i, w in enumerate(parts):
                words.append(word(w, left, top, h, i == len(parts) - 1, sure))
                left += 10 * len(w) + 10
            top += h + 6
        out.append({"words": words})
        top += 10
    box = [
        {"x": x, "y": y},
        {"x": x + width, "y": y},
        {"x": x + width, "y": top},
        {"x": x, "y": top},
    ]
    return {"blockType": "TEXT", "boundingBox": {"vertices": box}, "paragraphs": out}


def page(*blocks: dict[str, Any]) -> dict[str, Any]:
    return {"pages": [{"width": 1000, "height": 1400, "blocks": list(blocks)}]}


def sideways(annotation: dict[str, Any]) -> dict[str, Any]:
    """The same page photographed turned a quarter clockwise: every point
    moves, the text runs down the photo."""
    pg = annotation["pages"][0]
    height = pg["height"]

    def turn(node: Any) -> None:
        if isinstance(node, dict):
            if "vertices" in node:
                node["vertices"] = [{"x": height - v["y"], "y": v["x"]} for v in node["vertices"]]
            for v in node.values():
                turn(v)
        elif isinstance(node, list):
            for v in node:
                turn(v)

    turned: dict[str, Any] = json.loads(json.dumps(annotation))
    turn(turned["pages"][0]["blocks"])
    turned["pages"][0]["width"], turned["pages"][0]["height"] = height, pg["width"]
    return turned


# A typical cookbook spread: title and introduction across the top, then
# ingredients in the left column and the method in the right.
DAL_PAGE = page(
    block(60, 40, 880, [["Red Lentil Dal"]], h=48),
    block(
        60,
        120,
        880,
        [
            [
                "My grandmother made this every Sunday, and the smell of",
                "cumin still takes me back to her small kitchen in Leeds.",
            ]
        ],
    ),
    block(60, 220, 880, [["Serves 4"], ["Prep 10 min Cook 35 min"]]),
    # Right column first in the page's own order: reading order fixes it.
    block(
        540,
        320,
        400,
        [
            ["Method"],
            [
                "1. Rinse the lentils until the water runs clear, then",
                "drain them well.",
            ],
            [
                "2. Warm the oil in a large pan and fry the onion until",
                "soft and golden, about 8 minutes.",
            ],
            ["3. Add the lentils and water and simmer for 25 minutes."],
        ],
    ),
    block(
        60,
        320,
        400,
        [
            ["Ingredients"],
            ["1 cup red lentils", "2 tbsp olive oil", "1 onion, diced"],
            ["For the tadka:"],
            ["1 tsp cumin seeds", "?½ tsp chili flakes", "Salt and pepper"],
        ],
    ),
)


def test_reads_a_two_column_page_in_order() -> None:
    blocks = reading_order(blocks_of(DAL_PAGE))
    firsts = [b.paragraphs[0][0].text for b in blocks]
    assert firsts == [
        "Red Lentil Dal",
        "My grandmother made this every Sunday, and the smell of",
        "Serves 4",
        "Ingredients",
        "Method",
    ]


def test_sorts_a_page_into_a_recipe() -> None:
    draft = recipe_from_pages([blocks_of(DAL_PAGE)])
    assert draft.title == "Red Lentil Dal"
    assert (draft.servings, draft.prep_minutes, draft.cook_minutes) == (4.0, 10, 35)
    assert draft.ingredients == [
        "1 cup red lentils",
        "2 tbsp olive oil",
        "1 onion, diced",
        "For the tadka:",
        "1 tsp cumin seeds",
        "½ tsp chili flakes",
        "Salt and pepper",
    ]
    assert draft.instructions == [
        "Rinse the lentils until the water runs clear, then drain them well.",
        "Warm the oil in a large pan and fry the onion until soft and golden, about 8 minutes.",
        "Add the lentils and water and simmer for 25 minutes.",
    ]
    # The introduction isn't a step; the chili flakes read poorly.
    assert draft.skipped == [
        "My grandmother made this every Sunday, and the smell of cumin still takes me back "
        "to her small kitchen in Leeds."
    ]
    assert "½ tsp chili flakes" in draft.unsure


def test_a_line_without_an_amount_doesnt_turn_a_list_into_a_step() -> None:
    # As Vision grouped a real page: four lines in one paragraph, the last
    # without an amount, then a section heading on its own.
    soup = page(
        block(60, 40, 880, [["Roasted Squash Soup"]], h=48),
        block(60, 120, 400, [["Ingredients"]]),
        block(
            60,
            160,
            400,
            [
                ["1 butternut squash, peeled and cubed", "2 tbsp olive oil"],
                [
                    "3 garlic cloves, minced",
                    "4 cups vegetable broth",
                    "1/2 cup heavy cream",
                    "Salt and pepper",
                ],
                ["For the topping:"],
                ["1/4 cup pumpkin seeds", "1 tsp smoked paprika"],
            ],
        ),
        block(540, 120, 400, [["Method"]]),
        block(540, 160, 400, [["1. Heat the oven to 400F and roast the squash for 30 minutes."]]),
    )
    draft = recipe_from_pages([blocks_of(soup)])
    assert draft.ingredients == [
        "1 butternut squash, peeled and cubed",
        "2 tbsp olive oil",
        "3 garlic cloves, minced",
        "4 cups vegetable broth",
        "1/2 cup heavy cream",
        "Salt and pepper",
        "For the topping:",
        "1/4 cup pumpkin seeds",
        "1 tsp smoked paprika",
    ]
    assert draft.instructions == ["Heat the oven to 400F and roast the squash for 30 minutes."]
    assert "Salt and pepper" in draft.unsure


def test_a_wrapped_step_that_starts_with_an_amount_stays_a_step() -> None:
    steps = page(
        block(60, 40, 880, [["Pancakes"]], h=48),
        block(60, 120, 880, [["Method"]]),
        block(
            60,
            160,
            880,
            [["2 cups of flour go into the bowl first, then whisk in", "the milk until smooth."]],
        ),
    )
    draft = recipe_from_pages([blocks_of(steps)])
    assert draft.ingredients == []
    assert len(draft.instructions) == 1


def test_a_step_with_amounts_on_two_lines_stays_a_step() -> None:
    steps = page(
        block(60, 40, 880, [["Pancakes"]], h=48),
        block(60, 120, 880, [["Ingredients"], ["2 cups flour", "1 tbsp oil"]]),
        block(60, 260, 880, [["Method"]]),
        block(
            60,
            300,
            880,
            [["2 cups of flour go into the bowl", "1 tbsp oil goes in next", "Stir until smooth"]],
        ),
    )
    draft = recipe_from_pages([blocks_of(steps)])
    assert draft.ingredients == ["2 cups flour", "1 tbsp oil"]
    assert draft.instructions == [
        "2 cups of flour go into the bowl 1 tbsp oil goes in next Stir until smooth"
    ]


def test_a_step_without_a_method_heading_stays_a_step() -> None:
    steps = page(
        block(60, 40, 880, [["Pancakes"]], h=48),
        block(60, 120, 880, [["Ingredients"], ["2 cups flour", "1 tbsp oil"]]),
        block(
            60,
            260,
            880,
            [["2 cups of flour go into the bowl", "1 tbsp oil goes in next", "Stir until smooth"]],
        ),
    )
    draft = recipe_from_pages([blocks_of(steps)])
    assert draft.ingredients == ["2 cups flour", "1 tbsp oil"]
    assert draft.instructions == [
        "2 cups of flour go into the bowl 1 tbsp oil goes in next Stir until smooth"
    ]


# A page laid out like many cookbooks: the end of the recipe before (a
# variation), the title in two lines with a label, servings among a yield,
# ingredients with wrapped lines on a hanging indent, the steps, serving
# ideas after them, a running footer, and the facing page's edge.
FRITTATA_PAGE = page(
    block(60, 30, 880, [["Variation"], ["To make it with ham, add a cup of diced ham in step 2."]]),
    block(60, 130, 500, [["Weeknight: Spinach", "and Feta Frittata"]], h=40),
    block(60, 240, 880, [["A quick supper from whatever is in the fridge."]]),
    block(
        60, 290, 400, [["Yields one 10-inch frittata", "Serves 4", "Bake time: 15 to 20 minutes"]]
    ),
    block(
        60,
        390,
        400,
        [
            [
                "8 large eggs",
                "1 cup crumbled feta or goat",
                ">cheese (4 ounces)",
                "Salt",
                "Freshly ground black pepper",
                "2 cups baby spinach, roughly",
                ">chopped",
            ]
        ],
    ),
    block(
        60,
        620,
        880,
        [
            ["Heat the oven to 375F. Whisk the eggs with the cheese and a good pinch", "of salt."],
            ["Stir in the spinach, pour into an oiled pan, and bake until set."],
        ],
    ),
    block(60, 760, 400, [["SERVING IDEAS"]]),
    block(60, 800, 880, [["Good with a green salad and crusty bread for a weekend brunch."]]),
    block(60, 1340, 300, [["212 Eggs and Brunch"]]),
    block(975, 300, 25, [["th"], ["ole,"], ["nd"], ["oks"], ["as"]]),
)


def test_reads_a_cookbook_page_from_its_layout() -> None:
    draft = recipe_from_pages([blocks_of(FRITTATA_PAGE)])
    assert draft.title == "Spinach and Feta Frittata"
    assert (draft.servings, draft.cook_minutes) == (4.0, 20)
    assert draft.ingredients == [
        "8 large eggs",
        "1 cup crumbled feta or goat cheese (4 ounces)",
        "Salt",
        "Freshly ground black pepper",
        "2 cups baby spinach, roughly chopped",
    ]
    assert draft.instructions == [
        "Heat the oven to 375F. Whisk the eggs with the cheese and a good pinch of salt.",
        "Stir in the spinach, pour into an oiled pan, and bake until set.",
    ]
    # Not part of the recipe: what came before the title, the introduction,
    # the serving ideas, the footer and the facing page's edge.
    every = " ".join(draft.ingredients + draft.instructions)
    for gone in ("ham", "fridge", "salad", "212", "oks"):
        assert gone not in every
    assert "Good with a green salad and crusty bread for a weekend brunch." in draft.skipped


def test_reads_a_page_photographed_sideways() -> None:
    draft = recipe_from_pages([blocks_of(sideways(FRITTATA_PAGE))])
    assert draft.title == "Spinach and Feta Frittata"
    assert draft.ingredients[1] == "1 cup crumbled feta or goat cheese (4 ounces)"
    assert len(draft.instructions) == 2


def test_a_word_set_apart_rejoins_its_line() -> None:
    # Vision can return a line's last word as a block of its own.
    split = page(
        block(60, 40, 880, [["Rice"]], h=48),
        block(60, 120, 400, [["Ingredients"], ["1 cup white rice", "1/8 teaspoon ground black"]]),
        block(320, 182, 60, [["pepper"]]),
        block(60, 260, 880, [["Rinse the rice and simmer it for 18 minutes."]]),
    )
    draft = recipe_from_pages([blocks_of(split)])
    assert draft.ingredients == ["1 cup white rice", "1/8 teaspoon ground black pepper"]


def test_a_line_starting_cook_is_a_step_unless_it_gives_a_time() -> None:
    steps = page(
        block(60, 40, 880, [["Stew"]], h=48),
        block(60, 120, 880, [["Cook time: 1 hour 15 minutes"]]),
        block(60, 160, 400, [["2 pounds beef", "1 onion, sliced"]]),
        block(60, 260, 880, [["Cook and stir the beef until browned, about 10 minutes."]]),
    )
    draft = recipe_from_pages([blocks_of(steps)])
    assert draft.cook_minutes == 75
    assert draft.instructions == ["Cook and stir the beef until browned, about 10 minutes."]


def test_a_step_that_starts_with_a_time_stays_a_step() -> None:
    bake = page(
        block(60, 40, 880, [["Custard"]], h=48),
        block(60, 120, 400, [["4 eggs", "2 cups milk"]]),
        block(
            60,
            200,
            880,
            [["Whisk the eggs and milk and pour into cups. Set them in a roasting pan and"]],
        ),
        block(
            60,
            230,
            880,
            [["cook 5 minutes more on the stove."], ["Bake 25 to 30 minutes, until set."]],
        ),
    )
    draft = recipe_from_pages([blocks_of(bake)])
    assert draft.cook_minutes is None
    assert draft.instructions == [
        "Whisk the eggs and milk and pour into cups. Set them in a roasting pan and cook 5 "
        "minutes more on the stove.",
        "Bake 25 to 30 minutes, until set.",
    ]


def test_a_heading_across_the_gutter_isnt_a_stray_word() -> None:
    columns = page(
        block(60, 40, 880, [["Dal"]], h=48),
        block(60, 120, 400, [["1 onion, diced", "1 cup lentils"]]),
        block(240, 120, 120, [["Method"]]),
        block(240, 160, 600, [["Fry the onion, add the lentils and simmer for 25 minutes."]]),
    )
    draft = recipe_from_pages([blocks_of(columns)])
    assert draft.ingredients == ["1 onion, diced", "1 cup lentils"]


def test_an_ingredient_at_the_frame_edge_is_kept_and_a_footer_shown() -> None:
    framed = page(
        block(60, 40, 880, [["Toast"]], h=48),
        block(60, 1200, 400, [["1 slice bread", "2 tbsp butter"]]),
        block(60, 1370, 300, [["88 Breakfast"]]),
    )
    draft = recipe_from_pages([blocks_of(framed)])
    assert draft.ingredients == ["1 slice bread", "2 tbsp butter"]
    assert "88 Breakfast" in draft.skipped
    tight = page(
        block(60, 40, 880, [["Toast"]], h=48),
        block(60, 1320, 400, [["1 slice bread", "2 tbsp butter"]]),
    )
    assert recipe_from_pages([blocks_of(tight)]).ingredients == ["1 slice bread", "2 tbsp butter"]


def test_a_time_in_a_step_isnt_the_recipes() -> None:
    pasta = page(
        block(60, 40, 880, [["Pasta"]], h=48),
        block(60, 120, 880, [["Prep 10 min Cook 35 min"]]),
        block(60, 160, 400, [["1 pound pasta"]]),
        block(60, 240, 880, [["Add the pasta and cook 10 minutes, then drain it well."]]),
    )
    draft = recipe_from_pages([blocks_of(pasta)])
    assert (draft.prep_minutes, draft.cook_minutes) == (10, 35)
    bare = page(
        block(60, 40, 880, [["Pasta"]], h=48),
        block(60, 160, 400, [["1 pound pasta"]]),
        block(60, 240, 880, [["Add the pasta and cook 10 minutes, then drain it well."]]),
    )
    draft = recipe_from_pages([blocks_of(bare)])
    assert draft.cook_minutes is None
    assert draft.instructions == ["Add the pasta and cook 10 minutes, then drain it well."]


def test_a_footer_doesnt_give_servings() -> None:
    footed = page(
        block(60, 40, 880, [["Toast"]], h=48),
        block(60, 120, 400, [["1 slice bread", "2 tbsp butter"]]),
        block(60, 1370, 300, [["Serves 8 or more"]]),
    )
    draft = recipe_from_pages([blocks_of(footed)])
    assert draft.servings is None
    assert "Serves 8 or more" in draft.skipped


def test_makes_a_quantity_isnt_servings() -> None:
    sauce = page(
        block(60, 40, 880, [["Tomato Sauce"]], h=48),
        block(60, 120, 880, [["Makes about 8 cups"]]),
        block(60, 160, 400, [["4 pounds tomatoes"]]),
    )
    assert recipe_from_pages([blocks_of(sauce)]).servings is None


def test_reads_a_recipe_across_two_pages() -> None:
    first = page(
        block(60, 40, 880, [["Apple Crumble"]], h=48),
        block(60, 140, 880, [["Makes 6 servings"]]),
        block(60, 220, 880, [["4 apples, sliced", "1 cup flour", "½ cup butter"]]),
    )
    second = page(
        block(
            60,
            40,
            880,
            [
                ["Heat the oven to 180C and butter a baking dish well."],
                ["Rub the butter into the flour, scatter over the apples and bake."],
            ],
        )
    )
    draft = recipe_from_pages([blocks_of(first), blocks_of(second)])
    assert draft.title == "Apple Crumble"
    assert draft.servings == 6.0
    assert draft.ingredients == ["4 apples, sliced", "1 cup flour", "½ cup butter"]
    assert len(draft.instructions) == 2


def test_an_empty_page_gives_an_empty_draft() -> None:
    assert recipe_from_pages([[]]).title == ""
    assert recipe_from_pages([]).ingredients == []


class TestVision:
    def test_sends_every_page_in_one_request_with_the_key_in_a_header(
        self, supabase: Install, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "google_vision_api_key", "vision-key")

        def handle(r: httpx.Request) -> httpx.Response:
            body = json.loads(r.content)
            assert r.headers["x-goog-api-key"] == "vision-key"
            assert "key=" not in str(r.url)
            assert [q["features"] for q in body["requests"]] == [
                [{"type": "DOCUMENT_TEXT_DETECTION"}]
            ] * 2
            assert base64.b64decode(body["requests"][0]["image"]["content"]) == b"page-1"
            return httpx.Response(200, json={"responses": [{"fullTextAnnotation": DAL_PAGE}, {}]})

        supabase(handle)
        pages = asyncio.run(read_pages([b"page-1", b"page-2"]))
        assert len(pages) == 2 and pages[1] == []
        assert pages[0][0].paragraphs[0][0].text == "Red Lentil Dal"

    def test_says_when_it_cant_read(
        self, supabase: Install, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with pytest.raises(PhotoError):
            asyncio.run(read_pages([b"x"]))  # no key
        monkeypatch.setattr(settings, "google_vision_api_key", "vision-key")
        supabase(lambda r: httpx.Response(403, text="billing disabled"))
        with pytest.raises(PhotoError, match="403"):
            asyncio.run(read_pages([b"x"]))
        supabase(
            lambda r: httpx.Response(200, json={"responses": [{"error": {"message": "bad image"}}]})
        )
        with pytest.raises(PhotoError, match="bad image"):
            asyncio.run(read_pages([b"x"]))


class TestRoute:
    JPEG = base64.b64encode(b"\xff\xd8\xff" + b"x" * 100).decode()

    @pytest.fixture
    def client(self, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
        from app.auth import current_user_id
        from app.main import app
        from app.recipes import routes

        state: dict[str, Any] = {"allowed": True, "read": [], "fail": False}

        async def record(user_id: str, pages: int) -> bool:
            state["read"].append((user_id, pages))
            return bool(state["allowed"])

        async def pages(images: list[bytes]) -> list[list[Any]]:
            if state["fail"]:
                raise PhotoError("down")
            return [blocks_of(DAL_PAGE)]

        monkeypatch.setattr(routes, "record_read", record)
        monkeypatch.setattr(routes, "read_pages", pages)
        app.dependency_overrides[current_user_id] = lambda: "user-1"
        c = TestClient(app)
        c.state = state  # type: ignore[attr-defined]
        yield c
        app.dependency_overrides.clear()

    def test_reads_the_pages_into_a_draft(self, client: TestClient) -> None:
        resp = client.post("/recipes/read-photos", json={"images": [self.JPEG]})
        assert resp.status_code == 200
        body = resp.json()
        assert body["title"] == "Red Lentil Dal"
        assert body["ingredients"][0] == "1 cup red lentils"
        assert body["servings"] == 4.0
        assert client.state["read"] == [("user-1", 1)]  # type: ignore[attr-defined]

    def test_stops_at_the_limit_and_when_vision_fails(self, client: TestClient) -> None:
        client.state["allowed"] = False  # type: ignore[attr-defined]
        assert client.post("/recipes/read-photos", json={"images": [self.JPEG]}).status_code == 429
        client.state["allowed"] = True  # type: ignore[attr-defined]
        client.state["fail"] = True  # type: ignore[attr-defined]
        assert client.post("/recipes/read-photos", json={"images": [self.JPEG]}).status_code == 502

    def test_takes_one_to_four_real_photos(self, client: TestClient) -> None:
        def post(images: list[str]) -> Any:
            return client.post("/recipes/read-photos", json={"images": images})

        assert post([]).status_code == 422
        assert post([self.JPEG] * 5).status_code == 422
        assert post(["not base64!"]).status_code == 422
        assert post([base64.b64encode(b"GIF89a....").decode()]).status_code == 422
        big = base64.b64encode(b"\xff\xd8\xff" + b"x" * 1_000_001).decode()
        assert post([big]).status_code == 413
        webp = base64.b64encode(b"RIFF\x00\x00\x00\x00WEBPVP8 ").decode()
        assert post([webp]).status_code == 200
        assert client.state["read"] == [("user-1", 1)]  # type: ignore[attr-defined]

    def test_needs_sign_in(self) -> None:
        from app.main import app

        resp = TestClient(app).post("/recipes/read-photos", json={"images": [self.JPEG]})
        assert resp.status_code == 401


class TestRecordRead:
    def test_counts_against_the_limits(
        self, supabase: Install, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "photo_pages_per_month", 900)
        monkeypatch.setattr(settings, "photo_pages_per_day", 40)
        seen = supabase(lambda r: httpx.Response(200, json=False))
        assert asyncio.run(record_read("user-1", 3)) is False
        assert seen[0].url.path.endswith("/rpc/record_photo_read")
        assert json.loads(seen[0].content) == {
            "p_user": "user-1",
            "p_pages": 3,
            "p_month_cap": 900,
            "p_day_cap": 40,
        }
