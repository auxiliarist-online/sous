"""Plan my week (TYL-65): the draft keeps the user's rules and budget, shares
packages, mixes up proteins and cuisines, and brings back favorites."""

import random
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.auth import current_user_id
from app.main import app
from app.plans import routes
from app.plans.draft import Candidate, Variety, Week, cooking_styles, draft_week, waste

MONDAY = date(2026, 10, 19)


def ingredient(name: str, **extra: Any) -> dict[str, Any]:
    return {"name": name, "aisle": "produce", "contains": [], **extra}


INGREDIENTS: dict[str, dict[str, Any]] = {
    # A bunch of cilantro does two recipes.
    "cilantro": ingredient("cilantro", sold_by="package", package_quantity=2, package_unit="each"),
    "parsley": ingredient("parsley", sold_by="package", package_quantity=2, package_unit="each"),
    "rice": ingredient(
        "white rice", aisle="pantry", sold_by="package", package_quantity=4, package_unit="cup"
    ),
    "chicken": ingredient("chicken", aisle="meat_seafood", contains=["poultry"], sold_by="loose"),
    "beans": ingredient("black beans", aisle="pantry", sold_by="loose"),
    "steak": ingredient("steak", aisle="meat_seafood", contains=["meat"], sold_by="loose"),
}


def price(ingredient: str, cents: int, qty: float, unit: str) -> dict[str, Any]:
    return {
        "ingredient_id": ingredient,
        "source": "seed",
        "price_cents": cents,
        "quantity": qty,
        "unit": unit,
    }


PRICES = [
    price("cilantro", 200, 2, "each"),
    price("parsley", 200, 2, "each"),
    price("rice", 400, 4, "cup"),
    price("chicken", 500, 1, "each"),
    price("beans", 100, 1, "each"),
    price("steak", 900, 1, "each"),
]


def recipe(recipe_id: str, *uses: tuple[str, float, str]) -> dict[str, Any]:
    """A candidate entry, as plan_cost_inputs() returns it."""
    return {
        "id": f"candidate-{recipe_id}",
        "recipe_id": recipe_id,
        "scale": 1,
        "candidate": True,
        "lines": [
            {"line_no": n, "option_no": 1, "ingredient_id": i, "quantity": q, "unit": u}
            for n, (i, q, u) in enumerate(uses)
        ],
    }


def inputs(*entries: dict[str, Any], budget: int | None = None) -> dict[str, Any]:
    return {
        "budget_cents": budget,
        "entries": list(entries),
        "ingredients": INGREDIENTS,
        "prices": PRICES,
    }


def pool(*ids: str, **extra: Any) -> list[Candidate]:
    return [Candidate(r, r.replace("-", " ").title(), extra.get(r, "fits")) for r in ids]


def picked(d: Any) -> list[str]:
    return sorted(p.recipe_id for p in d.picks)


class TestDraft:
    def test_never_picks_what_breaks_the_rules(self) -> None:
        week = inputs(recipe("bad", ("beans", 1, "each")), recipe("ok", ("rice", 1, "cup")))
        d = draft_week(
            week,
            [Candidate("bad", "Bad", "excluded"), Candidate("ok", "Ok", "fits")],
            dinners=2,
            locked=[],
            exclude=[],
            on=MONDAY,
        )
        assert picked(d) == ["ok"]
        assert d.notes and "Only 1" in d.notes[0]

    def test_shares_packages(self) -> None:
        # Two cilantro recipes use one bunch; cilantro and parsley need two.
        week = inputs(
            recipe("salsa", ("cilantro", 1, "each")),
            recipe("tacos", ("cilantro", 1, "each")),
            recipe("tabbouleh", ("parsley", 1, "each")),
        )
        d = draft_week(
            week, pool("salsa", "tacos", "tabbouleh"), dinners=2, locked=[], exclude=[], on=MONDAY
        )
        assert picked(d) == ["salsa", "tacos"]
        assert any(p.reason == "Uses the rest of the cilantro" for p in d.picks)
        assert d.total_cents == 200

    def test_stays_in_budget_when_it_can_and_says_when_it_cant(self) -> None:
        week = inputs(
            recipe("steak", ("steak", 1, "each")),
            recipe("beans", ("beans", 1, "each")),
            budget=500,
        )
        d = draft_week(week, pool("steak", "beans"), dinners=1, locked=[], exclude=[], on=MONDAY)
        assert picked(d) == ["beans"]
        assert not d.over_budget
        over = draft_week(
            inputs(recipe("steak", ("steak", 1, "each")), budget=500),
            pool("steak"),
            dinners=1,
            locked=[],
            exclude=[],
            on=MONDAY,
        )
        assert over.over_budget and "over your budget" in over.notes[-1]

    def test_mixes_up_proteins(self) -> None:
        week = inputs(
            *(recipe(f"chicken-{n}", ("chicken", 1, "each")) for n in range(3)),
            recipe("steak", ("steak", 1, "each")),
        )
        ids = ["chicken-0", "chicken-1", "chicken-2", "steak"]
        d = draft_week(week, pool(*ids), dinners=3, locked=[], exclude=[], on=MONDAY)
        # Three chicken dinners would be cheaper; the third is swapped for steak.
        assert "steak" in picked(d)

    def test_brings_back_a_favorite_that_is_due(self) -> None:
        week = inputs(recipe("fav", ("chicken", 1, "each")), recipe("cheap", ("beans", 1, "each")))
        fav = Candidate("fav", "Fav", "fits", favorite="biweekly", weeks_ago=3)
        d = draft_week(
            week, [fav, Candidate("cheap", "Cheap", "fits")], dinners=1, locked=[], exclude=[],
            on=MONDAY,
        )  # fmt: skip
        assert picked(d) == ["fav"]
        assert d.picks[0].reason == "A favorite, last had 3 weeks ago"

    def test_favors_what_the_user_loved_last_time(self) -> None:
        # TYL-16: "loved" outweighs a modest saving; the reason says why.
        week = inputs(
            recipe("loved", ("chicken", 1, "each")), recipe("cheap", ("beans", 1, "each"))
        )
        loved = Candidate("loved", "Loved", "fits", rating="love")
        d = draft_week(
            week, [loved, Candidate("cheap", "Cheap", "fits")], dinners=1, locked=[], exclude=[],
            on=MONDAY,
        )  # fmt: skip
        assert picked(d) == ["loved"]
        assert d.picks[0].reason == "You loved it last time"

    def test_skips_what_was_just_had(self) -> None:
        week = inputs(recipe("again", ("beans", 1, "each")), recipe("new", ("rice", 1, "cup")))
        d = draft_week(
            week,
            [Candidate("again", "Again", "fits", weeks_ago=1), Candidate("new", "New", "fits")],
            dinners=1,
            locked=[],
            exclude=[],
            on=MONDAY,
        )
        assert picked(d) == ["new"]

    def test_lock_keeps_a_pick_and_swap_excludes_one(self) -> None:
        week = inputs(*(recipe(r, ("beans", 1, "each")) for r in ("a", "b", "c")))
        d = draft_week(week, pool("a", "b", "c"), dinners=2, locked=["c"], exclude=["a"], on=MONDAY)
        assert picked(d) == ["b", "c"]
        assert [p.locked for p in d.picks] == [True, False]

    def test_an_excluded_pick_is_never_kept(self) -> None:
        week = inputs(*(recipe(r, ("beans", 1, "each")) for r in ("a", "b")))
        d = draft_week(week, pool("a", "b"), dinners=1, locked=["a"], exclude=["a"], on=MONDAY)
        assert picked(d) == ["b"]

    def test_planned_meals_count_and_stay(self) -> None:
        planned = {**recipe("planned", ("cilantro", 1, "each")), "id": "e1", "candidate": False}
        week = inputs(
            planned,
            recipe("tacos", ("cilantro", 1, "each")),
            recipe("tabbouleh", ("parsley", 1, "each")),
        )
        d = draft_week(
            week, pool("tacos", "tabbouleh"), dinners=2, locked=[], exclude=[], on=MONDAY
        )
        # One open night, and the planned meal's cilantro gets used up.
        assert picked(d) == ["tacos"]

    def test_staples_left_over_are_not_waste_or_a_reason(self) -> None:
        # Two recipes share only olive oil, a staple; it's no reason to pair them.
        oil = ingredient(
            "olive oil", aisle="pantry", sold_by="package", package_quantity=16,
            package_unit="fl_oz", pantry_staple=True,
        )  # fmt: skip
        week = inputs(
            recipe("a", ("oil", 1, "fl_oz"), ("beans", 1, "each")),
            recipe("b", ("oil", 1, "fl_oz"), ("beans", 1, "each")),
        )
        week["ingredients"] = {**INGREDIENTS, "oil": oil}
        week["prices"] = [*PRICES, price("oil", 800, 16, "fl_oz")]
        d = draft_week(week, pool("a", "b"), dinners=2, locked=[], exclude=[], on=MONDAY)
        assert all("olive oil" not in p.reason for p in d.picks)
        assert d.leftovers == []

    def test_only_dinners_count(self) -> None:
        lunch = {
            **recipe("lunch", ("beans", 1, "each")),
            "id": "e1",
            "candidate": False,
            "meal": "lunch",
        }
        week = inputs(lunch, recipe("a", ("rice", 1, "cup")), recipe("b", ("beans", 1, "each")))
        d = draft_week(week, pool("a", "b"), dinners=2, locked=[], exclude=[], on=MONDAY)
        assert picked(d) == ["a", "b"]

    def test_a_weekly_favorite_had_a_week_ago(self) -> None:
        d = draft_week(
            inputs(recipe("fav", ("beans", 1, "each"))),
            [Candidate("fav", "Fav", "fits", favorite="weekly", weeks_ago=1)],
            dinners=1,
            locked=[],
            exclude=[],
            on=MONDAY,
        )
        assert d.picks[0].reason == "A favorite, last had 1 week ago"

    def test_cooks_with_the_seasons(self) -> None:
        week = inputs(recipe("summer", ("beans", 1, "each")), recipe("plain", ("beans", 1, "each")))
        ripe = Candidate("summer", "Summer", "fits", in_season=["tomatoes", "corn"])
        d = draft_week(
            week, [ripe, Candidate("plain", "Plain", "fits")], dinners=1, locked=[], exclude=[],
            on=MONDAY,
        )  # fmt: skip
        assert picked(d) == ["summer"]
        assert d.picks[0].reason == "In season: tomatoes, corn"

    def test_isnt_promoted_when_out_of_season(self) -> None:
        week = inputs(recipe("winter", ("beans", 1, "each")), recipe("plain", ("beans", 1, "each")))
        # The same cost; one leans on produce that's out of season.
        cold = Candidate("winter", "Winter", "fits", out_of_season=2)
        d = draft_week(
            week, [cold, Candidate("plain", "Plain", "fits")], dinners=1, locked=[], exclude=[],
            on=MONDAY,
        )  # fmt: skip
        assert picked(d) == ["plain"]

    def test_cook_with_the_seasons_turns_it_up(self) -> None:
        # Steak in season vs beans: a small boost isn't worth $8, a big one is.
        week = inputs(recipe("steak", ("steak", 1, "each")), recipe("beans", ("beans", 1, "each")))
        ripe = Candidate("steak", "Steak", "fits", in_season=["a", "b", "c"])
        args: dict[str, Any] = {"dinners": 1, "locked": [], "exclude": [], "on": MONDAY}
        plain = draft_week(week, [ripe, Candidate("beans", "Beans", "fits")], **args)
        seasonal = draft_week(
            week, [ripe, Candidate("beans", "Beans", "fits")], cook_with_seasons=True, **args
        )
        assert picked(plain) == ["beans"]
        assert picked(seasonal) == ["steak"]

    def test_says_what_is_left_over(self) -> None:
        d = draft_week(
            inputs(recipe("rice", ("rice", 1, "cup"))),
            pool("rice"),
            dinners=1,
            locked=[],
            exclude=[],
            on=MONDAY,
        )
        assert [(x.name, x.quantity, x.unit) for x in d.leftovers] == [("white rice", 3.0, "cup")]


def test_wastes_less_than_a_random_week() -> None:
    # 30 recipes, each using some of the packaged herbs and rice.
    rng = random.Random(7)
    herbs = ["cilantro", "parsley", "rice"]
    entries = []
    for n in range(30):
        uses = rng.sample(herbs, rng.randint(1, 2))
        entries.append(recipe(f"r{n}", *((u, 1, "cup" if u == "rice" else "each") for u in uses)))
    ids = [f"r{n}" for n in range(30)]
    week_inputs = inputs(*entries)
    d = draft_week(week_inputs, pool(*ids), dinners=5, locked=[], exclude=[], on=MONDAY)
    scorer = Week(week_inputs, pool(*ids), on=MONDAY, store_id=None)
    drafted = waste(scorer.cost(frozenset(picked(d))).items)
    randoms = [waste(scorer.cost(frozenset(rng.sample(ids, 5))).items) for _ in range(50)]
    assert drafted < sum(randoms) / len(randoms)
    assert drafted <= min(randoms)


class TestRoute:
    def test_drafts_from_the_users_pool_and_saves_nothing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        r1 = "00000000-0000-0000-0000-0000000000a1"
        r2 = "00000000-0000-0000-0000-0000000000a2"
        bad = "00000000-0000-0000-0000-0000000000a3"
        meh = "00000000-0000-0000-0000-0000000000a4"
        asked: dict[str, Any] = {}

        async def fake_pool(user_id: str, week: date) -> dict[str, Any]:
            return {
                "cook_with_seasons": False,
                "candidates": [
                    {"recipe_id": r1, "title": "Salsa", "fit": "fits", "cuisines": []},
                    {"recipe_id": r2, "title": "Tacos", "fit": "fits", "cuisines": []},
                    {"recipe_id": bad, "title": "Pork", "fit": "excluded", "cuisines": []},
                    # Rated down after cooking (TYL-16): left out too.
                    {"recipe_id": meh, "title": "Meh", "fit": "fits", "rating": "down"},
                ],
            }

        async def fake_inputs(
            user_id: str, week: date, candidates: list[str] | None = None
        ) -> dict[str, Any]:
            asked["candidates"] = candidates
            return inputs(*(recipe(r, ("cilantro", 1, "each")) for r in candidates or []))

        monkeypatch.setattr(routes, "draft_pool", fake_pool)
        monkeypatch.setattr(routes, "cost_inputs", fake_inputs)
        app.dependency_overrides[current_user_id] = lambda: "user-1"
        try:
            resp = TestClient(app).post(
                "/plans/2026-10-19/draft", json={"dinners": 2, "exclude": [], "locked": [r2]}
            )
        finally:
            app.dependency_overrides.clear()
        assert resp.status_code == 200
        body = resp.json()
        # The excluded and down-rated recipes are never priced or picked; the
        # locked one leads.
        assert asked["candidates"] == [r2, r1]
        assert [(p["title"], p["locked"]) for p in body["picks"]] == [
            ("Tacos", True),
            ("Salsa", False),
        ]
        assert body["total_cents"] == 200

    def test_needs_a_monday_and_a_sensible_count(self) -> None:
        app.dependency_overrides[current_user_id] = lambda: "user-1"
        try:
            client = TestClient(app)
            assert client.post("/plans/2026-10-19/draft", json={"dinners": 0}).status_code == 422
            assert client.post("/plans/2026-10-19/draft", json={"dinners": 15}).status_code == 422
        finally:
            app.dependency_overrides.clear()


class TestVariety:
    """TYL-66: proteins, cuisines and cooking styles mixed up as much as the
    user wants, repeats held back, favorites on their rhythm."""

    def test_reads_cooking_styles_from_titles_and_tags(self) -> None:
        assert cooking_styles("Weeknight Chicken Stir-Fry") == ["stir-fry"]
        assert cooking_styles("Spaghetti with Clams") == ["pasta"]
        assert cooking_styles("Lentil Curry Soup") == ["soup", "curry"]
        assert cooking_styles("Grandma's Sunday dinner", ["soup"]) == ["soup"]
        # A word inside another isn't a style.
        assert cooking_styles("Pastrami sandwich") == []

    def test_mixes_up_cooking_styles(self) -> None:
        week = inputs(
            *(recipe(f"pasta-{n}", ("rice", 1, "cup")) for n in range(3)),
            recipe("soup", ("beans", 1, "each")),
        )
        cands = [Candidate(f"pasta-{n}", f"Penne {n}", "fits") for n in range(3)]
        cands.append(Candidate("soup", "Bean Soup", "fits"))
        d = draft_week(week, cands, dinners=3, locked=[], exclude=[], on=MONDAY)
        assert "soup" in picked(d)
        assert not any("nights" in n for n in d.notes)

    def test_lets_proteins_repeat_when_the_user_doesnt_mind(self) -> None:
        week = inputs(
            *(recipe(f"chicken-{n}", ("chicken", 1, "each")) for n in range(3)),
            recipe("steak", ("steak", 1, "each")),
        )
        ids = ["chicken-0", "chicken-1", "chicken-2", "steak"]
        relaxed = Variety(proteins=False)
        d = draft_week(
            week, pool(*ids), dinners=3, locked=[], exclude=[], on=MONDAY, variety=relaxed
        )
        assert picked(d) == ["chicken-0", "chicken-1", "chicken-2"]
        assert not d.notes

    def test_says_when_the_pool_is_too_small_to_mix_it_up(self) -> None:
        week = inputs(*(recipe(f"chicken-{n}", ("chicken", 1, "each")) for n in range(3)))
        ids = ["chicken-0", "chicken-1", "chicken-2"]
        d = draft_week(week, pool(*ids), dinners=3, locked=[], exclude=[], on=MONDAY)
        assert len(d.picks) == 3
        assert any("3 dinners with poultry" in n for n in d.notes)

    def test_how_long_before_a_recipe_comes_back(self) -> None:
        week = inputs(recipe("again", ("beans", 1, "each")))
        had = Candidate("again", "Again", "fits", weeks_ago=2)
        assert Week(week, [had], on=MONDAY, store_id=None).recent(had)
        assert not Week(
            week, [had], on=MONDAY, store_id=None, variety=Variety(repeat_weeks=2)
        ).recent(had)
        assert not Week(
            week, [had], on=MONDAY, store_id=None, variety=Variety(repeat_weeks=0)
        ).recent(had)

    def test_reads_the_settings_with_defaults(self) -> None:
        assert Variety.from_json(None) == Variety()
        assert Variety.from_json({"styles": False, "repeat_weeks": 5}) == Variety(
            styles=False, repeat_weeks=5
        )

    def test_favorites_come_back_on_their_rhythm_over_eight_weeks(self) -> None:
        others = [f"other-{n}" for n in range(12)]
        favorites = {"fav-2": "biweekly", "fav-4": "monthly"}
        ids = [*others, *favorites]
        week = inputs(*(recipe(r, ("rice", 1, "cup")) for r in ids))
        last: dict[str, int] = {}
        seen: dict[str, list[int]] = {r: [] for r in ids}
        for w in range(8):
            cands = [
                Candidate(
                    r,
                    r,
                    "fits",
                    favorite=favorites.get(r),
                    weeks_ago=w - last[r] if r in last else None,
                )
                for r in ids
            ]
            d = draft_week(week, cands, dinners=3, locked=[], exclude=[], on=MONDAY)
            for p in d.picks:
                last[p.recipe_id] = w
                seen[p.recipe_id].append(w)

        def gaps(r: str) -> list[int]:
            return [b - a for a, b in zip(seen[r], seen[r][1:], strict=False)]

        # On schedule, give or take a week.
        assert len(seen["fav-2"]) >= 3 and all(1 <= g <= 3 for g in gaps("fav-2"))
        assert len(seen["fav-4"]) >= 2 and all(3 <= g <= 5 for g in gaps("fav-4"))
        # Nothing else comes back within three weeks.
        assert all(g >= 3 for r in others for g in gaps(r))


def test_keeps_variety_even_when_breaking_it_is_much_cheaper() -> None:
    # A third chicken dinner would save $195; the pricey steak keeps the rule.
    week = inputs(
        *(recipe(f"chicken-{n}", ("chicken", 1, "each")) for n in range(3)),
        recipe("steak", ("steak", 1, "each")),
    )
    week["prices"] = [
        *[p for p in week["prices"] if p["ingredient_id"] != "steak"],
        price("steak", 200_00, 1, "each"),
    ]
    ids = ["chicken-0", "chicken-1", "chicken-2", "steak"]
    d = draft_week(week, pool(*ids), dinners=3, locked=[], exclude=[], on=MONDAY)
    assert "steak" in picked(d)
    assert not d.notes
