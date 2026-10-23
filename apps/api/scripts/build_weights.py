"""Fill in ingredient weights from USDA FoodData Central (TYL-60).

    .venv/bin/python scripts/build_weights.py <fdc_sr_legacy_dir> 20261012030000_ingredient_weights

<fdc_sr_legacy_dir> is the unzipped SR Legacy CSV download (public domain):
https://fdc.nal.usda.gov/download-datasets (food.csv, food_portion.csv).

data/fdc_map.csv is the hand-checked source: each ingredient's FDC food, by
its exact description (empty when there's no good match), and optionally the
portion to use for one item ("each": a modifier prefix like "large", or "-"
when "one" of it isn't a useful amount, like mixed greens).

Writes data/ingredient_weights.csv (for review) and a migration that sets
grams_per_cup (from a cup, tablespoon or teaspoon portion) and grams_per_each
(one medium item, or the chosen portion). Values already set by hand in
earlier migrations are kept.

It also builds the table of ingredient-specific units (TYL-79): a clove of
garlic, a stick of butter, a slice of bread, a bunch of cilantro. USDA
portions supply most; data/unit_equivalents.csv adds and corrects them by hand
(hand values win; unit "each" there sets grams_per_each and unit "cup" sets
grams_per_cup, for what USDA doesn't list). The result goes to
data/ingredient_units.csv and into the same migration (ingredient_units).
"""

import csv
import re
import sys
from pathlib import Path

API = Path(__file__).resolve().parents[1]
MAP = API / "data" / "fdc_map.csv"
OUT = API / "data" / "ingredient_weights.csv"
HAND_UNITS = API / "data" / "unit_equivalents.csv"
UNITS_OUT = API / "data" / "ingredient_units.csv"

# Units that depend on the ingredient, as USDA labels its portions. Each maps
# to the unit name recipes use ("leaves" -> "leaf").
UNIT_WORDS = {
    "clove": "clove", "cloves": "clove", "head": "head", "bunch": "bunch",
    "sprig": "sprig", "sprigs": "sprig", "slice": "slice", "slices": "slice",
    "stalk": "stalk", "rib": "rib", "ear": "ear", "leaf": "leaf", "leaves": "leaf",
    "strip": "strip", "strips": "strip", "fillet": "fillet", "link": "link",
    "wedge": "wedge", "spear": "spear", "stick": "stick", "bulb": "bulb",
    "sheet": "sheet", "sheets": "sheet", "pod": "pod", "pods": "pod",
}  # fmt: skip
MIGRATIONS = API.parent.parent / "supabase" / "migrations"

# What counts as "one" of an ingredient, in order of preference.
EACH = re.compile(
    r"^(medium|fruit|whole|each|large|head|stalk|breast|thigh|leg|drumstick|wing|fillet|"
    r"link|piece|bagel|muffin|tortilla|roll|pita|bun|egg)\b"
)
NOT_EACH = re.compile(r"\b(slice|leaf|spear|oz|serving|nlea|cubic|rings?|cup|tbsp|tsp|pat)\b")


def portions(rows: list[dict[str, str]]) -> list[tuple[str, float]]:
    out = []
    for p in rows:
        label = (p["modifier"] or p["portion_description"] or "").strip().lower()
        grams = float(p["gram_weight"]) / float(p["amount"] or 1)
        out.append((label, grams))
    return out


def per_cup(ps: list[tuple[str, float]]) -> float | None:
    """Grams in a cup. A plain cup first, then chopped, sliced or whole;
    never whipped, puréed or packed ("not packed" is fine), which aren't how
    recipes measure. Then a spoon, a fluid ounce (a drink), a serving given
    in cups ("serving 1/2 cup"), or a spoon in brackets ("envelope (1 tbsp)")."""
    loose = [(label.replace("not packed", "loose"), g) for label, g in ps]
    for pattern, factor in (
        (r"^cups?$", 1.0),
        (
            r"^cups?,? (fluid|chopped|sliced|diced|whole|shredded|grated|crumbled"
            r"|cubes|cubed|pieces|raw)",
            1.0,
        ),
        (r"^cups?\b(?!.*(whipped|pure|mashed|packed|juice|sections))", 1.0),
        (r"^(tbsp|tablespoons?)\b", 16.0),
        (r"^(tsp|teaspoons?)\b", 48.0),
        (r"^fl oz$", 8.0),
        (r"^serving 1/2 cup$", 2.0),
        (r"^serving 1 cup$", 1.0),
        (r"\(1 tbsp\)", 16.0),
        (r"\(1 tsp\)", 48.0),
    ):
        for label, grams in loose:
            if re.search(pattern, label):
                return grams * factor
    return None


def _forms(word: str) -> set[str]:
    """A word and the singulars it could have: "cubes" -> cube, "anchovies" ->
    anchovy, "tomatoes" -> tomato."""
    out = {word}
    if word.endswith("ies"):
        out.add(word[:-3] + "y")
    if word.endswith("es"):
        out.add(word[:-2])
    if word.endswith("s") and not word.endswith("ss"):
        out.add(word[:-1])
    return out


def per_each(ps: list[tuple[str, float]], choice: str, name: str = "") -> float | None:
    """Grams in one: the chosen portion, else a medium (or whole, or large)
    one, else a portion named after the food itself ("croissant, medium",
    "anchovy" for anchovies, "pomegranate (4" dia)")."""
    if choice == "-":
        return None
    if choice:
        for label, grams in ps:
            if label.startswith(choice.lower()):
                return grams
        return None
    candidates = [(label, g) for label, g in ps if EACH.match(label) and not NOT_EACH.search(label)]
    for word in ("medium", "fruit", "whole", "each", "large"):
        for label, g in candidates:
            if label.startswith(word):
                return g
    if candidates:
        return candidates[0][1]
    own = _forms(name.split()[-1]) if name else set()
    named = [
        (label, g)
        for label, g in ps
        if own & _forms(re.split(r"[ ,(]", label)[0]) and not NOT_EACH.search(label)
    ]
    for label, g in named:
        if "medium" in label:
            return g
    return named[0][1] if named else None


def unit_portions(ps: list[tuple[str, float]]) -> dict[str, float]:
    """Ingredient-specific units from USDA portions, preferring a medium one
    ("slice, medium" over "slice, thin")."""
    found: dict[str, tuple[int, float]] = {}
    for label, grams in ps:
        word = re.match(r"^([a-z]+)", label)
        unit = UNIT_WORDS.get(word.group(1)) if word else None
        if not unit:
            continue
        rank = 0 if "medium" in label else 1 if re.fullmatch(r"[a-z]+", label) else 2
        if unit not in found or rank < found[unit][0]:
            found[unit] = (rank, grams)
    return {u: g for u, (_, g) in found.items()}


def build_units(fdc: Path, rows: list[dict[str, str]]) -> list[dict[str, str]]:
    ids = {r["description"]: r["fdc_id"] for r in csv.DictReader((fdc / "food.csv").open())}
    by_food: dict[str, list[dict[str, str]]] = {}
    for p in csv.DictReader((fdc / "food_portion.csv").open()):
        by_food.setdefault(p["fdc_id"], []).append(p)
    units: dict[tuple[str, str], dict[str, str]] = {}
    for r in rows:
        fid = ids.get(r["fdc_description"], "")
        for unit, grams in unit_portions(portions(by_food.get(fid, []))).items():
            units[(r["name"], unit)] = {
                "ingredient": r["name"],
                "unit": unit,
                "grams": f"{round(grams, 1):g}",
                "source": "usda",
            }
    names = {r["name"] for r in rows}
    errors = []
    for n, h in enumerate(csv.DictReader(HAND_UNITS.open(encoding="utf-8")), 2):
        if h["ingredient"] not in names:
            errors.append(f"unit_equivalents.csv line {n}: unknown ingredient {h['ingredient']!r}")
        if not re.fullmatch(r"[a-z_]+", h["unit"]) or float(h["grams"]) <= 0:
            errors.append(f"unit_equivalents.csv line {n}: bad unit or grams")
        units[(h["ingredient"], h["unit"])] = {
            "ingredient": h["ingredient"], "unit": h["unit"], "grams": h["grams"], "source": "hand"
        }  # fmt: skip
    if errors:
        sys.exit("\n".join(errors))
    return sorted(units.values(), key=lambda u: (u["ingredient"], u["unit"]))


def build(fdc: Path) -> list[dict[str, str]]:
    """Each ingredient in data/fdc_map.csv with its cup and item weights,
    read from the USDA portions of the food it maps to."""
    ids = {r["description"]: r["fdc_id"] for r in csv.DictReader((fdc / "food.csv").open())}
    by_food: dict[str, list[dict[str, str]]] = {}
    for p in csv.DictReader((fdc / "food_portion.csv").open()):
        by_food.setdefault(p["fdc_id"], []).append(p)
    rows, errors = [], []
    for n, r in enumerate(csv.DictReader(MAP.open(encoding="utf-8")), 2):
        desc = r["fdc_description"].strip()
        fid = ids.get(desc, "") if desc else ""
        if desc and not fid:
            errors.append(f"line {n}: no FDC food named {desc!r}")
        ps = portions(by_food.get(fid, []))
        cup, each = per_cup(ps), per_each(ps, r["each"].strip(), r["name"].strip())
        rows.append(
            {
                "name": r["name"].strip(),
                "fdc_id": fid,
                "fdc_description": desc,
                "grams_per_cup": f"{cup:.1f}" if cup else "",
                "grams_per_each": f"{each:.1f}" if each else "",
            }
        )
    if errors:
        sys.exit("\n".join(errors))
    return rows


def sql_text(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def migration(rows: list[dict[str, str]], units: list[dict[str, str]]) -> str:
    """The weights and units as a migration: weights fill only what's empty,
    hand weights for one win over USDA's, and units are upserted."""
    # A hand weight for "one" corrects USDA's (a habanero isn't a medium
    # chili), so USDA's isn't used for those.
    hand_each = {u["ingredient"] for u in units if u["unit"] == "each" and u["source"] == "hand"}
    values = ",\n".join(
        f"  ({sql_text(r['name'])}, {r['grams_per_cup'] or 'null'}, "
        f"{'null' if r['name'] in hand_each else r['grams_per_each'] or 'null'})"
        for r in rows
        if r["grams_per_cup"] or (r["grams_per_each"] and r["name"] not in hand_each)
    )
    each = ",\n".join(
        f"  ({sql_text(u['ingredient'])}, {u['grams']})"
        for u in units
        if u["unit"] == "each" and u["source"] == "hand"
    )
    cup = ",\n".join(
        f"  ({sql_text(u['ingredient'])}, {u['grams']})"
        for u in units
        if u["unit"] == "cup" and u["source"] == "hand"
    )
    unit_values = ",\n".join(
        f"  ({sql_text(u['ingredient'])}, {sql_text(u['unit'])}, {u['grams']}, "
        f"{sql_text(u['source'])})"
        for u in units
        if u["unit"] not in ("each", "cup")
    )
    return f"""-- Ingredient weights and units from USDA FoodData Central, SR Legacy (public
-- domain), and data/unit_equivalents.csv; generated by
-- apps/api/scripts/build_weights.py. Weights set by hand earlier are kept.
-- Don't edit this file once applied.

update public.ingredients i set
  grams_per_cup = coalesce(i.grams_per_cup, v.grams_per_cup),
  grams_per_each = coalesce(i.grams_per_each, v.grams_per_each)
from (values
{values}
) as v(name, grams_per_cup, grams_per_each)
where lower(i.name) = v.name;

-- "One" of these, by hand (a head of garlic), where USDA has none.
update public.ingredients i set grams_per_each = coalesce(i.grams_per_each, v.grams)
from (values
{each}
) as v(name, grams)
where lower(i.name) = v.name;

-- A cup of these, by hand (a spice blend, a paste), where USDA has none.
update public.ingredients i set grams_per_cup = coalesce(i.grams_per_cup, v.grams)
from (values
{cup}
) as v(name, grams)
where lower(i.name) = v.name;

-- Ingredient-specific units: a clove of garlic, a stick of butter.
insert into public.ingredient_units (ingredient_id, unit, grams, source)
select i.id, v.unit, v.grams, v.source
from (values
{unit_values}
) as v(name, unit, grams, source)
join public.ingredients i on lower(i.name) = v.name
on conflict (ingredient_id, unit) do update set grams = excluded.grams, source = excluded.source;
"""


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    rows = build(Path(sys.argv[1]))
    units = build_units(Path(sys.argv[1]), rows)
    with UNITS_OUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(
            f, fieldnames=["ingredient", "unit", "grams", "source"], lineterminator="\n"
        )
        w.writeheader()
        w.writerows(units)
    with OUT.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    out = MIGRATIONS / f"{sys.argv[2]}.sql"
    if out.exists():
        sys.exit(f"{out.name} exists; migrations are append-only, pick a new name")
    out.write_text(migration(rows, units), encoding="utf-8")
    cup = sum(1 for r in rows if r["grams_per_cup"])
    each = sum(1 for r in rows if r["grams_per_each"])
    print(
        f"wrote {out.name}: {len(rows)} ingredients, "
        f"{cup} with cup weights, {each} with item weights, {len(units)} units"
    )
