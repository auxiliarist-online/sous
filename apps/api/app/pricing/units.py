"""Unit normalization and conversion for ingredient quantities and prices."""

# Base units: grams for mass, milliliters for volume, items for count.
MASS_G = {"g": 1.0, "kg": 1000.0, "oz": 28.3495, "lb": 453.592}
VOLUME_ML = {
    "ml": 1.0,
    "l": 1000.0,
    "tsp": 4.92892,
    "tbsp": 14.7868,
    "cup": 236.588,
    "fl_oz": 29.5735,
    "pint": 473.176,
    "quart": 946.353,
    "gallon": 3785.41,
}
COUNT = {"each": 1.0, "dozen": 12.0}

ALIASES = {
    "gram": "g",
    "grams": "g",
    "kilogram": "kg",
    "kilograms": "kg",
    "ounce": "oz",
    "ounces": "oz",
    "pound": "lb",
    "pounds": "lb",
    "lbs": "lb",
    "milliliter": "ml",
    "milliliters": "ml",
    "liter": "l",
    "liters": "l",
    "teaspoon": "tsp",
    "teaspoons": "tsp",
    "tablespoon": "tbsp",
    "tablespoons": "tbsp",
    "cups": "cup",
    "fluid ounce": "fl_oz",
    "fluid ounces": "fl_oz",
    "fl oz": "fl_oz",
    "pints": "pint",
    "quarts": "quart",
    "gallons": "gallon",
    "gal": "gallon",
    "item": "each",
    "items": "each",
    "whole": "each",
    "piece": "each",
    "pieces": "each",
}

KNOWN_UNITS = frozenset(MASS_G) | frozenset(VOLUME_ML) | frozenset(COUNT)


class UnknownUnitError(ValueError):
    pass


def normalize_unit(unit: str) -> str:
    """Map a unit as written ("Tablespoons", "fl oz") to its canonical name ("tbsp")."""
    key = unit.strip().lower().rstrip(".")
    key = ALIASES.get(key, key)
    if key not in KNOWN_UNITS:
        raise UnknownUnitError(unit)
    return key


def _dimension(unit: str) -> str:
    if unit in MASS_G:
        return "mass"
    if unit in VOLUME_ML:
        return "volume"
    return "count"


def _to_base(quantity: float, unit: str) -> float:
    if unit in MASS_G:
        return quantity * MASS_G[unit]
    if unit in VOLUME_ML:
        return quantity * VOLUME_ML[unit]
    return quantity * COUNT[unit]


def _from_base(amount: float, unit: str) -> float:
    if unit in MASS_G:
        return amount / MASS_G[unit]
    if unit in VOLUME_ML:
        return amount / VOLUME_ML[unit]
    return amount / COUNT[unit]


def convert(
    quantity: float,
    from_unit: str,
    to_unit: str,
    *,
    grams_per_cup: float | None = None,
    grams_per_each: float | None = None,
) -> float | None:
    """Convert a quantity between units.

    Crossing between mass, volume and count needs the ingredient's density
    (grams_per_cup) or item weight (grams_per_each). Returns None when the
    conversion isn't possible with what's known.
    """
    src = normalize_unit(from_unit)
    dst = normalize_unit(to_unit)
    src_dim, dst_dim = _dimension(src), _dimension(dst)
    base = _to_base(quantity, src)

    if src_dim == dst_dim:
        return _from_base(base, dst)

    # Route everything else through grams.
    grams: float | None
    if src_dim == "mass":
        grams = base
    elif src_dim == "volume":
        grams = base / VOLUME_ML["cup"] * grams_per_cup if grams_per_cup else None
    else:
        grams = base * grams_per_each if grams_per_each else None
    if grams is None:
        return None

    if dst_dim == "mass":
        return _from_base(grams, dst)
    if dst_dim == "volume":
        if not grams_per_cup:
            return None
        return _from_base(grams / grams_per_cup * VOLUME_ML["cup"], dst)
    if not grams_per_each:
        return None
    return _from_base(grams / grams_per_each, dst)
