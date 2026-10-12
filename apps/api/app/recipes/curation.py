"""What the shared catalog leaves out (data/catalog_exclusions.csv).

The catalog is for everyday cooking. Some openly licensed pages would put
people off or don't belong at all: human placenta, dog meat, pet food,
endangered species. Each rule is a case-insensitive pattern on the title or on
an ingredient line, with the reason. Regional dishes (tripe, liver, blood
stew, frog legs) are not excluded; preferences and ranking handle taste.

Applies only to the shared catalog; a user's own imports are theirs.
"""

import csv
import functools
import re
from pathlib import Path

from app.recipes.extract import RecipeDraft

RULES = Path(__file__).resolve().parents[2] / "data" / "catalog_exclusions.csv"


@functools.cache
def _rules() -> list[tuple[str, re.Pattern[str], str]]:
    with RULES.open(encoding="utf-8") as f:
        return [(r["kind"], re.compile(r["pattern"], re.I), r["reason"]) for r in csv.DictReader(f)]


def excluded(draft: RecipeDraft) -> str | None:
    """Why the recipe is left out of the catalog, or None."""
    for kind, pattern, reason in _rules():
        if kind == "title" and pattern.search(draft.title):
            return reason
        if kind == "ingredient" and any(pattern.search(i.raw_text) for i in draft.ingredients):
            return reason
    return None
