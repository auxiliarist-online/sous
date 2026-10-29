"""An "or" line ("almond milk or cow's milk") is settled by diet, the user's
choice, or what the week needs anyway; otherwise it waits (TYL-98)."""

from datetime import date
from typing import Any

from app.plans.cost import added_costs, plan_cost
from app.plans.options import settle

MONDAY = date(2026, 10, 19)
ALMOND, MILK, RICE = "almond", "milk", "rice"
KEY = ",".join(sorted([ALMOND, MILK]))

INGREDIENTS: dict[str, dict[str, Any]] = {
    ALMOND: {
        "name": "almond milk",
        "aisle": "dairy_eggs",
        "sold_by": "package",
        "package_quantity": 64,
        "package_unit": "fl oz",
        "contains": ["tree_nut"],
    },
    MILK: {
        "name": "milk",
        "aisle": "dairy_eggs",
        "sold_by": "package",
        "package_quantity": 128,
        "package_unit": "fl oz",
        "contains": ["dairy"],
    },
    RICE: {
        "name": "white rice",
        "aisle": "pantry",
        "grams_per_cup": 185,
        "sold_by": "package",
        "package_quantity": 2,
        "package_unit": "lb",
    },
}
PRICES = [
    {
        "ingredient_id": ALMOND,
        "source": "baseline",
        "price_cents": 349,
        "quantity": 64,
        "unit": "fl oz",
    },
    {
        "ingredient_id": MILK,
        "source": "baseline",
        "price_cents": 429,
        "quantity": 128,
        "unit": "fl oz",
    },
    {"ingredient_id": RICE, "source": "baseline", "price_cents": 200, "quantity": 1, "unit": "lb"},
]


def either(line_no: int = 0) -> list[dict[str, Any]]:
    """One "almond milk or milk" line, as two options."""
    raw = "1 cup almond milk or cow's milk"
    return [
        {
            "line_no": line_no,
            "option_no": 1,
            "ingredient_id": ALMOND,
            "quantity": 1,
            "unit": "cup",
            "raw_text": raw,
        },
        {
            "line_no": line_no,
            "option_no": 2,
            "ingredient_id": MILK,
            "quantity": 1,
            "unit": "cup",
            "raw_text": raw,
        },
    ]


def only(ingredient: str, line_no: int = 0) -> list[dict[str, Any]]:
    return [
        {
            "line_no": line_no,
            "option_no": 1,
            "ingredient_id": ingredient,
            "quantity": 1,
            "unit": "cup",
            "raw_text": "x",
        }
    ]


def entry(id_: str, lines: list[dict[str, Any]], candidate: bool = False) -> dict[str, Any]:
    return {"id": id_, "recipe_id": f"r-{id_}", "scale": 1, "candidate": candidate, "lines": lines}


def inputs(*entries: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {
        "budget_cents": 5000,
        "entries": list(entries),
        "ingredients": INGREDIENTS,
        "prices": PRICES,
        **extra,
    }


def bought(cost: Any) -> set[str]:
    return {i.ingredient_id for i in cost.items if i.ingredient_id}


class TestSettle:
    def test_waits_for_the_user_and_buys_neither_meanwhile(self) -> None:
        cost = plan_cost(inputs(entry("a", either()), entry("b", either())), on=MONDAY)
        (choice,) = cost.choices
        assert (choice.key, choice.chosen, choice.reason, choice.recipes) == (
            KEY,
            None,
            "pending",
            2,
        )
        assert bought(cost) == set()
        # Each option's price: what buying it adds to the week.
        assert {o.name: o.cents for o in choice.options} == {"almond milk": 349, "milk": 429}

    def test_a_vegan_gets_the_option_that_fits(self) -> None:
        cost = plan_cost(inputs(entry("a", either()), rules={"excludes": ["dairy"]}), on=MONDAY)
        (choice,) = cost.choices
        assert (choice.chosen, choice.reason) == (ALMOND, "diet")
        assert bought(cost) == {ALMOND}

    def test_an_allergy_rules_out_an_option(self) -> None:
        cost = plan_cost(inputs(entry("a", either()), rules={"allergens": ["tree_nut"]}), on=MONDAY)
        assert (cost.choices[0].chosen, cost.choices[0].reason) == (MILK, "diet")

    def test_the_users_choice_covers_every_recipe(self) -> None:
        cost = plan_cost(
            inputs(entry("a", either()), entry("b", either()), choices={KEY: MILK}), on=MONDAY
        )
        assert (cost.choices[0].chosen, cost.choices[0].reason) == (MILK, "chosen")
        # One gallon covers both recipes.
        assert bought(cost) == {MILK}
        assert [i.packages for i in cost.items] == [1]

    def test_an_option_the_week_needs_anyway_is_used(self) -> None:
        cost = plan_cost(inputs(entry("a", either()), entry("b", only(MILK))), on=MONDAY)
        (choice,) = cost.choices
        assert (choice.chosen, choice.reason) == (MILK, "needed")
        assert bought(cost) == {MILK}
        # Milk is bought anyway, so it adds nothing; almond milk would add its carton.
        assert {o.name: o.cents for o in choice.options} == {"almond milk": 349, "milk": 0}

    def test_options_are_named_as_the_recipe_does_when_bought_as_something_else(
        self,
    ) -> None:
        # TYL-141: "whipped cream" is bought as heavy cream; "cow's milk" is milk.
        lines = either()
        lines[0]["name"] = "Whipped cream"
        lines[1]["name"] = "whole milk"
        cost = plan_cost(inputs(entry("a", lines)), on=MONDAY)
        (choice,) = cost.choices
        assert {o.name: o.written for o in choice.options} == {
            "almond milk": "whipped cream",
            "milk": None,
        }

    def test_a_shared_choice_keeps_each_recipes_word(self) -> None:
        first, second = either(), either()
        first[0]["name"] = "whipped cream"
        second[0]["name"] = "coconut cream"
        cost = plan_cost(inputs(entry("a", first), entry("b", second)), on=MONDAY)
        (choice,) = cost.choices
        assert choice.recipes == 2
        assert {o.name: o.written for o in choice.options}["almond milk"] == (
            "whipped cream / coconut cream"
        )

    def test_an_option_on_hand_is_used(self) -> None:
        week = inputs(entry("a", either()))
        week["ingredients"] = {**INGREDIENTS, MILK: {**INGREDIENTS[MILK], "pantry": "have"}}
        cost = plan_cost(week, on=MONDAY)
        assert (cost.choices[0].chosen, cost.choices[0].reason) == (MILK, "on_hand")
        assert [i.buy for i in cost.items] == [False]

    def test_the_users_choice_wins_over_what_the_week_needs(self) -> None:
        cost = plan_cost(
            inputs(entry("a", either()), entry("b", only(MILK)), choices={KEY: ALMOND}), on=MONDAY
        )
        assert (cost.choices[0].chosen, cost.choices[0].reason) == (ALMOND, "chosen")
        assert bought(cost) == {ALMOND, MILK}

    def test_a_saved_choice_that_no_longer_fits_is_ignored(self) -> None:
        cost = plan_cost(
            inputs(entry("a", either()), choices={KEY: MILK}, rules={"excludes": ["dairy"]}),
            on=MONDAY,
        )
        assert (cost.choices[0].chosen, cost.choices[0].reason) == (ALMOND, "diet")

    def test_when_no_option_fits_only_the_users_choice_settles_it(self) -> None:
        rules = {"excludes": ["dairy"], "allergens": ["tree_nut"]}
        # Not the pantry, nor another recipe that needs one of them.
        week = inputs(entry("a", either()), entry("b", only(MILK)), rules=rules)
        week["ingredients"] = {**INGREDIENTS, ALMOND: {**INGREDIENTS[ALMOND], "pantry": "have"}}
        (choice,) = plan_cost(week, on=MONDAY).choices
        assert (choice.chosen, choice.reason, choice.fits) == (None, "pending", False)
        assert [o.ingredient_id for o in choice.options] == [ALMOND, MILK]
        # The user can still choose, knowing it doesn't fit.
        chosen = plan_cost({**week, "choices": {KEY: ALMOND}}, on=MONDAY).choices[0]
        assert (chosen.chosen, chosen.reason, chosen.fits) == (ALMOND, "chosen", False)

    def test_lines_without_options_are_left_alone(self) -> None:
        cost = plan_cost(inputs(entry("a", only(RICE))), on=MONDAY)
        assert cost.choices == []
        assert bought(cost) == {RICE}

    def test_an_unmatched_option_isnt_a_choice(self) -> None:
        lines = either()
        lines[1]["ingredient_id"] = None
        entries, choices = settle(inputs(entry("a", lines)))
        assert choices == []
        assert [ln["ingredient_id"] for ln in entries[0]["lines"]] == [ALMOND]


class TestCandidates:
    def test_a_candidate_follows_the_weeks_choice(self) -> None:
        week = inputs(
            entry("a", either()),
            entry("c", either(), candidate=True),
            choices={KEY: MILK},
        )
        (added,) = added_costs(week, on=MONDAY)
        # The gallon already bought covers it.
        assert added.cents == 0

    def test_a_candidate_isnt_one_of_the_weeks_choices(self) -> None:
        cost = plan_cost(inputs(entry("c", either(), candidate=True)), on=MONDAY)
        assert cost.choices == []
