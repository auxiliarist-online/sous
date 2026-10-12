"""Recipes from the Wikibooks Cookbook (TYL-45), CC BY-SA 4.0.

The Cookbook is openly licensed, so unlike link-only blogs its steps can be
stored and shown, with attribution and the license (docs/policies/recipe-sources.md).
This module turns a recipe page's wikitext into a RecipeDraft; the import
script (scripts/import_wikibooks.py) fetches pages through the MediaWiki API.
"""

import re
from urllib.parse import quote

from app.recipes.extract import CUISINES, Ingredient, RecipeDraft

DOMAIN = "en.wikibooks.org"
SITE_NAME = "Wikibooks Cookbook"
LICENSE_NAME = "CC BY-SA 4.0"
LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"

INGREDIENTS = re.compile(r"^ingredients?$", re.I)
STEPS = re.compile(r"^(procedure|directions|method|instructions|preparation|steps)$", re.I)
MAX_LINE = 300


def page_url(title: str) -> str:
    return f"https://{DOMAIN}/wiki/{quote(title.replace(' ', '_'), safe=':/()_,-')}"


def _convert(match: re.Match[str]) -> str:
    """{{convert|8|oz|g|abbr=on}} -> "8 oz"; {{convert|1|-|2|cup}} -> "1–2 cup"."""
    parts = [p.strip() for p in match.group(1).split("|") if "=" not in p]
    if len(parts) >= 4 and parts[1] in ("-", "to", "–"):
        return f"{parts[0]}–{parts[2]} {parts[3]}"
    return " ".join(parts[:2])


def clean(text: str) -> str:
    """Wikitext to plain text: links become their label, templates and
    markup go away."""
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", text, flags=re.S | re.I)
    text = re.sub(r"\{\{\s*convert\s*\|([^{}]*)\}\}", _convert, text, flags=re.I)
    while True:  # other templates, innermost first
        stripped = re.sub(r"\{\{[^{}]*\}\}", "", text)
        if stripped == text:
            break
        text = stripped
    text = re.sub(r"\[\[(?:File|Image|Category):[^\]]*\]\]", "", text, flags=re.I)
    text = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\[\[(?:[^\]:]*:)?([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\[https?://\S+\s+([^\]]*)\]", r"\1", text)
    text = re.sub(r"\[https?://\S+\]", "", text)
    text = re.sub(r"'{2,}", "", text)
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"\s+", " ", text).strip()


def _sections(wikitext: str) -> list[tuple[int, str, list[str]]]:
    """(heading level, heading, lines) in page order; level 0 is the intro."""
    out: list[tuple[int, str, list[str]]] = [(0, "", [])]
    for line in wikitext.splitlines():
        heading = re.match(r"^(={2,6})\s*(.*?)\s*\1\s*$", line)
        if heading:
            out.append((len(heading.group(1)), clean(heading.group(2)), []))
        else:
            out[-1][2].append(line)
    return out


def _summary(wikitext: str) -> dict[str, str]:
    match = re.search(r"\{\{\s*recipe\s*summary\s*\|(.*?)\}\}", wikitext, re.I | re.S)
    fields: dict[str, str] = {}
    for part in match.group(1).split("|") if match else []:
        key, _, value = part.partition("=")
        fields[key.strip().lower()] = value.strip()
    return fields


def _minutes(text: str) -> int | None:
    """ "20 minutes", "1 hour 30 minutes", "1½ hours" -> minutes."""
    text = text.lower().replace("½", ".5").replace("¼", ".25").replace("¾", ".75")
    hours = re.search(r"(\d*\.?\d+)\s*(h|hr|hrs|hour|hours)\b", text)
    mins = re.search(r"(\d+)\s*(m|min|mins|minute|minutes)\b", text)
    total = (float(hours.group(1)) * 60 if hours else 0) + (int(mins.group(1)) if mins else 0)
    return round(total) if total > 0 else None


def _servings(text: str) -> float | None:
    match = re.search(r"\d+(?:\.\d+)?", text)
    return float(match.group()) if match and 0 < float(match.group()) <= 100 else None


# Wikibooks category names that differ from the publisher strings in CUISINES.
CATEGORY_CUISINES = {"southern u.s.": "southern", "southern united states": "southern"}


def _cuisines(wikitext: str, summary_category: str) -> list[str]:
    """From the recipe summary's category and the page's own categories
    ("[[Category:Italian recipes]]")."""
    names = [summary_category, *re.findall(r"\[\[\s*Category:([^\]|]+)", wikitext, re.I)]
    found = set()
    for name in names:
        key = re.sub(r"\s+(recipes|cuisine|cooking)$", "", name.strip().lower().replace("_", " "))
        slug = CATEGORY_CUISINES.get(key) or CUISINES.get(key)
        if slug:
            found.add(slug)
    return sorted(found)


def _list_items(lines: list[str], marker: str, join_nested: bool = False) -> list[str]:
    """List items. With join_nested (steps), nested lines ("#:" notes, "#*"
    sub-points) belong to the item above them."""
    items: list[str] = []
    for line in lines:
        if not line.startswith(marker):
            continue
        text = clean(line.lstrip("*#:; "))
        if not text:
            continue
        nested = join_nested and len(line) > 1 and line[1] in "*#:"
        if nested and items:
            items[-1] = f"{items[-1]} {text}"
        else:
            items.append(text)
    return items


def parse(title: str, wikitext: str) -> RecipeDraft | None:
    """A recipe page as a draft, or None when it isn't a usable recipe (an
    article, a stub, or a page without both ingredients and steps)."""
    name = clean(title.removeprefix("Cookbook:"))
    if not name or len(name) > 200 or "/" in name:
        return None
    sections = _sections(wikitext)

    ingredients: list[Ingredient] = []
    steps: list[str] = []
    in_ingredients = in_steps = False
    group: str | None = None
    for level, heading, lines in sections:
        if level == 2:
            in_ingredients = bool(INGREDIENTS.match(heading))
            in_steps = bool(STEPS.match(heading))
            group = None
        elif level > 2 and in_ingredients:
            group = heading or None
        if in_ingredients:
            for text in _list_items(lines, "*"):
                if text.endswith(":"):  # "Dressing:" starts a group
                    group = text[:-1].strip() or group
                elif len(text) <= MAX_LINE:
                    ingredients.append(Ingredient(len(ingredients), text, group))
        elif in_steps:
            steps += _list_items(lines, "#", join_nested=True) or _list_items(
                lines, "*", join_nested=True
            )

    if len(ingredients) < 2 or not steps:
        return None
    info = _summary(wikitext)
    url = page_url(title)
    return RecipeDraft(
        source_url=url,
        domain=DOMAIN,
        site_name=SITE_NAME,
        title=name,
        servings=_servings(info.get("servings", "")),
        total_minutes=_minutes(info.get("time", "")),
        instructions=steps,
        cuisines=_cuisines(wikitext, info.get("category", "")),
        ingredients=ingredients,
    )
