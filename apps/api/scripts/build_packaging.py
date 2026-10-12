"""Turn data/packaging.csv into a migration that says how each ingredient is bought.

    .venv/bin/python scripts/build_packaging.py 20261012020000_packaging

The CSV is the readable source, one row per canonical ingredient:
  sold              "package" (bought whole: a can, a 2 lb bag, a bunch, one
                    lemon) or "loose" (bought by the amount needed: produce by
                    the pound, meat from the counter, bulk bins)
  package_quantity  typical package size, for "package" only
  package_unit      its unit (app/pricing/units.py), for "package" only
  staple            "yes" for pantry staples (salt, oil, spices) that most
                    kitchens keep; they're assumed on hand until the user's
                    pantry says otherwise

Rows update existing ingredients by name, so a new migration can be generated
whenever the CSV changes. Migrations already applied must not be edited.
"""

import csv
import sys
from pathlib import Path
from typing import Any

API = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API))

from app.pricing.units import KNOWN_UNITS  # noqa: E402

CSV = API / "data" / "packaging.csv"
MIGRATIONS = API.parent.parent / "supabase" / "migrations"


def sql_text(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def load() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    errors: list[str] = []
    for n, r in enumerate(csv.DictReader(CSV.open(encoding="utf-8")), 2):
        name, sold = r["name"].strip(), r["sold"].strip()
        qty, unit = r["package_quantity"].strip(), r["package_unit"].strip()
        if name in seen:
            errors.append(f"line {n}: duplicate {name}")
        seen.add(name)
        if r["staple"].strip() not in ("", "yes"):
            errors.append(f"line {n}: staple must be yes or empty")
        if sold == "package":
            try:
                ok = float(qty) > 0
            except ValueError:
                ok = False
            if not ok:
                errors.append(f"line {n}: {name} needs a package_quantity above 0")
            if unit not in KNOWN_UNITS:
                errors.append(f"line {n}: {name} has unknown package_unit {unit!r}")
        elif sold == "loose":
            if qty or unit:
                errors.append(f"line {n}: {name} is loose, so leave the package empty")
        else:
            errors.append(f"line {n}: sold must be package or loose, not {sold!r}")
        rows.append(
            {
                "name": name,
                "sold": sold,
                "qty": qty or None,
                "unit": unit or None,
                "staple": r["staple"].strip() == "yes",
            }
        )
    if errors:
        sys.exit("\n".join(errors))
    return rows


def migration(rows: list[dict[str, Any]]) -> str:
    values = ",\n".join(
        f"  ({sql_text(r['name'])}, {sql_text(r['sold'])}, "
        f"{r['qty'] or 'null'}, {sql_text(r['unit']) if r['unit'] else 'null'}, "
        f"{'true' if r['staple'] else 'false'})"
        for r in rows
    )
    return f"""-- How each ingredient is bought (TYL-15, TYL-18), generated from
-- apps/api/data/packaging.csv by apps/api/scripts/build_packaging.py. Edit the
-- CSV and generate a new migration; don't edit this file once applied.

update public.ingredients i set
  sold_by = v.sold_by,
  package_quantity = v.package_quantity,
  package_unit = v.package_unit,
  pantry_staple = v.pantry_staple
from (values
{values}
) as v(name, sold_by, package_quantity, package_unit, pantry_staple)
where lower(i.name) = v.name;
"""


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    rows = load()
    out = MIGRATIONS / f"{sys.argv[1]}.sql"
    if out.exists():
        sys.exit(f"{out.name} exists; migrations are append-only, pick a new name")
    out.write_text(migration(rows), encoding="utf-8")
    loose = sum(r["sold"] == "loose" for r in rows)
    staples = sum(r["staple"] for r in rows)
    print(f"wrote {out.name}: {len(rows)} ingredients ({loose} loose, {staples} staples)")
