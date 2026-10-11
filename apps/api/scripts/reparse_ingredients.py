"""Parse stored recipes' ingredient lines again (TYL-9).

Run after the parser or the ingredient aliases change, or for recipes saved
before parsing existed:

    .venv/bin/python scripts/reparse_ingredients.py            # every recipe
    .venv/bin/python scripts/reparse_ingredients.py --dry-run  # just report
    .venv/bin/python scripts/reparse_ingredients.py --recipe <uuid>

Reads each recipe's original lines (option 1 of each line keeps the raw text
and section) and replaces its rows through set_recipe_ingredients(), which
also re-matches them to canonical ingredients. Uses the service role from .env.
"""

import argparse
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import httpx2 as httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.recipes.ingredients import parse_line  # noqa: E402

PAGE = 1000


def rest(client: httpx.Client, method: str, path: str, **kw: Any) -> Any:
    key = settings.supabase_service_role_key
    resp = client.request(
        method,
        f"{settings.supabase_url}/rest/v1/{path}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        **kw,
    )
    resp.raise_for_status()
    return resp.json() if resp.content else None


def original_lines(client: httpx.Client, recipe: str | None) -> dict[str, list[dict[str, Any]]]:
    by_recipe: dict[str, list[dict[str, Any]]] = defaultdict(list)
    offset = 0
    while True:
        params = {
            "select": "recipe_id,line_no,raw_text,section",
            "option_no": "eq.1",
            "order": "recipe_id,line_no",
            "limit": str(PAGE),
            "offset": str(offset),
        }
        if recipe:
            params["recipe_id"] = f"eq.{recipe}"
        rows = rest(client, "GET", "recipe_ingredients", params=params)
        for r in rows:
            by_recipe[r["recipe_id"]].append(r)
        if len(rows) < PAGE:
            return by_recipe
        offset += PAGE


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--recipe", help="only this recipe id")
    ap.add_argument("--dry-run", action="store_true", help="parse and report, change nothing")
    args = ap.parse_args()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in apps/api/.env")

    with httpx.Client(timeout=30.0) as client:
        recipes = original_lines(client, args.recipe)
        lines = review = 0
        for recipe_id, rows in recipes.items():
            parsed = [
                p for r in rows for p in parse_line(r["line_no"], r["raw_text"], r["section"])
            ]
            lines += len(rows)
            review += sum(p.needs_review for p in parsed)
            if not args.dry_run:
                rest(
                    client,
                    "POST",
                    "rpc/set_recipe_ingredients",
                    json={"p_recipe": recipe_id, "p_rows": [p.payload() for p in parsed]},
                )
    verb = "Would re-parse" if args.dry_run else "Re-parsed"
    print(f"{verb} {lines} lines in {len(recipes)} recipes; {review} parsed rows need review.")
    if not args.dry_run:
        print("Unmatched ingredients are flagged needs_review in the database too.")


if __name__ == "__main__":
    main()
