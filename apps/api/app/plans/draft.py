"""Plan my week (TYL-65): draft the open dinners of a week from the user's saved
recipes. A scoring search, no model calls: fill each slot with the recipe that
makes the week best, then swap picks for better ones until none helps.

A week is better when it costs less (as the shopping trip is priced: whole
packages, the pantry), wastes less (what's left in the packages bought), stays
in the budget, mixes up proteins, cuisines and cooking styles as much as the
user wants (TYL-66), brings back favorites that are due, and cooks with the
seasons (TYL-70). Recipes that break the user's rules are never picked.
"""

import math
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.plans.cost import Item, PlanCost, _cost
from app.plans.options import settle

# How a draft is scored, in cents: a cent spent counts 1. Variety is a rule:
# its penalty outweighs any week's cost, so only a pool too small to keep it
# breaks it (and those weeks still compare by cost). Favorites come back on
# their rhythm unless that costs a lot more; what was just had waits its turn.
WASTE_WEIGHT = 0.5  # a cent of food left in a package
OVER_BUDGET_WEIGHT = 5  # each cent over the budget
REPEAT_PROTEIN = 10_000_000  # each dinner past two with the same main protein
REPEAT_CUISINE = 10_000_000  # each dinner past two of the same cuisine
REPEAT_STYLE = 10_000_000  # each dinner past two of the same cooking style
FAVORITE_DUE = 1500  # a favorite back on its rhythm (a bonus)
RECENT = 2000  # a recipe had lately (Variety.repeat_weeks) that isn't a favorite due
# Seasons (TYL-70): a little for each seasonal item in season, a little against
# each out of season; "Cook with the seasons" turns both up.
IN_SEASON = 150  # per item, up to SEASON_CAP of them
OUT_OF_SEASON = 200  # per item
SEASON_CAP = 3
SEASONS_UP = 3
MAX_SAME = 2
FAVORITE_WEEKS = {"weekly": 1, "biweekly": 2, "monthly": 4}
# Proteins as variety counts them (pork isn't counted as red meat too).
PROTEINS = ("poultry", "meat", "pork", "fish", "shellfish")
# How proteins are named in notes.
PROTEIN_NAMES = {
    "poultry": "poultry",
    "meat": "red meat",
    "pork": "pork",
    "fish": "fish",
    "shellfish": "shellfish",
}
# Cooking styles, from a recipe's title or the user's tags. Keep in step with
# STYLES in apps/web/src/variety.ts.
STYLES = {
    "soup": r"soups?|stews?|chowders?|bisques?|chili",
    "pasta": r"pastas?|spaghetti|penne|linguine|fettuccine|rigatoni|lasagnas?|macaroni|orzo"
    r"|ravioli|tortellini|gnocchi",
    "stir-fry": r"stir[- ]?fr(?:y|ies|ied)",
    "sheet pan": r"sheet[- ]pan|traybakes?",
    "curry": r"curry|curries|masala|korma|vindaloo",
    "taco": r"tacos?|burritos?|quesadillas?|enchiladas?|fajitas?",
    "salad": r"salads?",
    "casserole": r"casseroles?|gratins?",
}
_STYLE_RES = {k: re.compile(rf"\b(?:{v})\b", re.IGNORECASE) for k, v in STYLES.items()}


def cooking_styles(title: str, tags: list[str] | None = None) -> list[str]:
    """A recipe's cooking styles ("soup", "pasta"), from its title and the
    user's tags on it; none when neither says."""
    text = " ".join([title, *(tags or [])])
    return [k for k, r in _STYLE_RES.items() if r.search(text)]


@dataclass
class Variety:
    """How much variety the user wants (Preferences, "Variety"): mix up main
    proteins, cuisines and cooking styles (at most MAX_SAME dinners of each a
    week), and how many weeks before a recipe comes back (0: don't mind).
    Favorites come back at their own rhythm either way."""

    proteins: bool = True
    cuisines: bool = True
    styles: bool = True
    repeat_weeks: int = 3

    @classmethod
    def from_json(cls, d: dict[str, Any] | None) -> "Variety":
        """The settings as plan_draft_pool() sends them; defaults for any missing."""
        d = d or {}
        return cls(
            proteins=bool(d.get("proteins", True)),
            cuisines=bool(d.get("cuisines", True)),
            styles=bool(d.get("styles", True)),
            repeat_weeks=int(d.get("repeat_weeks", 3)),
        )


@dataclass
class Candidate:
    """A saved recipe the draft can pick, with what variety needs to know."""

    recipe_id: str
    title: str
    fit: str
    favorite: str | None = None
    weeks_ago: int | None = None
    cuisines: list[str] = field(default_factory=list)
    proteins: list[str] = field(default_factory=list)
    # The user's tags on it, and the cooking styles they and the title name.
    tags: list[str] = field(default_factory=list)
    styles: list[str] = field(default_factory=list)
    # Its seasonal produce in season the week planned, and how many aren't.
    in_season: list[str] = field(default_factory=list)
    out_of_season: int = 0

    @property
    def due(self) -> bool:
        """A favorite back on its rhythm: never had lately, or long enough ago."""
        if not self.favorite:
            return False
        return self.weeks_ago is None or self.weeks_ago >= FAVORITE_WEEKS[self.favorite]


@dataclass
class Pick:
    """A drafted dinner, why it was picked, and whether the user kept it."""

    recipe_id: str
    title: str
    reason: str
    locked: bool = False


@dataclass
class Leftover:
    """What's left of a package the week buys ("3 cup white rice")."""

    name: str
    quantity: float
    unit: str


@dataclass
class Draft:
    """What draft_week returns and the route sends: the picks, the week's
    total against the budget, what's left over, and notes for the user."""

    picks: list[Pick]
    total_cents: int
    budget_cents: int | None
    over_budget: bool
    leftovers: list[Leftover]
    notes: list[str]


def main_proteins(lines: list[dict[str, Any]], info: dict[str, dict[str, Any]]) -> list[str]:
    """A recipe's main proteins: its required ingredients from the meat and
    seafood counter (broth from the pantry isn't a chicken dinner)."""
    found: list[str] = []
    for line in lines:
        i = info.get(line.get("ingredient_id") or "")
        if not i or i.get("aisle") != "meat_seafood" or (line.get("option_no") or 1) != 1:
            continue
        contains = i.get("contains") or []
        kind = "pork" if "pork" in contains else next((p for p in PROTEINS if p in contains), None)
        if kind and kind not in found:
            found.append(kind)
    return found


class Week:
    """Scores sets of picks for one week: what's planned already, plus picks."""

    def __init__(
        self,
        inputs: dict[str, Any],
        pool: list[Candidate],
        *,
        on: date,
        store_id: str | None,
        seasons: float = 1,
        variety: Variety | None = None,
    ) -> None:
        """Split the inputs into what's planned and the candidates' lines, and
        work out each candidate's main proteins and cooking styles."""
        self.inputs = inputs
        self.on = on
        self.store_id = store_id
        self.info: dict[str, dict[str, Any]] = inputs.get("ingredients", {})
        entries = inputs.get("entries", [])
        self.planned = [e for e in entries if not e.get("candidate")]
        self.lines = {
            str(e["recipe_id"]): e for e in entries if e.get("candidate")
        }  # by recipe id, at full size
        self.pool = {c.recipe_id: c for c in pool if c.recipe_id in self.lines}
        for c in self.pool.values():
            c.proteins = main_proteins(self.lines[c.recipe_id]["lines"], self.info)
            c.styles = cooking_styles(c.title, c.tags)
        # What's planned counts toward variety too: its proteins from its
        # lines, its cuisines and styles when it's a saved recipe.
        self.planned_proteins = [
            p for e in self.planned for p in main_proteins(e["lines"], self.info)
        ]
        planned_saved = [
            self.pool[str(e["recipe_id"])] for e in self.planned if str(e["recipe_id"]) in self.pool
        ]
        self.planned_cuisines = [x for c in planned_saved for x in c.cuisines]
        self.planned_styles = [x for c in planned_saved for x in c.styles]
        self.variety = variety or Variety()
        self.budget: int | None = inputs.get("budget_cents")
        self.seasons = seasons
        self._memo: dict[frozenset[str], tuple[float, PlanCost]] = {}

    def cost(self, picks: frozenset[str]) -> PlanCost:
        """The week's shopping cost with these picks added."""
        return self._score(picks)[1]

    def score(self, picks: frozenset[str]) -> float:
        """Lower is better: cost, waste, over budget and variety, less the
        favorites that are due."""
        return self._score(picks)[0]

    def _score(self, picks: frozenset[str]) -> tuple[float, PlanCost]:
        """The (score, cost) of a set of picks, worked out once and memoized."""
        if picks in self._memo:
            return self._memo[picks]
        entries = [*self.planned] + [
            {**self.lines[r], "candidate": False, "id": f"draft-{r}"} for r in sorted(picks)
        ]
        settled = settle({**self.inputs, "entries": entries})[0]
        cost = _cost({**self.inputs, "entries": settled}, on=self.on, store_id=self.store_id)
        score = cost.total_cents + WASTE_WEIGHT * waste(cost.items)
        if self.budget is not None and cost.total_cents > self.budget:
            score += OVER_BUDGET_WEIGHT * (cost.total_cents - self.budget)
        chosen = [self.pool[r] for r in picks]
        for weight, counts in (
            (REPEAT_PROTEIN, self.proteins(picks)),
            (REPEAT_CUISINE, self.cuisines(picks)),
            (REPEAT_STYLE, self.styles(picks)),
        ):
            score += weight * sum(max(0, n - MAX_SAME) for n in counts.values())
        for c in chosen:
            if c.due:
                score -= FAVORITE_DUE
            elif self.recent(c):
                score += RECENT
            score -= self.seasons * IN_SEASON * min(SEASON_CAP, len(c.in_season))
            score += self.seasons * OUT_OF_SEASON * c.out_of_season
        self._memo[picks] = (score, cost)
        return score, cost

    def proteins(self, picks: frozenset[str]) -> dict[str, int]:
        """How many dinners have each main protein, planned and picked; none
        counted when the user doesn't mind."""
        if not self.variety.proteins:
            return {}
        return _count(self.planned_proteins + [p for r in picks for p in self.pool[r].proteins])

    def cuisines(self, picks: frozenset[str]) -> dict[str, int]:
        """How many dinners are of each cuisine, planned and picked."""
        if not self.variety.cuisines:
            return {}
        return _count(self.planned_cuisines + [x for r in picks for x in self.pool[r].cuisines])

    def styles(self, picks: frozenset[str]) -> dict[str, int]:
        """How many dinners are of each cooking style, planned and picked."""
        if not self.variety.styles:
            return {}
        return _count(self.planned_styles + [x for r in picks for x in self.pool[r].styles])

    def recent(self, c: Candidate) -> bool:
        """Had too lately to suggest again (a favorite that's due isn't)."""
        return c.weeks_ago is not None and c.weeks_ago < self.variety.repeat_weeks

    def broken(self, picks: frozenset[str]) -> list[str]:
        """The variety rules the picks still break, as notes: only a pool too
        small to keep them does that. Rules the user's own planned meals break
        alone aren't the draft's to mention."""
        notes = []
        for counts, picked, say in (
            (
                self.proteins(picks),
                {p for r in picks for p in self.pool[r].proteins},
                "{n} dinners with {k}",
            ),
            (
                self.cuisines(picks),
                {x for r in picks for x in self.pool[r].cuisines},
                "{n} {k} dinners",
            ),
            (self.styles(picks), {x for r in picks for x in self.pool[r].styles}, "{n} {k} nights"),
        ):
            notes += [
                say.format(n=n, k=PROTEIN_NAMES.get(k, k))
                for k, n in sorted(counts.items())
                if n > MAX_SAME and k in picked
            ]
        notes += [
            f"{self.pool[r].title} again so soon"
            for r in sorted(picks)
            if not self.pool[r].due and self.recent(self.pool[r])
        ]
        return notes


def _count(xs: list[str]) -> dict[str, int]:
    """How many times each value appears."""
    out: dict[str, int] = {}
    for x in xs:
        out[x] = out.get(x, 0) + 1
    return out


def waste(items: list[Item]) -> float:
    """What's left in the packages bought, in cents: half a $4 bunch is 200.
    Staples (salt, oil, spices) keep, so what's left of them isn't waste."""
    total = 0.0
    for i in items:
        if i.staple or not i.buy or not i.cents or not i.leftover or not i.packages:
            continue
        bought = (i.package_quantity or 0) * i.packages
        if bought > 0:
            total += i.cents * min(1.0, i.leftover / bought)
    return total


def draft_week(
    inputs: dict[str, Any],
    pool: list[Candidate],
    *,
    dinners: int,
    locked: list[str],
    exclude: list[str],
    on: date,
    store_id: str | None = None,
    cook_with_seasons: bool = False,
    variety: Variety | None = None,
) -> Draft:
    """Draft the week's open dinners. `inputs` is plan_cost_inputs() with the
    pool as candidates; `locked` picks stay; `exclude` are never picked (a
    swap). Planned dinners count toward `dinners` and stay as they are."""
    week = Week(
        inputs,
        pool,
        on=on,
        store_id=store_id,
        seasons=SEASONS_UP if cook_with_seasons else 1,
        variety=variety,
    )
    planned_ids = {str(e["recipe_id"]) for e in week.planned}
    keep = [
        r
        for r in dict.fromkeys(locked)
        if r in week.pool and r not in planned_ids and r not in exclude
    ]
    # Only dinners count (an entry without a meal is one); a planned lunch
    # stays in the week's cost but doesn't fill a night.
    planned_dinners = [e for e in week.planned if (e.get("meal") or "dinner") == "dinner"]
    open_slots = max(0, dinners - len(planned_dinners) - len(keep))
    eligible = [
        c.recipe_id
        for c in week.pool.values()
        if c.fit != "excluded"
        and c.recipe_id not in planned_ids
        and c.recipe_id not in exclude
        and c.recipe_id not in keep
    ]
    notes: list[str] = []
    if len(eligible) < open_slots:
        notes.append(
            f"Only {len(eligible)} of your saved recipes fit for this week; "
            "save more to fill every night."
        )
        open_slots = len(eligible)

    picks = set(keep)
    # Fill each slot with the recipe that makes the week best so far.
    for _ in range(open_slots):
        best = min(
            (r for r in eligible if r not in picks),
            key=lambda r: (week.score(frozenset(picks | {r})), r),
        )
        picks.add(best)
    # Then swap any pick for one that improves the week, until none does.
    for _ in range(4):
        improved = False
        for r in sorted(picks - set(keep)):
            current = week.score(frozenset(picks))
            others = [o for o in eligible if o not in picks]
            if not others:
                break
            better = min(others, key=lambda o: (week.score(frozenset(picks - {r} | {o})), o))
            if week.score(frozenset(picks - {r} | {better})) < current - 0.5:
                picks = picks - {r} | {better}
                improved = True
        if not improved:
            break

    final = frozenset(picks)
    broken = week.broken(final)
    if broken:
        notes.append(
            "Not enough of your saved recipes fit to mix things up more: "
            + "; ".join(broken)
            + ". Save a few more to vary it."
        )
    cost = week.cost(final)
    over = week.budget is not None and cost.total_cents > week.budget
    if over and week.budget is not None:
        over_by = math.ceil((cost.total_cents - week.budget) / 100)
        notes.append(f"This is the cheapest week we found, about ${over_by} over your budget.")
    order = [*keep, *sorted(final - set(keep), key=lambda r: week.pool[r].title)]
    return Draft(
        picks=[
            Pick(r, week.pool[r].title, reason(week, final, r), locked=r in keep) for r in order
        ],
        total_cents=cost.total_cents,
        budget_cents=week.budget,
        over_budget=over,
        leftovers=leftovers(cost.items),
        notes=notes,
    )


def reason(week: Week, picks: frozenset[str], recipe_id: str) -> str:
    """Why a recipe is in the draft, in a few words: a favorite that's due,
    produce in season, an ingredient it shares with another meal, or what it
    adds."""
    c = week.pool[recipe_id]
    if c.due:
        if not c.weeks_ago:
            return "A favorite you haven't had lately"
        weeks = "week" if c.weeks_ago == 1 else "weeks"
        return f"A favorite, last had {c.weeks_ago} {weeks} ago"
    if c.in_season and not c.out_of_season:
        return "In season: " + ", ".join(c.in_season[:3])
    without = {i.ingredient_id: i.cents for i in week.cost(picks - {recipe_id}).items}
    used = {
        line.get("ingredient_id")
        for line in week.lines[recipe_id]["lines"]
        if (line.get("option_no") or 1) == 1
    }
    shared = [
        i
        for i in week.cost(picks).items
        if i.ingredient_id in used
        and i.sold_by == "package"
        and not i.staple
        and i.cents
        and without.get(i.ingredient_id) == i.cents
    ]
    if shared:
        top = max(shared, key=lambda i: i.cents or 0)
        return f"Uses the rest of the {top.name}"
    added = week.cost(picks).total_cents - week.cost(picks - {recipe_id}).total_cents
    return f"Adds about ${max(0, round(added / 100))} to the week"


def leftovers(items: list[Item]) -> list[Leftover]:
    """What's left in the packages bought, worth mentioning: a quarter of a
    package or more, staples aside, most first."""
    out = []
    for i in items:
        if i.staple or not i.buy or not i.leftover or not i.packages or not i.package_unit:
            continue
        bought = (i.package_quantity or 0) * i.packages
        if bought and i.leftover / bought >= 0.25:
            # "fl_oz" is how units are stored; "fl oz" is how they read.
            out.append(Leftover(i.name, round(i.leftover, 1), i.package_unit.replace("_", " ")))
    return sorted(out, key=lambda x: -x.quantity)[:8]
