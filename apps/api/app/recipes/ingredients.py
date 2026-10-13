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
from app.pricing.units import KNOWN_UNITS, UnknownUnitError, convert

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
    # Hyphenated forms first, so "freshly-squeezed lemon juice" -> "lemon juice".
    "freshly-squeezed",
    "freshly squeezed",
    "freshly-ground",
    "freshly ground",
    "freshly-grated",
    "freshly grated",
    "well-chopped",
    "fine-grain",
    "day-old",
    "finely-chopped",
    "finely chopped",
    "finely-grated",
    "finely grated",
    "coarsely-chopped",
    "coarsely chopped",
    "roughly chopped",
    "thinly sliced",
    "pitted",
    "lean",
    "fragrant",
    "aromatic",
    "split",
    "garden",
    "boneless, skinless",
    "standard",
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
    "uncooked",
    "unbleached",
    "bleached",
    "unsweetened",
    "crusty",
    "toasted",
    "roasted",
    "melting",
)
QUALIFIER = re.compile(
    r"\s*(\(|\b(preferably|ideally|such as|such a|e\.?\s?g\.?|like|cut into)\b).*$"
)
# Common misspellings in recipes: "chicken bullion powder".
SPELLING = {"bullion": "bouillon", "mozarella": "mozzarella", "monterrey": "monterey"}
# The last resort drops leading words ("orange-fleshed sweet potatoes" ->
# "sweet potatoes") and some trailing ones ("chicken bouillon powder" ->
# "chicken bouillon"), but never a word that decides what the food is for a
# diet or allergy: "coconut milk" must not become "milk", nor "chicken
# bouillon" "bouillon", nor "gluten-free flour" "flour".
# Checked against every part of a word, singular or plural, so
# "anchovy-stuffed olives" and "beef-flavored ramen" keep their meat.
KEEP = frozenset(
    {
        # Meat and poultry
        *("chicken", "beef", "pork", "lamb", "mutton", "turkey", "duck", "goose", "veal"),
        *("goat", "venison", "rabbit", "bison", "meat", "bacon", "ham", "sausage", "lard"),
        *("suet", "tallow", "drippings", "pancetta", "prosciutto", "chorizo", "pepperoni"),
        *("salami", "guanciale", "speck", "bone", "marrow", "liver", "gelatin", "gelatine"),
        # Fish and shellfish
        *("fish", "anchovy", "anchovie", "sardine", "salmon", "tuna", "cod", "mackerel"),
        *("trout", "bonito", "katsuobushi", "dashi", "worcestershire", "caviar", "roe"),
        *("shrimp", "prawn", "crab", "lobster", "crawfish", "crayfish", "clam", "mussel"),
        *("oyster", "scallop", "squid", "calamari", "octopus", "shellfish", "seafood"),
        # Dairy, eggs, honey
        *("egg", "milk", "butter", "buttermilk", "cheese", "cream", "yogurt", "yoghurt"),
        *("ghee", "whey", "casein", "lactose", "dairy", "mayo", "mayonnaise", "honey"),
        # Nuts, seeds, soy, gluten
        *("nut", "peanut", "almond", "cashew", "walnut", "pecan", "hazelnut", "pistachio"),
        *("macadamia", "brazil", "pine", "coconut", "sesame", "soy", "soya", "tofu"),
        *("wheat", "gluten", "barley", "rye", "spelt", "oat", "rice", "alcohol", "wine"),
        # Words that change the above: "gluten-free", "non-dairy", "plant-based"
        *("free", "non", "less", "imitation", "vegan", "vegetarian", "plant", "vegetable"),
        *("veggie", "mushroom"),
    }
)
TRAILING = frozenset({"blend", "powder", "granules", "cube", "cubes", "base"})
# Too general to be what a longer name meant: "red peppers" isn't black pepper.
GENERIC = frozenset(
    {"pepper", "peppers", "sauce", "oil", "vinegar", "seasoning", "spice", "spices"}
    | {"blend", "powder", "paste", "mix", "leaves", "seeds", "juice", "stock", "broth"}
    # "millet flour" isn't all-purpose flour, nor "vanilla bean" dried beans.
    | {"flour", "bean", "beans", "chops", "noodles", "pasta", "rice", "sugar", "chocolate"}
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
    if re.search(r"(ch|sh|x)es$", text):  # "bunches" -> "bunch"
        return text[:-2]
    if text in ("leaves", "loaves", "halves"):  # but "cloves" -> "clove"
        return text[:-3] + "f"
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


def _decides(word: str) -> bool:
    """True when any part of a word ("anchovy-stuffed", "gluten-free",
    "chicken-flavour") is in KEEP, singular or plural."""
    for part in re.split(r"[-/'\u2019]", word):
        forms = {part, part.removesuffix("s"), part.removesuffix("es")}
        if part.endswith("ies"):
            forms.add(part[:-3] + "y")
        if forms & KEEP:
            return True
    return False


def _fallbacks(name: str) -> list[str]:
    """Shorter names to try last: without a trailing "blend" or "powder", then
    with leading words dropped one at a time. Never drops a word in KEEP, and
    never ends on a lone GENERIC word."""
    words = name.split()
    out = []
    if len(words) > 1 and words[-1] in TRAILING:
        out.append(" ".join(words[:-1]))
    while len(words) > 1 and not _decides(words[0]):
        words = words[1:]
        if len(words) == 1 and words[0] in GENERIC:
            break
        out.append(" ".join(words))
    return out


def candidates(name: str, canned: bool = False) -> list[str]:
    """Names to look up, most specific first: as written, then without
    descriptors one at a time, each also singular/plural; with "canned "
    tried first when the amount comes in cans."""
    base = " ".join(SPELLING.get(w, w) for w in _plain(name).split())
    # "Dijon-style mustard" -> "dijon mustard"
    base = re.sub(r"(?<=\w)-style\b", "", base)
    # "coconut milk, full fat" -> "coconut milk"; but "raw, unsweetened grated
    # coconut" -> "unsweetened grated coconut", skipping parts that only describe.
    parts = [p.strip() for p in base.split(",") if p.strip()]
    base = next((p for p in parts if DESCRIPTOR.sub("", p).strip()), parts[0] if parts else base)
    # "butter preferably ghee", "rice (e.g. basmati)", "oil such as canola" -> the first
    base = QUALIFIER.sub("", base).strip() or base
    stripped = [base]
    current = base
    while True:
        nxt = DESCRIPTOR.sub("", current, count=1).strip()
        if not nxt or nxt == current:
            break
        stripped.append(nxt)
        current = nxt
    stripped += _fallbacks(current)
    out: list[str] = []
    for n in stripped:
        for f in _forms(n):
            if canned:
                out.append(f"canned {f}")
            out.append(f)
    return list(dict.fromkeys(c for c in out if c))


def _combine(parts: list[Any]) -> tuple[float | None, str | None, str | None]:
    """Add up a compound amount in its first part's unit, using the unit table
    (app/pricing/units.py): "1 cup + 2 tbsp" -> 1.125 cup, "1 lb 4 oz" ->
    1.25 lb. Parts that can't be added (a different kind of unit, or one we
    don't know) are left out and returned as text for the note."""
    total: float | None = None
    unit: str | None = None
    left: list[str] = []
    for part in parts:
        qty, part_unit = _number(part.quantity), _unit(part.unit)
        if qty is None:
            continue
        if total is None:
            total, unit = qty, part_unit or "each"
            continue
        try:
            added = convert(qty, part_unit or "each", unit or "each")
        except UnknownUnitError:
            added = None
        if added is None:
            left.append(str(part.text))
        else:
            total += added
    return (round(total, 4) if total is not None else None), unit, "; ".join(left) or None


def _amounts(parsed: Any) -> tuple[float | None, float | None, str | None, str | None, float, bool]:
    """(quantity, quantity_max, unit, note, confidence, canned) for the line."""
    if not parsed.amount:
        return None, None, None, None, 1.0, False
    first = parsed.amount[0]
    if hasattr(first, "amounts"):  # "1 lb 4 oz", "1 cup + 2 tbsp"
        qty, unit, leftover = _combine(first.amounts)
        note = f"{first.text}; also {leftover}" if leftover else first.text
        return qty, None, unit, note, float(first.confidence), False
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
    try:
        parsed = _parser()(text)
        options = _options(parsed, text)
        amounts = _amounts(parsed) if options else None
    except (TypeError, ValueError, ArithmeticError):
        # The parser chokes on some amounts ("1 cup + 2 tbsp (200 g + 25 g)
        # sugar"). Keep the line as written, unmatched, for a person to look at.
        return [ParsedLine(line_no, text, section, needs_review=True)]
    if not options or amounts is None:  # a heading like "For the sauce:"
        return [ParsedLine(line_no, text, section)]
    qty, qty_max, unit, amount_note, amount_conf, canned = amounts
    comment = parsed.comment.text if parsed.comment else None
    notes = [n for n in (amount_note, comment) if n]
    optional = bool(re.search(r"\boptional\b", text, re.I))
    out = []
    for i, (name, conf) in enumerate(options, 1):
        # "1/3 cup raw, unsweetened grated coconut" parses as name "raw" with
        # the rest as a comment: a name that only describes takes the comment.
        if comment and not DESCRIPTOR.sub("", _plain(name)).strip(" ,"):
            name = f"{name}, {comment}"
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
