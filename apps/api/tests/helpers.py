"""Synthetic recipe pages for tests. Written for Sous; no real blog content."""

import json
from typing import Any

# Synthetic page in the shape food blogs publish (schema.org Recipe JSON-LD).
RECIPE_LD = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    "name": "Weeknight Black Bean Tacos",
    "url": "https://example-blog.com/black-bean-tacos/",
    "image": ["https://example-blog.com/img/tacos.jpg"],
    "description": "A short headnote written by the author.",
    "recipeYield": ["4", "4 servings"],
    "prepTime": "PT10M",
    "cookTime": "PT15M",
    "totalTime": "PT25M",
    "recipeCuisine": "Mexican, Gluten-Free",
    "recipeIngredient": [
        "1 (15 oz) can black beans, drained",
        "8 corn tortillas",
        "1 avocado",
    ],
    "recipeInstructions": [
        {"@type": "HowToStep", "text": "Warm the beans."},
        {"@type": "HowToStep", "text": "Fill the tortillas."},
    ],
}


def page_html(ld: dict[str, Any] | None = None, canonical: str | None = None) -> str:
    link = f'<link rel="canonical" href="{canonical}">' if canonical else ""
    script = (
        f'<script type="application/ld+json">{json.dumps(ld)}</script>' if ld is not None else ""
    )
    return (
        f"<html><head><title>Tacos</title>"
        f'<meta property="og:site_name" content="Example Blog">{link}{script}'
        f"</head><body><p>Story about tacos.</p></body></html>"
    )


SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9"


def urlset(entries: list[tuple[str, str | None]]) -> str:
    """A sitemap listing pages: [(url, lastmod or None)]."""
    urls = "".join(
        f"<url><loc>{url}</loc>{f'<lastmod>{mod}</lastmod>' if mod else ''}</url>"
        for url, mod in entries
    )
    return f'<?xml version="1.0"?><urlset xmlns="{SITEMAP_NS}">{urls}</urlset>'


def sitemap_index(urls: list[str]) -> str:
    items = "".join(f"<sitemap><loc>{url}</loc></sitemap>" for url in urls)
    return f'<?xml version="1.0"?><sitemapindex xmlns="{SITEMAP_NS}">{items}</sitemapindex>'
