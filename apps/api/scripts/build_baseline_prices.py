"""Build baseline ingredient prices from public data (TYL-28).

Sources:
  * BLS average prices, South region, via DBnomics (staples; last published Jan 2025)
  * USDA ERS fruit and vegetable prices, national, 2023
  * data/seed_prices.csv: rough hand estimates for common items neither source covers

BLS and ERS prices are brought forward with the CPI "food at home" index from FRED.

Writes data/baseline_prices.csv and a Supabase migration that inserts the
ingredients and their prices. Run from apps/api:

    python scripts/build_baseline_prices.py
"""

import csv
import io
import json
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date
from pathlib import Path

API_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = API_DIR / "data"
MIGRATION = API_DIR.parent.parent / "supabase" / "migrations" / "20261007030000_baseline_prices.sql"

DBNOMICS_SOUTH = "https://api.db.nomics.world/v22/series/BLS/ap?" + urllib.parse.urlencode(
    {"dimensions": json.dumps({"area": ["0300"]}), "observations": 1, "limit": 1000}
)
FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={}"
ERS_VEGETABLES = (
    "https://www.ers.usda.gov/media/6240/all-vegetables-average-prices-csv-format.csv?v=70093"
)
ERS_FRUITS = "https://www.ers.usda.gov/media/6210/all-fruits-average-prices-csv-format.csv?v=12052"
USER_AGENT = "SousBot/0.1 (+https://github.com/auxiliarist-online/sous)"


@dataclass(frozen=True)
class Item:
    """How one source series maps to a Sous ingredient."""

    ingredient: str
    aisle: str
    contains: tuple[str, ...] = ()
    grams_per_cup: float | None = None
    grams_per_each: float | None = None
    may_contain: tuple[str, ...] = ()


# BLS item code -> ingredient, with the quantity and unit each series is priced in.
BLS_ITEMS: dict[str, tuple[Item, float, str]] = {
    "701111": (Item("all-purpose flour", "pantry", ("gluten",), 125), 1, "lb"),
    "701312": (Item("white rice", "pantry", (), 185), 1, "lb"),
    "701322": (Item("pasta", "pantry", ("gluten",), 100), 1, "lb"),
    "702111": (Item("white bread", "bakery", ("gluten",)), 1, "lb"),
    "703112": (Item("ground beef", "meat_seafood", ("meat",)), 1, "lb"),
    "703432": (Item("beef stew meat", "meat_seafood", ("meat",)), 1, "lb"),
    "704111": (Item("bacon", "meat_seafood", ("meat", "pork")), 1, "lb"),
    "704212": (Item("boneless pork chops", "meat_seafood", ("meat", "pork")), 1, "lb"),
    "706111": (Item("whole chicken", "meat_seafood", ("poultry",)), 1, "lb"),
    "706212": (Item("chicken legs", "meat_seafood", ("poultry",)), 1, "lb"),
    "FF1101": (Item("boneless chicken breast", "meat_seafood", ("poultry",)), 1, "lb"),
    "708111": (Item("eggs", "dairy_eggs", ("egg",), None, 50), 12, "each"),
    "709112": (Item("whole milk", "dairy_eggs", ("dairy",), 244), 1, "gallon"),
    "710212": (
        Item("cheddar cheese", "dairy_eggs", ("dairy",), 113, may_contain=("animal_rennet",)),
        1,
        "lb",
    ),
    "FJ4101": (Item("plain yogurt", "dairy_eggs", ("dairy",), 245), 8, "oz"),
    "711211": (Item("bananas", "produce", (), None, 118), 1, "lb"),
    "711311": (Item("oranges", "produce", (), None, 140), 1, "lb"),
    "711412": (Item("lemons", "produce", (), None, 85), 1, "lb"),
    "711415": (Item("strawberries", "produce", (), 152), 12, "oz"),
    "712112": (Item("potatoes", "produce", (), None, 213), 1, "lb"),
    "712311": (Item("tomatoes", "produce", (), 180, 123), 1, "lb"),
    "714233": (Item("dried beans", "pantry", (), 180), 1, "lb"),
    "715211": (Item("sugar", "pantry", (), 200), 1, "lb"),
    "FL2101": (Item("romaine lettuce", "produce", (), 47), 1, "lb"),
}

# (ERS name, form) -> ingredient. All ERS rows used here are priced per pound.
ERS_ITEMS: dict[tuple[str, str], Item] = {
    ("Asparagus", "Fresh"): Item("asparagus", "produce"),
    ("Avocados", "Fresh"): Item("avocado", "produce", (), 150, 200),
    ("Black beans", "Canned"): Item("canned black beans", "pantry", (), 172),
    ("Black beans", "Dried"): Item("dried black beans", "pantry", (), 194),
    ("Blackeye peas", "Canned"): Item("canned black-eyed peas", "pantry", (), 171),
    ("Blackeye peas", "Dried"): Item("dried black-eyed peas", "pantry", (), 167),
    ("Broccoli heads", "Fresh"): Item("broccoli", "produce", (), 91),
    ("Broccoli", "Frozen"): Item("frozen broccoli", "frozen", (), 91),
    ("Brussels sprouts", "Fresh"): Item("brussels sprouts", "produce", (), 88),
    ("Butternut squash", "Fresh"): Item("butternut squash", "produce", (), 140),
    ("Cabbage, green", "Fresh"): Item("green cabbage", "produce", (), 89),
    ("Cabbage, red", "Fresh"): Item("red cabbage", "produce", (), 89),
    ("Carrots, raw whole", "Fresh"): Item("carrots", "produce", (), 128, 61),
    ("Cauliflower heads", "Fresh"): Item("cauliflower", "produce", (), 107),
    ("Celery, trimmed bunches", "Fresh"): Item("celery", "produce", (), 101, 40),
    ("Collard greens", "Fresh"): Item("collard greens", "produce", (), 36),
    ("Corn", "Canned"): Item("canned corn", "pantry", (), 164),
    ("Corn", "Frozen"): Item("frozen corn", "frozen", (), 136),
    ("Cucumbers with peel", "Fresh"): Item("cucumber", "produce", (), 119, 300),
    ("Great northern beans", "Canned"): Item("canned white beans", "pantry", (), 179),
    ("Green beans", "Fresh"): Item("green beans", "produce", (), 100),
    ("Green peas", "Frozen"): Item("frozen peas", "frozen", (), 134),
    ("Green peppers", "Fresh"): Item("green bell pepper", "produce", (), 149, 119),
    ("Kale", "Fresh"): Item("kale", "produce", (), 21),
    ("Kidney beans", "Canned"): Item("canned kidney beans", "pantry", (), 172),
    ("Lentils", "Dried"): Item("lentils", "pantry", (), 192),
    ("Mushrooms, whole", "Fresh"): Item("mushrooms", "produce", (), 70, 18),
    ("Okra", "Fresh"): Item("okra", "produce", (), 100),
    ("Olives", "Canned"): Item("olives", "pantry", (), 135),
    ("Onions", "Fresh"): Item("onion", "produce", (), 160, 150),
    ("Pinto beans", "Canned"): Item("canned pinto beans", "pantry", (), 171),
    ("Pinto beans", "Dried"): Item("dried pinto beans", "pantry", (), 193),
    ("Pumpkin", "Canned"): Item("canned pumpkin", "pantry", (), 245),
    ("Radish", "Fresh"): Item("radishes", "produce", (), 116),
    ("Red peppers", "Fresh"): Item("red bell pepper", "produce", (), 149, 119),
    ("Spinach, eaten raw", "Fresh"): Item("spinach", "produce", (), 30),
    ("Spinach", "Frozen"): Item("frozen spinach", "frozen", (), 156),
    ("Sweet potatoes", "Fresh"): Item("sweet potatoes", "produce", (), 133, 130),
    ("Tomatoes, grape and cherry", "Fresh"): Item("cherry tomatoes", "produce", (), 149),
    ("Tomatoes, Roma and plum", "Fresh"): Item("roma tomatoes", "produce", (), 180, 62),
    ("Tomatoes", "Canned"): Item("canned tomatoes", "pantry", (), 240),
    ("Zucchini", "Fresh"): Item("zucchini", "produce", (), 124, 196),
    ("Apples", "Fresh"): Item("apples", "produce", (), 125, 182),
    ("Blueberries", "Fresh"): Item("blueberries", "produce", (), 148),
    ("Blueberries", "Frozen"): Item("frozen blueberries", "frozen", (), 155),
    ("Cranberries", "Dried"): Item("dried cranberries", "pantry", (), 121),
    ("Dates", "Dried"): Item("dates", "pantry", (), 147, 24),
    ("Grapes", "Fresh"): Item("grapes", "produce", (), 151),
    ("Grapes (raisins)", "Dried"): Item("raisins", "pantry", (), 145),
    ("Mangoes", "Fresh"): Item("mango", "produce", (), 165, 336),
    ("Peaches", "Fresh"): Item("peaches", "produce", (), 154, 150),
    ("Pears", "Fresh"): Item("pears", "produce", (), 140, 178),
    ("Pineapple", "Fresh"): Item("pineapple", "produce", (), 165, 905),
    ("Strawberries", "Frozen"): Item("frozen strawberries", "frozen", (), 149),
}

COLUMNS = [
    "ingredient",
    "aisle",
    "contains",
    "may_contain",
    "grams_per_cup",
    "grams_per_each",
    "source",
    "price_cents",
    "quantity",
    "unit",
    "region",
    "as_of",
    "source_ref",
    "note",
]


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return str(response.read().decode("utf-8-sig"))


def cpi(series_id: str) -> dict[str, float]:
    """Monthly CPI values keyed by YYYY-MM."""
    rows = csv.DictReader(io.StringIO(fetch(FRED_CSV.format(series_id))))
    return {
        r["observation_date"][:7]: float(r[series_id])
        for r in rows
        if r[series_id] not in ("", ".")
    }


def row(
    item: Item, source: str, price: float, quantity: float, unit: str, **extra: str
) -> dict[str, str]:
    return {
        "ingredient": item.ingredient,
        "aisle": item.aisle,
        "contains": "|".join(item.contains),
        "may_contain": "|".join(item.may_contain),
        "grams_per_cup": "" if item.grams_per_cup is None else f"{item.grams_per_cup:g}",
        "grams_per_each": "" if item.grams_per_each is None else f"{item.grams_per_each:g}",
        "source": source,
        "price_cents": str(round(price * 100)),
        "quantity": f"{quantity:g}",
        "unit": unit,
        **extra,
    }


def bls_rows(south_cpi: dict[str, float], as_of: str) -> list[dict[str, str]]:
    docs = json.loads(fetch(DBNOMICS_SOUTH))["series"]["docs"]
    rows = []
    for doc in docs:
        code = doc["series_code"][-6:]
        if code not in BLS_ITEMS:
            continue
        item, quantity, unit = BLS_ITEMS[code]
        period, value = doc["period"][-1], doc["value"][-1]
        factor = south_cpi[as_of] / south_cpi[period]
        rows.append(
            row(
                item,
                "baseline_bls",
                float(value) * factor,
                quantity,
                unit,
                region="south",
                as_of=as_of,
                source_ref=doc["series_code"],
                note=f"BLS South {period} ${float(value):.2f}, CPI-adjusted x{factor:.3f}",
            )
        )
    return rows


def ers_rows(us_cpi: dict[str, float], as_of: str) -> list[dict[str, str]]:
    base = sum(v for k, v in us_cpi.items() if k.startswith("2023")) / 12
    factor = us_cpi[as_of] / base
    rows = []
    for url, name_col in ((ERS_VEGETABLES, "Vegetable"), (ERS_FRUITS, "Fruit")):
        for r in csv.DictReader(io.StringIO(fetch(url))):
            key = (r[name_col].strip(), r["Form"].strip())
            if key not in ERS_ITEMS:
                continue
            if r["AverageRetailPriceUnitOfMeasure"].strip() != "per pound":
                raise ValueError(f"unexpected unit for {key}")
            price = float(r["AverageRetailPrice"])
            rows.append(
                row(
                    ERS_ITEMS[key],
                    "baseline_usda",
                    price * factor,
                    1,
                    "lb",
                    region="us",
                    as_of=as_of,
                    source_ref=f"USDA ERS {key[0]} ({key[1]})",
                    note=f"USDA ERS 2023 ${price:.2f}, CPI-adjusted x{factor:.3f}",
                )
            )
    return rows


def seed_rows() -> list[dict[str, str]]:
    rows = []
    with open(DATA_DIR / "seed_prices.csv", newline="") as f:
        for r in csv.DictReader(f):
            item = Item(
                r["ingredient"],
                r["aisle"],
                tuple(c for c in r["contains"].split("|") if c),
                float(r["grams_per_cup"]) if r["grams_per_cup"] else None,
                float(r["grams_per_each"]) if r["grams_per_each"] else None,
                tuple(c for c in r["may_contain"].split("|") if c),
            )
            rows.append(
                row(
                    item,
                    "seed",
                    float(r["price"]),
                    float(r["quantity"]),
                    r["unit"],
                    region="asheville",
                    as_of="2026-10",
                    source_ref="data/seed_prices.csv",
                    note=r["note"],
                )
            )
    return rows


def sql_literal(value: str) -> str:
    return "null" if value == "" else "'" + value.replace("'", "''") + "'"


def write_migration(rows: list[dict[str, str]]) -> None:
    ingredients: dict[str, dict[str, str]] = {}
    for r in rows:
        ingredients.setdefault(r["ingredient"], r)

    lines = [
        "-- Baseline ingredient prices (TYL-28). Generated by",
        "-- apps/api/scripts/build_baseline_prices.py; edit the script, not this file.",
        f"-- Generated {date.today().isoformat()} from BLS (South), USDA ERS and hand seeds.",
        "",
        "insert into public.ingredients",
        "  (name, aisle, contains, may_contain, grams_per_cup, grams_per_each)",
        "values",
    ]
    values = []
    for r in ingredients.values():
        contains = "'{" + ",".join(c for c in r["contains"].split("|") if c) + "}'"
        may_contain = "'{" + ",".join(c for c in r["may_contain"].split("|") if c) + "}'"
        values.append(
            f"  ({sql_literal(r['ingredient'])}, {sql_literal(r['aisle'])}, "
            f"{contains}, {may_contain}, "
            f"{r['grams_per_cup'] or 'null'}, {r['grams_per_each'] or 'null'})"
        )
    lines.append(",\n".join(values))
    lines += ["on conflict ((lower(name))) do nothing;", ""]

    lines += [
        "insert into public.prices",
        "  (source, ingredient_id, region, price_cents, quantity, unit, valid_from)",
        "select v.source, i.id, v.region, v.price_cents, v.quantity, v.unit, v.valid_from::date",
        "from (values",
    ]
    values = [
        f"  ({sql_literal(r['source'])}, {sql_literal(r['ingredient'])}, "
        f"{sql_literal(r['region'])}, {r['price_cents']}, {r['quantity']}, "
        f"{sql_literal(r['unit'])}, {sql_literal(r['as_of'] + '-01')})"
        for r in rows
    ]
    lines.append(",\n".join(values))
    lines += [
        ") as v (source, ingredient, region, price_cents, quantity, unit, valid_from)",
        "join public.ingredients i on lower(i.name) = lower(v.ingredient);",
        "",
    ]
    MIGRATION.write_text("\n".join(lines))


def main() -> None:
    south_cpi = cpi("CUUR0300SAF11")
    us_cpi = cpi("CUUR0000SAF11")
    as_of = max(set(south_cpi) & set(us_cpi))

    rows = bls_rows(south_cpi, as_of) + ers_rows(us_cpi, as_of) + seed_rows()
    rows.sort(key=lambda r: (r["aisle"], r["ingredient"]))

    names = [r["ingredient"] for r in rows]
    duplicates = {n for n in names if names.count(n) > 1}
    if duplicates:
        raise ValueError(f"ingredients priced by more than one source: {sorted(duplicates)}")

    with open(DATA_DIR / "baseline_prices.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    write_migration(rows)
    print(f"{len(rows)} ingredients priced; CPI as of {as_of}")


if __name__ == "__main__":
    main()
