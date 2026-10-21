"""Which option of an "or" line the week buys (TYL-98): "almond milk or cow's
milk". Each such line is settled, in order, by:

1. diet: options that break the user's diets, allergies, exclusions or
   dislikes are dropped; if one is left, it's used (a vegan gets almond milk);
2. choice: what the user picked for these options this week;
3. on hand: an option marked "have" in the pantry, since it costs nothing;
4. needed: an option another recipe in the week needs on its own, since it's
   bought anyway;
5. otherwise it waits for the user to choose, and adds nothing to the list
   until they do.

One choice covers every planned recipe that offers the same options.
"""

from dataclasses import dataclass, field
from typing import Any, Literal

Reason = Literal["diet", "chosen", "on_hand", "needed", "pending"]


@dataclass
class Option:
    ingredient_id: str
    name: str
    # What buying this option adds to the week, against not buying either.
    cents: int | None = None


@dataclass
class Choice:
    """One set of options the planned recipes offer, and how it was settled."""

    # The options' ingredient ids, sorted and joined: how a choice is saved.
    key: str
    options: list[Option]
    # The option used, or None while it waits for the user.
    chosen: str | None
    reason: Reason
    # How many planned recipes offer these options.
    recipes: int = 0
    # The recipes' own wording, for showing which line this is.
    lines: list[str] = field(default_factory=list)


def _fits(info: dict[str, Any], rules: dict[str, Any]) -> bool:
    """Whether an ingredient fits the user's rules: their diets and exclusions
    (with "may contain" counting only when they're strict), allergies (always
    strict) and dislikes."""
    contains = set(info.get("contains") or [])
    maybe = set(info.get("may_contain") or [])
    excludes = set(rules.get("excludes") or [])
    allergens = set(rules.get("allergens") or [])
    if contains & excludes or (rules.get("strict") and maybe & excludes):
        return False
    return not ((contains | maybe) & allergens) and not info.get("disliked")


def _groups(lines: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """A recipe's lines grouped by line number, options in order. A line with
    no number stands alone."""
    groups: dict[Any, list[dict[str, Any]]] = {}
    for n, line in enumerate(lines):
        groups.setdefault(line.get("line_no", ("alone", n)), []).append(line)
    return [sorted(g, key=lambda line: line.get("option_no") or 1) for g in groups.values()]


def settle(
    inputs: dict[str, Any], force: dict[str, str] | None = None
) -> tuple[list[dict[str, Any]], list[Choice]]:
    """The entries with each "or" line down to the option bought (or none,
    while it waits), and the planned recipes' choices. `force` overrides how
    a choice is settled (an ingredient id, or "" for neither), for pricing
    each option."""
    info: dict[str, dict[str, Any]] = inputs.get("ingredients", {})
    rules: dict[str, Any] = inputs.get("rules") or {}
    saved: dict[str, str] = inputs.get("choices") or {}
    entries = inputs.get("entries", [])

    def options_of(group: list[dict[str, Any]]) -> list[str]:
        ids = [line.get("ingredient_id") for line in group]
        return list(dict.fromkeys(i for i in ids if i and i in info))

    # What the planned recipes need on its own: bought anyway.
    needed: set[str] = set()
    for entry in entries:
        if entry.get("candidate"):
            continue
        for group in _groups(entry["lines"]):
            if len(options_of(group)) == 1 and len(group) == 1:
                needed.add(group[0]["ingredient_id"])

    choices: dict[str, Choice] = {}
    settled = []
    for entry in entries:
        lines = []
        for group in _groups(entry["lines"]):
            options = options_of(group)
            if len(group) == 1 or len(options) <= 1:
                # Not a choice: the one option (or the line as written, unmatched).
                pick = options[0] if options else None
                lines.append(
                    next((ln for ln in group if ln.get("ingredient_id") == pick), group[0])
                )
                continue
            fitting = [o for o in options if _fits(info[o], rules)] or options
            key = ",".join(sorted(options))
            chosen: str | None
            if force is not None and key in force:
                chosen, reason = force[key] or None, "chosen"
            elif len(fitting) == 1:
                chosen, reason = fitting[0], "diet"
            elif saved.get(key) in fitting:
                chosen, reason = saved[key], "chosen"
            elif any(info[o].get("pantry") == "have" for o in fitting):
                chosen = next(o for o in fitting if info[o].get("pantry") == "have")
                reason = "on_hand"
            elif any(o in needed for o in fitting):
                chosen, reason = next(o for o in fitting if o in needed), "needed"
            else:
                chosen, reason = None, "pending"
            if chosen is not None:
                lines.append(next(ln for ln in group if ln.get("ingredient_id") == chosen))
            if not entry.get("candidate"):
                choice = choices.setdefault(
                    key,
                    Choice(
                        key=key,
                        options=[Option(o, info[o].get("name") or o) for o in fitting],
                        chosen=chosen,
                        reason=reason,  # type: ignore[arg-type]
                    ),
                )
                choice.recipes += 1
                choice.lines.append(group[0].get("raw_text") or "")
        settled.append({**entry, "lines": lines})
    return settled, list(choices.values())
