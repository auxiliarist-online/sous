"""Recipes from the National Heart, Lung, and Blood Institute (TYL-42).

NHLBI is part of NIH, and its site's content is in the public domain unless
noted (https://www.nhlbi.nih.gov/about/contact/trademark-branding-and-logo),
so its recipes are stored with their steps and credited to NHLBI. Images are
never copied (docs/policies/recipe-sources.md). Each recipe names the
cookbook it came from; only NHLBI's and NIH's own cookbooks are kept, since a
recipe credited to anyone else may not be a federal work.

This module turns a recipe page into a RecipeDraft; the import script
(scripts/import_nhlbi.py) lists and fetches the pages.
"""

import re

from bs4 import BeautifulSoup, Tag

from app.recipes.extract import Ingredient, RecipeDraft

DOMAIN = "www.nhlbi.nih.gov"
SITE_NAME = "NHLBI Healthy Eating Recipes"
INDEX_PATH = "/health/heart-healthy-living/healthy-foods/healthy-eating-recipes"
INDEX_URL = f"https://{DOMAIN}{INDEX_PATH}"

# The cookbooks NHLBI and NIH published, as the pages name them (lower case,
# trademark signs dropped). A recipe from anywhere else is left out.
FEDERAL_SOURCES = {
    "deliciously healthy dinners",
    "keep the beat recipes: deliciously healthy dinners",
    "keep the beat: heart healthy recipes",
    "keep the beat recipes",
    "keep the beat: heart healthy recipes from the national heart, lung, and blood institute",
    "deliciously healthy family meals",
    "keep the beat recipes: deliciously healthy family meals",
    "heart healthy home cooking african american style",
    "heart-healthy home cooking african american style",
    "delicious heart healthy latino recipes",
    "platillos latinos ¡sabrosos y saludables!",
    "stay young at heart",
    # NHLBI's community heart-health manuals.
    "honoring the gift of heart health manual for american indians and native alaskans",
    "healthy heart, healthy family manual for the filipino community",
    "your health is golden! heart health promotion activities for vietnamese communities",
    "nhlbi",
    "national heart, lung, and blood institute",
}


def recipe_links(index_html: str) -> list[str]:
    """The recipe pages an index page links to, as full URLs, in page order."""
    soup = BeautifulSoup(index_html, "html.parser")
    out: list[str] = []
    for a in soup.find_all("a", href=True):
        href = str(a["href"]).split("?")[0].split("#")[0]
        if href.startswith(INDEX_PATH + "/") and href.count("/") == INDEX_PATH.count("/") + 1:
            url = f"https://{DOMAIN}{href}"
            if url not in out:
                out.append(url)
    return out


def _text(node: Tag | None) -> str:
    """A node's text, whitespace collapsed."""
    return re.sub(r"\s+", " ", node.get_text(" ")).strip() if node else ""


def _minutes(text: str) -> int | None:
    """ "1 hour 15 minutes" -> 75; "20 minutes" -> 20; anything else -> None."""
    hours = re.search(r"(\d+)\s*h(?:ou)?r", text, re.I)
    mins = re.search(r"(\d+)\s*min", text, re.I)
    if not hours and not mins:
        return None
    return (int(hours.group(1)) * 60 if hours else 0) + (int(mins.group(1)) if mins else 0)


def _recipe(soup: BeautifulSoup) -> Tag | None:
    """The recipe's own article (the page also has banner and footer
    blocks with the same field classes)."""
    article = soup.find("article", class_="node--type-recipe")
    return article if isinstance(article, Tag) else None


def _body(soup: BeautifulSoup) -> Tag | None:
    """The recipe's body: summary, source, ingredients and directions."""
    article = _recipe(soup)
    body = article.find("div", class_="field--name-body") if article else None
    return body if isinstance(body, Tag) else None


def _fact(soup: BeautifulSoup, name: str) -> str:
    """A row of the cooking-facts table ("Prep Time", "Yields")."""
    table = soup.find("table", class_="cooking-facts")
    if not isinstance(table, Tag):
        return ""
    for row in table.find_all("tr"):
        if _text(row.find("th")).lower() == name.lower():
            return _text(row.find("td"))
    return ""


def source_of(html: str) -> str | None:
    """The cookbook a recipe page credits ("Deliciously Healthy Dinners")."""
    body = _body(BeautifulSoup(html, "html.parser"))
    for p in body.find_all("p") if body else []:
        m = re.match(r"recipe source:\s*(.+)", _text(p), re.I)
        if m:
            return m.group(1).strip()
    return None


def federal(source: str | None) -> bool:
    """Whether a credited cookbook is one of NHLBI's or NIH's own."""
    if not source:
        return False
    name = re.sub(r"[™®]", "", source).strip().lower()
    return name in FEDERAL_SOURCES


def parse(url: str, html: str) -> RecipeDraft | None:
    """A recipe page as a draft with its steps, or None when it isn't a
    usable recipe or isn't from a federal cookbook."""
    if not federal(source_of(html)):
        return None
    soup = BeautifulSoup(html, "html.parser")
    article = _recipe(soup)
    title = _text(article.find("h1")) if article else ""
    body = _body(soup)
    if not title or not body:
        return None

    ingredients: list[Ingredient] = []
    steps: list[str] = []
    summary: str | None = None
    section: str | None = None
    current: str | None = None  # "ingredients" or "steps"
    for node in body.children:
        if not isinstance(node, Tag):
            continue
        heading = _text(node) if node.name in ("h2", "h3", "h4") else None
        if heading is not None:
            low = heading.lower()
            if low.startswith("ingredient"):
                current, section = "ingredients", None
            elif low.startswith(("direction", "instruction", "preparation", "method")):
                current = "steps"
            elif current == "ingredients":
                section = heading  # "For the sauce"
            continue
        if node.name == "p" and summary is None and current is None:
            text = _text(node)
            if text and not text.lower().startswith("recipe source"):
                summary = text
        if node.name in ("ul", "ol"):
            items = [_text(li) for li in node.find_all("li")]
            items = [i for i in items if i]
            if current == "ingredients":
                ingredients += [
                    Ingredient(len(ingredients) + n, item, section) for n, item in enumerate(items)
                ]
            elif current == "steps":
                steps += items
    if not ingredients or not steps:
        return None

    yields = re.search(r"(\d+(?:\.\d+)?)", _fact(soup, "Yields"))
    prep, cook = _minutes(_fact(soup, "Prep Time")), _minutes(_fact(soup, "Cook Time"))
    return RecipeDraft(
        source_url=url,
        domain=DOMAIN,
        site_name=SITE_NAME,
        title=title,
        servings=float(yields.group(1)) if yields else None,
        prep_minutes=prep,
        cook_minutes=cook,
        total_minutes=(prep or 0) + (cook or 0) or None,
        summary=summary,
        instructions=steps,
        ingredients=ingredients,
    )
