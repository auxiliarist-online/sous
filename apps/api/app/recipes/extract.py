"""Turn a recipe page into the fields Sous stores (TYL-8).

Reads schema.org Recipe data (JSON-LD or microdata) with recipe-scrapers. What
actually gets stored is decided by the source's content rights in
import_recipe(); see docs/policies/recipe-sources.md.
"""

import html
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from recipe_scrapers import scrape_html
from recipe_scrapers._exceptions import RecipeScrapersExceptions

from app.recipes.fetch import FetchError

TRACKING_PARAMS = re.compile(r"^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|_ga)$", re.I)

# Publisher cuisine strings -> our cuisine slugs. Anything else is ignored
# (sites often put diets like "Gluten-Free" in the cuisine field).
CUISINES = {
    "american": "american", "southern": "southern", "soul food": "southern",
    "mexican": "mexican", "tex-mex": "mexican", "latin american": "latin_american",
    "caribbean": "caribbean", "jamaican": "caribbean", "cuban": "caribbean",
    "italian": "italian", "french": "french", "spanish": "spanish", "greek": "greek",
    "mediterranean": "mediterranean", "middle eastern": "middle_eastern",
    "lebanese": "middle_eastern", "persian": "middle_eastern", "turkish": "middle_eastern",
    "moroccan": "north_african", "north african": "north_african", "ethiopian": "ethiopian",
    "west african": "west_african", "nigerian": "west_african", "indian": "indian",
    "chinese": "chinese", "sichuan": "chinese", "cantonese": "chinese",
    "japanese": "japanese", "korean": "korean", "thai": "thai", "vietnamese": "vietnamese",
    "filipino": "filipino", "indonesian": "indonesian", "eastern european": "eastern_european",
    "polish": "eastern_european", "ukrainian": "eastern_european", "russian": "eastern_european",
    "british": "british_irish", "irish": "british_irish", "english": "british_irish",
}  # fmt: skip


@dataclass
class Ingredient:
    line_no: int
    raw_text: str
    section: str | None = None


@dataclass
class RecipeDraft:
    source_url: str
    domain: str
    site_name: str | None
    title: str
    image_url: str | None = None
    servings: float | None = None
    prep_minutes: int | None = None
    cook_minutes: int | None = None
    total_minutes: int | None = None
    summary: str | None = None
    instructions: list[str] | None = None
    cuisines: list[str] = field(default_factory=list)
    ingredients: list[Ingredient] = field(default_factory=list)

    def payload(self, user_id: str | None) -> dict[str, Any]:
        """The argument for import_recipe()."""
        return {
            "added_by": user_id,
            "source": {
                "domain": self.domain,
                "name": self.site_name,
                "homepage_url": f"https://{self.domain}/",
            },
            "recipe": {
                "source_url": self.source_url,
                "title": self.title,
                "image_url": self.image_url,
                "servings": self.servings,
                "prep_minutes": self.prep_minutes,
                "cook_minutes": self.cook_minutes,
                "total_minutes": self.total_minutes,
                "summary": self.summary,
                "instructions": self.instructions,
            },
            "cuisines": self.cuisines,
            "ingredients": [vars(i) for i in self.ingredients],
        }


def canonical_url(url: str) -> str:
    """Lowercase host, no fragment, no tracking parameters; used to dedupe."""
    parts = urlsplit(url.strip())
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if not TRACKING_PARAMS.match(k)])
    host = (parts.hostname or "").lower()
    netloc = host if parts.port in (None, 80, 443) else f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, netloc, parts.path or "/", query, ""))


def domain_of(url: str) -> str:
    return re.sub(r"^www\.", "", (urlsplit(url).hostname or "").lower())


def _field[T](get: Callable[[], T]) -> T | None:
    """recipe-scrapers raises for missing fields; treat that as absent."""
    try:
        value = get()
    except (RecipeScrapersExceptions, NotImplementedError, AttributeError, TypeError, ValueError):
        return None
    return value if value not in ("", [], None) else None


def _minutes(value: Any) -> int | None:
    return int(value) if isinstance(value, int | float) and value >= 0 else None


def _servings(yields: str | None) -> float | None:
    match = re.search(r"\d+(?:\.\d+)?", yields or "")
    return float(match.group()) if match and float(match.group()) > 0 else None


def _cuisines(raw: str | None) -> list[str]:
    found = [CUISINES.get(part.strip().lower()) for part in re.split(r"[,/|;]", raw or "")]
    return sorted({c for c in found if c})


def _no_recipe() -> FetchError:
    return FetchError(
        "not_a_recipe",
        "We couldn't find a recipe on that page. Try the link to the recipe itself.",
    )


# Browser import: a page's JSON-LD blocks, as the user's own browser read them.
MAX_LD_BLOCKS = 20
MAX_LD_CHARS = 500_000


def page_from_json_ld(url: str, blocks: list[str], site_name: str | None = None) -> str:
    """A minimal page holding only the given JSON-LD, for extract_recipe().

    Blocks are parsed and re-serialized, so nothing but valid JSON reaches the
    page, and "</" is escaped so a block can't close its script tag.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FetchError("invalid_url", "That doesn't look like a web address.")
    if len(blocks) > MAX_LD_BLOCKS or sum(len(b) for b in blocks) > MAX_LD_CHARS:
        raise FetchError("too_large", "That page has too much data to import.")
    scripts = []
    for block in blocks:
        try:
            data = json.loads(block)
        except ValueError:
            continue
        safe = json.dumps(data).replace("</", "<\\/")
        scripts.append(f'<script type="application/ld+json">{safe}</script>')
    if not scripts:
        raise _no_recipe()
    meta = (
        f'<meta property="og:site_name" content="{html.escape(site_name, quote=True)}">'
        if site_name
        else ""
    )
    return f"<html><head>{meta}{''.join(scripts)}</head><body></body></html>"


def extract_recipe(page: str, url: str) -> RecipeDraft:
    try:
        scraper = scrape_html(page, org_url=url, supported_only=False)
    except RecipeScrapersExceptions as e:
        raise _no_recipe() from e
    title = _field(scraper.title)
    lines = _field(scraper.ingredients)
    if not title or not lines:
        raise _no_recipe()

    ingredients: list[Ingredient] = []
    groups = _field(scraper.ingredient_groups) or []
    if len(groups) > 1:
        for group in groups:
            ingredients += [
                Ingredient(len(ingredients), text, group.purpose) for text in group.ingredients
            ]
    else:
        ingredients = [Ingredient(n, text) for n, text in enumerate(lines)]

    final_url = canonical_url(_field(scraper.canonical_url) or url)
    if domain_of(final_url) != domain_of(url):
        final_url = canonical_url(url)  # don't trust a canonical link to another site

    return RecipeDraft(
        source_url=final_url,
        domain=domain_of(final_url),
        site_name=_field(scraper.site_name),
        title=title.strip(),
        image_url=_field(scraper.image),
        servings=_servings(_field(scraper.yields)),
        prep_minutes=_minutes(_field(scraper.prep_time)),
        cook_minutes=_minutes(_field(scraper.cook_time)),
        total_minutes=_minutes(_field(scraper.total_time)),
        summary=_field(scraper.description),
        instructions=_field(scraper.instructions_list),
        cuisines=_cuisines(_field(scraper.cuisine)),
        ingredients=ingredients,
    )
