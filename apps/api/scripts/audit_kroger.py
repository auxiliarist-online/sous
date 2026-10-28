"""Check a chain's Kroger product matches against one store (TYL-143).

    .venv/bin/python scripts/audit_kroger.py                     # Asheville Harris Teeter
    .venv/bin/python scripts/audit_kroger.py --location 02900540

For every ingredient matched at the store's chain, asks Kroger for the
product at this store and lists the ones that can't price there: not
carried (or no price), or a size Sous can't read. Those fall back to
estimates, so a plan prices them wrong (green peppers at $0.42 instead of
$1.79). Re-pick the not-carried ones with match_kroger.py --only; fix
unreadable sizes in parse_size().

Prints ingredient names and Kroger's size strings only: never names of
products or prices (their terms, §5e.1). Needs KROGER_CLIENT_ID,
KROGER_CLIENT_SECRET and the service role in .env.
"""

import argparse
import sys
from pathlib import Path

import httpx2 as httpx

API = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(API))

from app.config import settings  # noqa: E402
from app.plans.live_prices import _fetch  # noqa: E402
from app.pricing.kroger_match import parse_size  # noqa: E402

LOCATION = "09700348"  # Harris Teeter, Village at Chestnut Street, Asheville


def main() -> None:
    """Audit the store's chain matches and print what can't price there."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--location", default=LOCATION, help="Kroger location id to check")
    args = parser.parse_args()
    key = settings.supabase_service_role_key
    db = httpx.Client(
        base_url=f"{settings.supabase_url}/rest/v1",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        timeout=60.0,
    )
    store = db.get(
        "/stores",
        params={"select": "id,chain_slug", "external_location_id": f"eq.{args.location}"},
    ).json()
    if not store:
        sys.exit(f"no store with location {args.location}; run match_kroger.py --location first")
    matches = db.get(
        "/kroger_product_matches",
        params={
            "select": "product_id,ingredient:ingredients(name),stores!inner(chain_slug)",
            "stores.chain_slug": f"eq.{store[0]['chain_slug']}",
            "product_id": "not.is.null",
        },
    ).json()
    by_product: dict[str, set[str]] = {}
    for m in matches:
        by_product.setdefault(m["product_id"], set()).add(m["ingredient"]["name"])
    ids = list(by_product)
    found = {}
    for k in range(0, len(ids), 50):  # Kroger takes up to 50 ids a call
        for p in _fetch(ids[k : k + 50], args.location):
            found[p.product_id] = p
    gone, not_carried, unreadable = [], [], []
    for pid, names in by_product.items():
        p = found.get(pid)
        if p is None:
            gone += names
        elif not p.in_store or not p.regular:
            not_carried += names
        elif p.sold_by != "WEIGHT" and parse_size(p.size) is None:
            unreadable += [f"{n} ({p.size!r})" for n in names]
    total = sum(len(n) for n in by_product.values())
    chain = store[0]["chain_slug"]
    print(f"{total} ingredients matched for the {chain} chain, at {args.location}:")
    print(f"  not returned ({len(gone)}): {', '.join(sorted(gone)) or '-'}")
    print(f"  not carried here ({len(not_carried)}): {', '.join(sorted(not_carried)) or '-'}")
    print(f"  size unreadable ({len(unreadable)}): {', '.join(sorted(unreadable)) or '-'}")


if __name__ == "__main__":
    main()
