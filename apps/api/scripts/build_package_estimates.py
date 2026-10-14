"""Turn data/package_estimates.csv into a migration of rough prices (TYL-61).

    .venv/bin/python scripts/build_package_estimates.py 20261014040000_package_estimates

One hand estimate per ingredient that no baseline covers: the price of its usual
package (as in data/packaging.csv), or per pound for what's sold loose. They're
stored as source "seed", shown as estimates, and give way to store prices. An
ingredient that already has a seed price is left alone, so a new migration can
be generated whenever rows are added. Migrations already applied must not be
edited.
"""

import csv
import sys
from datetime import date
from pathlib import Path

API = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API))

from app.pricing.units import UnknownUnitError, normalize_unit  # noqa: E402

CSV = API / "data" / "package_estimates.csv"
PACKAGING = API / "data" / "packaging.csv"
UNITS = API / "data" / "ingredient_units.csv"
MIGRATIONS = API.parent.parent / "supabase" / "migrations"


def sql_text(s: str) -> str:
    """A SQL string literal."""
    return "'" + s.replace("'", "''") + "'"


def load() -> list[tuple[str, int, float, str]]:
    """(ingredient, cents, quantity, unit) per row, or exit listing every problem."""
    known = {r["name"].strip() for r in csv.DictReader(PACKAGING.open(encoding="utf-8"))}
    # Units defined for one ingredient ("bunch" of cilantro).
    own = {
        (r["ingredient"].strip(), r["unit"].strip())
        for r in csv.DictReader(UNITS.open(encoding="utf-8"))
    }
    rows, seen, errors = [], set(), []
    for n, r in enumerate(csv.DictReader(CSV.open(encoding="utf-8")), 2):
        name, unit = r["ingredient"].strip(), r["unit"].strip()
        if name not in known:
            errors.append(f"line {n}: {name!r} isn't in packaging.csv")
        if name in seen:
            errors.append(f"line {n}: duplicate {name!r}")
        seen.add(name)
        try:
            price, qty = float(r["price"]), float(r["quantity"])
        except ValueError:
            errors.append(f"line {n}: price and quantity must be numbers")
            continue
        if price <= 0 or qty <= 0:
            errors.append(f"line {n}: price and quantity must be positive")
        if (name, unit) not in own:
            try:
                unit = normalize_unit(unit)
            except UnknownUnitError:
                errors.append(f"line {n}: unknown unit {unit!r} for {name}")
        rows.append((name, round(price * 100), qty, unit))
    if errors:
        sys.exit("\n".join(errors))
    return rows


def migration(rows: list[tuple[str, int, float, str]], on: date) -> str:
    """The migration's SQL: insert each estimate, dated `on`, unless seeded already."""
    values = ",\n".join(
        f"  ({sql_text(name)}, {cents}, {qty:g}, {sql_text(unit)})"
        for name, cents, qty, unit in rows
    )
    return f"""-- Rough package prices (TYL-61), generated from apps/api/data/package_estimates.csv
-- by apps/api/scripts/build_package_estimates.py. Edit the CSV and generate a
-- new migration; don't edit this file once applied.
--
-- Hand estimates for ingredients no baseline covers, so every ingredient has
-- some price. Shown as estimates; store prices win when there are some.

insert into public.prices (source, ingredient_id, region, price_cents, quantity, unit, valid_from)
select 'seed', i.id, 'asheville', v.price_cents, v.quantity, v.unit, date '{on.isoformat()}'
from (values
{values}
) as v(name, price_cents, quantity, unit)
join public.ingredients i on lower(i.name) = v.name
where not exists (
  select 1 from public.prices p where p.ingredient_id = i.id and p.source = 'seed'
);
"""


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = MIGRATIONS / f"{sys.argv[1]}.sql"
    if out.exists():
        sys.exit(f"{out.name} exists; migrations are append-only, pick a new name")
    rows = load()
    out.write_text(migration(rows, date.today()), encoding="utf-8")
    print(f"wrote {out.name}: {len(rows)} prices")
