"""Pick the Harris Teeter product Sous buys for each ingredient (TYL-80).

    .venv/bin/python scripts/match_kroger.py            # print the picks, write nothing
    .venv/bin/python scripts/match_kroger.py --write    # save them
    .venv/bin/python scripts/match_kroger.py --only eggs --only "all-purpose flour"

One product search per ingredient (Products allows 10,000 calls a day). The
rules are in app/pricing/kroger_match.py; data/kroger_overrides.csv fixes the
picks they get wrong (a blank product_id means "don't buy this from Kroger").
Ingredients bought as another (egg yolks -> eggs) are skipped.

Only product ids are saved, never Kroger's names, sizes or prices (their terms,
§5e.1). The printed list is for reviewing the picks; don't keep it. Needs
KROGER_CLIENT_ID and KROGER_CLIENT_SECRET, and the service role, in .env.
"""

import argparse
import csv
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx2 as httpx

API = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(API))

from app.config import settings  # noqa: E402
from app.pricing.kroger import Kroger, Product  # noqa: E402
from app.pricing.kroger_match import choose, search_term  # noqa: E402
from app.pricing.units import UnknownUnitError, normalize_unit  # noqa: E402

LOCATION = "09700348"  # Harris Teeter, Village at Chestnut Street, Asheville
OVERRIDES = API / "data" / "kroger_overrides.csv"


def overrides() -> dict[str, str]:
    rows = csv.DictReader(OVERRIDES.open(encoding="utf-8"))
    return {r["ingredient"].strip(): r["product_id"].strip() for r in rows}


def package(i: dict[str, Any]) -> tuple[float, str] | None:
    if i.get("sold_by") != "package" or not i.get("package_quantity") or not i.get("package_unit"):
        return None
    try:
        return float(i["package_quantity"]), normalize_unit(i["package_unit"])
    except UnknownUnitError:
        return None


def describe(p: Product) -> str:
    price = f"${p.regular:.2f}" + (f" (sale ${p.promo:.2f})" if p.promo else "")
    return f"{p.description} | {p.size} | {p.sold_by} | {price}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--write", action="store_true", help="save the picks")
    parser.add_argument("--only", action="append", help="match just this ingredient")
    args = parser.parse_args()

    key = settings.supabase_service_role_key
    db = httpx.Client(
        base_url=f"{settings.supabase_url}/rest/v1",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        timeout=60.0,
    )
    stores = db.get(
        "/stores", params={"select": "id", "external_location_id": f"eq.{LOCATION}"}
    ).json()
    if not stores:
        sys.exit(f"no store with location {LOCATION}; apply the migrations first")
    store_id = stores[0]["id"]
    ingredients = db.get(
        "/ingredients",
        params={
            "select": "id,name,aisle,buy_as,sold_by,package_quantity,package_unit,"
            "grams_per_cup,grams_per_each",
            "order": "name",
        },
    ).json()
    names = [i["name"] for i in ingredients]
    fixed = overrides()
    unknown = set(fixed) - set(names)
    if unknown:
        sys.exit(f"kroger_overrides.csv names unknown ingredients: {sorted(unknown)}")

    picks: list[dict[str, str]] = []
    missed: list[str] = []  # ingredient ids
    with httpx.Client(timeout=30.0) as client:
        kroger = Kroger(client)
        for i in ingredients:
            name = i["name"]
            if i["buy_as"] or (args.only and name not in args.only):
                continue
            if name in fixed:
                if fixed[name]:
                    picks.append(
                        {"ingredient_id": i["id"], "product_id": fixed[name], "source": "manual"}
                    )
                    print(f"{name}: {fixed[name]} (override)")
                continue
            found = kroger.search(search_term(name), LOCATION)
            time.sleep(0.2)
            pick = choose(
                name,
                found,
                names,
                package(i),
                i["grams_per_cup"],
                i["grams_per_each"],
                i["aisle"],
            )
            if pick is None:
                missed.append(i["id"])
                print(f"{name}: no match")
                continue
            picks.append(
                {"ingredient_id": i["id"], "product_id": pick.product_id, "source": "auto"}
            )
            print(f"{name}: {describe(pick)}")

    print(f"\n{len(picks)} matched, {len(missed)} without a match")
    if not args.write:
        return
    now = datetime.now(UTC).isoformat()
    rows = [{**p, "store_id": store_id, "matched_at": now} for p in picks]
    resp = db.post(
        "/kroger_product_matches",
        params={"on_conflict": "ingredient_id,store_id"},
        headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        json=rows,
    )
    resp.raise_for_status()
    print(f"saved {len(rows)} matches")
    if missed and not args.only:
        # A product that's gone and has no replacement: price from estimates.
        db.delete(
            "/kroger_product_matches",
            params={
                "store_id": f"eq.{store_id}",
                "source": "eq.auto",
                "ingredient_id": f"in.({','.join(missed)})",
            },
        ).raise_for_status()


if __name__ == "__main__":
    main()
