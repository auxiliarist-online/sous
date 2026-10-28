"""Picking the Harris Teeter product Sous buys for an ingredient (TYL-80).

A product is a candidate when:

* every word of the ingredient's name is in its description, singular or
  plural ("canned", "dried", "fresh" and "frozen" aren't needed: Kroger
  rarely says "canned black beans");
* it's in a Kroger department that fits the ingredient's aisle (spices are
  in Baking Goods; mint candy isn't produce);
* it isn't really a longer ingredient that contains ours ("peanut butter"
  isn't "butter"), and the ingredient is the head noun: "Fresh Celery", not
  "Cream of Celery Soup" (a missed match falls back to an estimate; a wrong
  one shows a wrong price);
* it's sold in the store and has a price.

Of the candidates, prefer, in order:

1. dried only for "dried ..." ingredients (fresh basil, canned beans);
2. not organic, unless the ingredient is (it costs more and wasn't asked for);
3. the store's own brand (Harris Teeter, Kroger), the cheap everyday choice;
4. the size closest to the package Sous expects (packaging.csv);
5. Kroger's own search order.
"""

import math
import re
from collections.abc import Iterable

from app.pricing.kroger import Product
from app.pricing.units import UnknownUnitError, convert, normalize_unit

STORE_BRANDS = ("harris teeter", "kroger", "private selection", "ht traders")
# Kroger sizes look like "12 ct", "5 lbs", "2.31 oz", "large 18 ct", "64 fl oz".
SIZE = re.compile(r"(\d+(?:\.\d+)?)\s*(fl\.? ?oz|ct|count|each|[a-z]+)", re.I)
SIZE_UNITS = {
    "ct": "each", "count": "each", "ea": "each",
    "fl oz": "fl_oz", "fl. oz": "fl_oz", "floz": "fl_oz",
}  # fmt: skip
WORD = re.compile(r"[a-z]+")

# How an ingredient is kept, not what it is.
QUALIFIERS = frozenset({"canned", "dried", "dry", "fresh", "frozen"})
DRY = frozenset({"dried", "dry"})
# Words at the end of a description that aren't the product: "Carrots Bag".
PACKAGING = frozenset(
    {
        *("bag", "bags", "box", "bulk", "bunch", "can", "cans", "carton", "container"),
        *("ct", "count", "ea", "each", "family", "fl", "gal", "gallon", "jar", "lb", "lbs"),
        *("loaf", "oz", "pack", "package", "pk", "pouch", "quart", "shaker", "single"),
        *("size", "tray", "tub", "value"),
        # Cuts and forms: "Broccoli Florets", "Tilapia Fillets".
        *("crowns", "fillet", "fillets", "florets", "steaks"),
        # Joining words: "Peppers in Adobo Sauce" ends in "sauce".
        *("and", "by", "in", "of", "order", "per", "the", "with"),
    }
)

# Kroger departments each aisle's ingredients are found in. "Natural &
# Organic" is a tag on top of a department, so it never decides.
FOOD = frozenset(
    {
        "Adult Beverage",
        "Bakery",
        "Baking Goods",
        "Beverages",
        "Breakfast",
        "Canned & Packaged",
        "Condiment & Sauces",
        "Dairy",
        "Deli",
        "Frozen",
        "International",
        "Meat & Seafood",
        "Pasta, Sauces, Grain",
        "Produce",
        "Snacks",
    }
)
AISLES = {
    "produce": {"Produce"},
    "meat_seafood": {"Meat & Seafood", "Deli"},
    "dairy_eggs": {"Dairy", "Deli", "Breakfast"},
    "spices": {"Baking Goods", "International", "Pasta, Sauces, Grain"},
    "frozen": {"Frozen"},
    "bakery": {"Bakery", "Breakfast", "International", "Deli"},
    "beverages": {"Beverages", "Adult Beverage", "Breakfast", "Dairy"},
    "pantry": FOOD - {"Frozen", "Produce", "Meat & Seafood", "Dairy"},
}
TAGS = frozenset({"Natural & Organic"})


def words(text: str) -> set[str]:
    """Lowercase words, each also as its singular, so "eggs" finds "egg"."""
    found = set()
    for w in WORD.findall(text.lower().replace("'", "")):
        found.add(w)
        if w.endswith("ies") and len(w) > 4:
            found.add(w[:-3] + "y")
        elif w.endswith("oes") or w.endswith("ches") or w.endswith("shes"):
            found.add(w[:-2])
        if w.endswith("s") and not w.endswith("ss") and len(w) > 3:
            found.add(w[:-1])
    return found


def _singular(w: str) -> str:
    return min(words(w), key=len)


def name_words(name: str) -> set[str]:
    """The words a product must contain: the ingredient's, each in one form,
    without how it's kept ("canned black beans" -> black, bean)."""
    found = {_singular(w) for w in WORD.findall(name.lower().replace("'", ""))}
    return found - QUALIFIERS or found


def head(description: str) -> set[str]:
    """The last real word of a description, in all its forms."""
    tail = [w for w in WORD.findall(description.lower().replace("'", "")) if w not in PACKAGING]
    return words(tail[-1]) if tail else set()


# "24 bottles/16.9 fl oz": a multipack, priced as the whole.
MULTIPACK = re.compile(
    r"(\d+)\s*(?:bottles?|cans?|ct|pk|pack|count)?\s*/\s*(\d+(?:\.\d+)?)\s*(fl\.? ?oz|[a-z]+)", re.I
)
# "2 pk" is two of them; "1 pk" is one package of unknown size (a pack of
# okra), which can't be priced by the item, so it's left unknown.
PACK = re.compile(r"(\d+)\s*-?\s*(?:pk|pack)\b", re.I)


def parse_size(size: str | None) -> tuple[float, str] | None:
    """A Kroger size string as (quantity, unit): "12 ct" is (12, each),
    "2 pk" (2, each), "24 bottles/16.9 fl oz" (405.6, fl_oz). None when it
    can't be read, or doesn't say how much is in it ("1 pk")."""
    if not size:
        return None
    text = size.lower()
    multi = MULTIPACK.search(text)
    if multi:
        unit = SIZE_UNITS.get(multi.group(3), multi.group(3))
        try:
            return int(multi.group(1)) * float(multi.group(2)), normalize_unit(unit)
        except UnknownUnitError:
            return None
    pack = PACK.search(text)
    if pack:
        n = int(pack.group(1))
        return (float(n), "each") if n >= 2 else None
    m = SIZE.search(text)
    if not m:
        return None
    unit = SIZE_UNITS.get(m.group(2), m.group(2))
    try:
        return float(m.group(1)), normalize_unit(unit)
    except UnknownUnitError:
        return None


def is_store_brand(p: Product) -> bool:
    text = f"{p.brand or ''} {p.description}".lower()
    return (p.brand or "").lower() in STORE_BRANDS or text.lstrip().startswith(STORE_BRANDS)


def in_aisle(p: Product, aisle: str | None) -> bool:
    departments = set(p.categories) - TAGS
    if not departments:
        return not p.categories  # no departments listed: can't tell, so allow
    return bool(departments & AISLES.get(aisle or "", FOOD))


def size_distance(
    p: Product,
    package: tuple[float, str] | None,
    grams_per_cup: float | None = None,
    grams_per_each: float | None = None,
) -> float:
    """How far a product's size is from the package we expect, as |log ratio|.
    Unknown or incomparable sizes sort after every comparable one."""
    size = parse_size(p.size)
    if not package or not size:
        return 10.0
    try:
        ours = convert(
            size[0], size[1], package[1], grams_per_cup=grams_per_cup, grams_per_each=grams_per_each
        )
    except UnknownUnitError:
        return 10.0
    if not ours or package[0] <= 0:
        return 10.0
    return abs(math.log(ours / package[0]))


def candidates(
    name: str, products: Iterable[Product], others: Iterable[str], aisle: str | None = None
) -> list[Product]:
    """Products that are this ingredient, in Kroger's order. `others` are
    every ingredient's name, to spot "peanut butter" when we want "butter"."""
    want = name_words(name)
    longer = [n for n in (name_words(o) for o in others) if want < n]
    found = []
    for p in products:
        text = words(p.description)
        if not p.in_store or not p.regular or not want <= text or not in_aisle(p, aisle):
            continue
        if any(n <= text for n in longer) or not head(p.description) & want:
            continue
        found.append(p)
    return found


def choose(
    name: str,
    products: list[Product],
    others: Iterable[str],
    package: tuple[float, str] | None = None,
    grams_per_cup: float | None = None,
    grams_per_each: float | None = None,
    aisle: str | None = None,
) -> Product | None:
    found = candidates(name, products, others, aisle)
    if not found:
        return None
    dried = bool(words(name) & DRY)
    organic_ok = "organic" in name.lower()
    order = {p.product_id: i for i, p in enumerate(found)}

    def rank(p: Product) -> tuple[bool, bool, bool, float, int]:
        text = words(p.description)
        organic = "organic" in text or "simple truth" in (p.brand or "").lower()
        return (
            bool(text & DRY) != dried,
            organic and not organic_ok,
            not is_store_brand(p),
            # Round so near-equal sizes (1 lb vs 16 oz) defer to brand and order.
            round(size_distance(p, package, grams_per_cup, grams_per_each), 1),
            order[p.product_id],
        )

    return min(found, key=rank)


def search_term(name: str) -> str:
    """What to search Kroger for: "canned black beans" -> "black beans"."""
    return re.sub(r"\bcanned\s+", "", name).strip() or name
