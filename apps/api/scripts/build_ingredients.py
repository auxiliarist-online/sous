"""Turn data/ingredients.csv into a migration that adds canonical ingredients.

    .venv/bin/python scripts/build_ingredients.py 20261011020000_more_ingredients

The CSV is the readable source: name, aisle, contains, may_contain (both
"|"-separated diet categories) and aliases ("|"-separated). Existing
ingredients and aliases are left alone (on conflict do nothing), so a new
migration can be generated whenever rows are added. Migrations already
applied must not be edited; generate a new one instead.
"""

import csv
import sys
from pathlib import Path
from typing import Any

API = Path(__file__).resolve().parents[1]
CSV = API / "data" / "ingredients.csv"
# Other names for ingredients that aren't in the CSV (seeded by earlier
# migrations, like sugar or vegetable oil): alias,ingredient.
EXTRA_ALIASES = API / "data" / "extra_aliases.csv"
MIGRATIONS = API.parent.parent / "supabase" / "migrations"

AISLES = {
    "produce", "dairy_eggs", "meat_seafood", "bakery", "pantry", "spices", "frozen",
    "beverages", "international", "other",
}  # fmt: skip
# Must match public.valid_contains() in the migrations.
CATEGORIES = {
    "meat", "pork", "poultry", "fish", "shellfish", "gelatin", "animal_rennet", "dairy",
    "egg", "honey", "gluten", "tree_nut", "peanut", "soy", "sesame", "alcohol",
}  # fmt: skip


def split(cell: str) -> list[str]:
    return [p.strip() for p in cell.split("|") if p.strip()]


def sql_text(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def sql_array(items: list[str]) -> str:
    return "'{" + ",".join(items) + "}'"


def load() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    names: set[str] = set()
    aliases: dict[str, str] = {}
    errors: list[str] = []
    for n, r in enumerate(csv.DictReader(CSV.open(encoding="utf-8")), 2):
        name = r["name"].strip()
        contains, may = split(r["contains"]), split(r["may_contain"])
        al = split(r["aliases"])
        if name != name.lower():
            errors.append(f"line {n}: name must be lowercase: {name}")
        if r["aisle"] not in AISLES:
            errors.append(f"line {n}: unknown aisle {r['aisle']}")
        for c in contains + may:
            if c not in CATEGORIES:
                errors.append(f"line {n}: unknown category {c}")
        if set(contains) & set(may):
            errors.append(
                f"line {n}: {name} both contains and may contain {set(contains) & set(may)}"
            )
        if "pork" in contains and "meat" not in contains:
            errors.append(f"line {n}: pork must also be tagged meat")
        if name in names:
            errors.append(f"line {n}: duplicate name {name}")
        names.add(name)
        for a in al:
            if a != a.lower():
                errors.append(f"line {n}: alias must be lowercase: {a}")
            if a in aliases or a in names:
                errors.append(f"line {n}: alias {a!r} already used ({aliases.get(a, 'a name')})")
            aliases[a] = name
        rows.append(
            {"name": name, "aisle": r["aisle"], "contains": contains, "may": may, "aliases": al}
        )
    for n, r in enumerate(csv.DictReader(EXTRA_ALIASES.open(encoding="utf-8")), 2):
        a, owner = r["alias"].strip(), r["ingredient"].strip()
        if a != a.lower():
            errors.append(f"extra_aliases.csv line {n}: alias must be lowercase: {a}")
        if a in aliases or a in names:
            errors.append(f"extra_aliases.csv line {n}: alias {a!r} already used")
        aliases[a] = owner
        rows.append({"extra_alias": a, "name": owner})
    for a, owner in aliases.items():
        if a in names:
            errors.append(f"alias {a!r} (of {owner}) is also an ingredient name")
    if errors:
        sys.exit("\n".join(errors))
    return rows


def migration(rows: list[dict[str, Any]]) -> str:
    ingredients = ",\n".join(
        f"  ({sql_text(r['name'])}, {sql_text(r['aisle'])}, {sql_array(r['contains'])}, "
        f"{sql_array(r['may'])})"
        for r in rows
        if "extra_alias" not in r
    )
    aliases = ",\n".join(
        f"  ({sql_text(a)}, {sql_text(r['name'])})"
        for r in rows
        if "extra_alias" not in r
        for a in r["aliases"]
    )
    extra = ",\n".join(
        f"  ({sql_text(r['extra_alias'])}, {sql_text(r['name'])})"
        for r in rows
        if "extra_alias" in r
    )
    return f"""-- More canonical ingredients (TYL-9), generated from apps/api/data/ingredients.csv
-- by apps/api/scripts/build_ingredients.py. Edit the CSV and generate a new
-- migration; don't edit this file once applied.
--
-- contains: always in the ingredient. may_contain: depends on brand or recipe
-- (cheese may use animal rennet; curry paste may include shrimp paste).

insert into public.ingredients (name, aisle, contains, may_contain)
values
{ingredients}
on conflict ((lower(name))) do nothing;

insert into public.ingredient_aliases (alias, ingredient_id)
select v.alias, i.id
from (values
{aliases}
) as v(alias, canonical)
join public.ingredients i on lower(i.name) = v.canonical
on conflict (alias) do nothing;

-- data/extra_aliases.csv is authoritative: it adds aliases for ingredients
-- seeded elsewhere, and moves an alias that pointed at the wrong ingredient.
insert into public.ingredient_aliases (alias, ingredient_id)
select v.alias, i.id
from (values
{extra}
) as v(alias, canonical)
join public.ingredients i on lower(i.name) = v.canonical
on conflict (alias) do update set ingredient_id = excluded.ingredient_id;
"""


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    rows = load()
    out = MIGRATIONS / f"{sys.argv[1]}.sql"
    if out.exists():
        sys.exit(f"{out.name} exists; migrations are append-only, pick a new name")
    out.write_text(migration(rows), encoding="utf-8")
    ingredients = [r for r in rows if "extra_alias" not in r]
    total = sum(len(r["aliases"]) for r in ingredients) + len(rows) - len(ingredients)
    print(f"wrote {out.name}: {len(ingredients)} ingredients, {total} aliases")
