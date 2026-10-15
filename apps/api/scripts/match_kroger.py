"""Pick the Harris Teeter product Sous buys for each ingredient (TYL-80).

    .venv/bin/python scripts/match_kroger.py            # print the picks, write nothing
    .venv/bin/python scripts/match_kroger.py --write    # save them
    .venv/bin/python scripts/match_kroger.py --only eggs --only "all-purpose flour"
    .venv/bin/python scripts/match_kroger.py --location 02900540 --write   # a Kroger

Stores of a chain carry the same products, so one store's picks serve the
whole chain (TYL-19): the Asheville Harris Teeter for every Harris Teeter, and
one Kroger for Kroger and the chains that sell its brand. A store that isn't
in the database yet is looked up with Kroger and added.

One product search per ingredient (Products allows 10,000 calls a day). The
rules are in app/pricing/kroger_match.py; data/kroger_overrides.csv fixes the
picks they get wrong (a blank product_id means "no match: price from estimates";
a chain column limits a row to that chain).
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
from app.stores.routes import chain_slug  # noqa: E402

LOCATION = "09700348"  # Harris Teeter, Village at Chestnut Street, Asheville
OVERRIDES = API / "data" / "kroger_overrides.csv"


def overrides(chain: str) -> dict[str, str]:
    """ingredient -> product id ("" for none) at this chain: rows with no
    chain hold everywhere, and a row for this chain wins over them."""
    rows = list(csv.DictReader(OVERRIDES.open(encoding="utf-8")))
    out = {r["ingredient"].strip(): r["product_id"].strip() for r in rows if not r["chain"].strip()}
    for r in rows:
        if r["chain"].strip() == chain:
            out[r["ingredient"].strip()] = r["product_id"].strip()
    return out


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


def store_row(db: httpx.Client, location: str, write: bool) -> tuple[str | None, str]:
    """(store id, chain slug) for a Kroger location, adding the shared store
    row if it isn't there yet; on a dry run nothing is added (no id)."""
    found = db.get(
        "/stores",
        params={
            "select": "id,chain_slug",
            "external_location_id": f"eq.{location}",
            "created_by": "is.null",
        },
    ).json()
    if found:
        return found[0]["id"], found[0]["chain_slug"]
    with httpx.Client(timeout=30.0) as client:
        loc = Kroger(client).store(location)
    if loc is None:
        sys.exit(f"Kroger doesn't know location {location}")
    if not write:
        return None, chain_slug(loc.chain)
    resp = db.post(
        "/stores",
        headers={"Prefer": "return=representation"},
        json={
            "chain_slug": chain_slug(loc.chain),
            "name": loc.name,
            "address": ", ".join(p for p in (loc.address, loc.city, loc.state) if p),
            "zip": loc.zip or None,
            "external_location_id": loc.location_id,
        },
    )
    resp.raise_for_status()
    row = resp.json()[0]
    print(f"added {loc.name} ({row['chain_slug']})")
    return row["id"], row["chain_slug"]


def main() -> None:
    """Pick a product for each ingredient at one store; print, or save."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--write", action="store_true", help="save the picks")
    parser.add_argument("--only", action="append", help="match just this ingredient")
    parser.add_argument("--location", default=LOCATION, help="Kroger location id to match at")
    args = parser.parse_args()
    location = args.location

    key = settings.supabase_service_role_key
    db = httpx.Client(
        base_url=f"{settings.supabase_url}/rest/v1",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        timeout=60.0,
    )
    store_id, chain = store_row(db, location, args.write)
    print(f"matching at {location} for the {chain} chain")
    ingredients = db.get(
        "/ingredients",
        params={
            "select": "id,name,aisle,buy_as,sold_by,package_quantity,package_unit,"
            "grams_per_cup,grams_per_each",
            "order": "name",
        },
    ).json()
    names = [i["name"] for i in ingredients]
    # Overrides with no chain hold everywhere: the blank ones stop the
    # matcher's known mistakes, and the products are national (a store that
    # doesn't carry one prices it from estimates). A chain's own rows win.
    fixed = overrides(chain)
    unknown = set(fixed) - set(names)
    if unknown:
        sys.exit(f"kroger_overrides.csv names unknown ingredients: {sorted(unknown)}")

    picks: list[dict[str, str]] = []
    missed: list[str] = []  # ingredient ids
    blanked: list[str] = []  # ingredient ids an override says not to match
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
                else:
                    blanked.append(i["id"])
                    print(f"{name}: none (override)")
                continue
            found = kroger.search(search_term(name), location)
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
    if not args.write or store_id is None:
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
    if blanked:
        # An override says this store's match is wrong: drop it, whoever set it.
        db.delete(
            "/kroger_product_matches",
            params={
                "store_id": f"eq.{store_id}",
                "ingredient_id": f"in.({','.join(blanked)})",
            },
        ).raise_for_status()
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
