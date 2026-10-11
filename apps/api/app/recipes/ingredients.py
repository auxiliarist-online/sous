"""Parse ingredient lines into amounts, units and ingredient names (TYL-9).

"2 1/2 cups all-purpose flour, sifted" -> 2.5 cup, "all-purpose flour", prep
"sifted". Parsing uses ingredient-parser-nlp; matching a name to a canonical
ingredient happens in the database (match_ingredient()), from the candidate
names built here, so the ingredient list and aliases stay in one place.
"""

import functools
import os
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any

from app.pricing.units import ALIASES as UNIT_ALIASES
from app.pricing.units import KNOWN_UNITS

# The parser's NLTK data ships with the app (scripts/fetch_nltk_data.py), so it
# never tries to download it at runtime.
_DATA = Path(__file__).resolve().parents[2] / "nltk_data"


@functools.cache
def _parser() -> Callable[[str], Any]:
    """Load the parser on first use, not on import: importing the API (as Vercel
    does while building, before the NLTK data is fetched) mustn't load NLTK."""
    if _DATA.is_dir():
        os.environ.setdefault("NLTK_DATA", str(_DATA))
    from ingredient_parser import parse_ingredient

    return parse_ingredient


# Below this the parse is flagged for review.
CONFIDENT = 0.85

# Containers whose size is often given in parentheses: "1 (15 oz) can beans".
CONTAINERS = frozenset(
    {"can", "jar", "package", "packet", "bag", "box", "bottle", "carton", "tin", "container"}
)

# Words that describe an ingredient without changing what you'd buy. Dropped
# one by one to build fallback names: "large ripe avocados" -> "avocados".
DESCRIPTORS = (
    "freshly",
    "fresh",
    "large",
    "medium",
    "small",
    "extra-large",
    "jumbo",
    "ripe",
    "raw",
    "organic",
    "good-quality",
    "good quality",
    "store-bought",
    "homemade",
    "boneless",
    "skinless",
    "unsalted",
    "salted",
    "low-sodium",
    "reduced-sodium",
    "extra virgin",
    "extra-virgin",
    "full-fat",
    "light",
    "baby",
    "kosher",
    "flaky",
    "fine",
    "coarse",
    "ground",
    "whole",
    "plain",
    "chopped",
    "minced",
    "diced",
    "sliced",
    "grated",
    "shredded",
    "packed",
    "heaping",
    "level",
    "cold",
    "warm",
    "hot",
    "room temperature",
    "dried",
    "cooked",
)
DESCRIPTOR = re.compile(r"\b(" + "|".join(re.escape(d) for d in DESCRIPTORS) + r")\b\s*", re.I)


@dataclass
class ParsedLine:
    """One row of recipe_ingredients. Lines with alternatives ("A or B") give
    one ParsedLine per option, sharing line_no."""

    line_no: int
    raw_text: str
    section: str | None = None
    option_no: int = 1
    name: str | None = None
    candidates: list[str] = field(default_factory=list)
    quantity: float | None = None
    quantity_max: float | None = None
    unit: str | None = None
    preparation: str | None = None
    note: str | None = None
    is_optional: bool = False
    parse_confidence: float | None = None
    needs_review: bool = False

    def payload(self) -> dict[str, Any]:
        return dict(vars(self))


def _number(value: Any) -> float | None:
    if isinstance(value, Fraction | int | float):
        return round(float(value), 4)
    try:
        return round(float(Fraction(str(value))), 4)
    except (ValueError, ZeroDivisionError):
        return None


def _unit(value: Any) -> str | None:
    """The parser's unit ("tablespoon", "cloves", "") as our canonical name."""
    text = re.sub(r"^(?:small|medium|large|big)\s+", "", str(value or "").strip().lower())
    if not text:
        return None
    if text in KNOWN_UNITS:
        return text
    if text in UNIT_ALIASES:
        return UNIT_ALIASES[text]
    return re.sub(r"(?<=[^s])s$", "", text)  # "cloves" -> "clove", "cans" -> "can"


def _plain(text: str) -> str:
    text = (
        unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    )  # jalapeño -> jalapeno
    return re.sub(r"\s+", " ", text.lower()).strip(" ,.;:-")


def _forms(name: str) -> list[str]:
    """The name, then its singular/plural."""
    out = [name]
    if name.endswith("ies"):
        out.append(name[:-3] + "y")
    elif name.endswith("oes"):
        out.append(name[:-2])
    elif name.endswith("s") and not name.endswith("ss"):
        out.append(name[:-1])
    else:
        out.append(name + "es" if name.endswith(("o", "ch", "sh")) else name + "s")
    return out


def candidates(name: str, canned: bool = False) -> list[str]:
    """Names to look up, most specific first: as written, then without
    descriptors one at a time, each also singular/plural; with "canned "
    tried first when the amount comes in cans."""
    base = _plain(name)
    # "coconut milk, full fat" -> "coconut milk"
    base = base.split(",")[0].strip()
    stripped = [base]
    current = base
    while True:
        nxt = DESCRIPTOR.sub("", current, count=1).strip()
        if not nxt or nxt == current:
            break
        stripped.append(nxt)
        current = nxt
    out: list[str] = []
    for n in stripped:
        for f in _forms(n):
            if canned:
                out.append(f"canned {f}")
            out.append(f)
    return list(dict.fromkeys(c for c in out if c))


def _amounts(parsed: Any) -> tuple[float | None, float | None, str | None, str | None, float, bool]:
    """(quantity, quantity_max, unit, note, confidence, canned) for the line."""
    if not parsed.amount:
        return None, None, None, None, 1.0, False
    first = parsed.amount[0]
    if hasattr(first, "amounts"):  # "1 lb 2 oz": add them up in the first unit
        combined = first.combined()
        unit = _unit(str(combined.units))
        qty = _number(combined.magnitude)
        return qty, None, unit, first.text, float(first.confidence), False
    qty, qty_max, unit = _number(first.quantity), _number(first.quantity_max), _unit(first.unit)
    canned = unit in ("can", "tin")
    note = None
    # "1 (15 oz) can chickpeas": store 15 oz, so the amount can be priced and
    # merged, and keep "1 can" as a note.
    size = next(
        (
            a
            for a in parsed.amount[1:]
            if getattr(a, "SINGULAR", False) and not hasattr(a, "amounts")
        ),
        None,
    )
    if unit in CONTAINERS and size is not None and qty is not None:
        per = _number(size.quantity)
        if per is not None:
            note = first.text
            qty, qty_max, unit = (
                round(qty * per, 4),
                round((qty_max or qty) * per, 4),
                _unit(size.unit),
            )
    if qty is not None and unit is None:
        unit = "each"
    if getattr(first, "APPROXIMATE", False):
        note = ", ".join(n for n in (note, "about") if n)
    if qty_max == qty:
        qty_max = None
    return qty, qty_max, unit, note, float(first.confidence), canned


def _options(parsed: Any, raw: str) -> list[tuple[str, float]]:
    """Ingredient names and their confidence. Several names are alternatives
    only when the line says "or"; "salt and pepper" stays one ingredient."""
    names = [(n.text, float(n.confidence)) for n in parsed.name]
    if len(names) > 1 and not re.search(r"\bor\b", raw, re.I):
        return [(" and ".join(n for n, _ in names), min(c for _, c in names))]
    return names


# Checkboxes and bullets some recipe plugins put before each line ("▢ 1 cup rice").
BULLET = re.compile(
    r"^[\s\u25a2\u2610\u25a1\u25fb\u25fd\u25aa\u2022\u25cf\u25e6\u2023\u2043\u2713\u2714\u2611*\u00b7\-\u2013\u2014]+"
)


def parse_line(line_no: int, raw: str, section: str | None = None) -> list[ParsedLine]:
    text = BULLET.sub("", raw).strip()
    if not text:
        return []
    parsed = _parser()(text)
    options = _options(parsed, text)
    if not options:  # a heading like "For the sauce:", or something we can't read
        return [ParsedLine(line_no, text, section)]
    qty, qty_max, unit, amount_note, amount_conf, canned = _amounts(parsed)
    comment = parsed.comment.text if parsed.comment else None
    notes = [n for n in (amount_note, comment) if n]
    optional = bool(re.search(r"\boptional\b", text, re.I))
    out = []
    for i, (name, conf) in enumerate(options, 1):
        confidence = round(min(conf, amount_conf), 3)
        out.append(
            ParsedLine(
                line_no=line_no,
                raw_text=text,
                section=section,
                option_no=i,
                name=name,
                candidates=candidates(name, canned),
                quantity=qty,
                quantity_max=qty_max,
                unit=unit,
                preparation=parsed.preparation.text if parsed.preparation else None,
                note="; ".join(notes) or None,
                is_optional=optional,
                parse_confidence=confidence,
                # An unsure alternative matters too: "fish sauce (or soy sauce)"
                # decides whether the dish can be vegetarian. "salt and pepper"
                # is two ingredients on one line, which a person should split.
                needs_review=confidence < CONFIDENT or " and " in name,
            )
        )
    return out
