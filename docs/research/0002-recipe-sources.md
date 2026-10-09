# Research: recipe sources and tooling

- **Issues:** [TYL-26](https://linear.app/tyler-solo/issue/TYL-26/bulk-crawl-food-blogs-to-seed-the-recipe-catalog-firecrawl) (crawling), [TYL-27](https://linear.app/tyler-solo/issue/TYL-27/recipe-source-and-attribution-policy) (attribution policy), [TYL-9](https://linear.app/tyler-solo/issue/TYL-9/ingredient-parsing-and-normalization) (ingredient parsing)
- **Date:** 2026-10-06

## Summary

- **Crawl food blogs ourselves; don't buy or download a recipe dataset.** Read each blog's sitemap, fetch recipe pages directly, extract them with `recipe-scrapers`, and parse ingredients with `ingredient-parser-nlp`. Both libraries are MIT-licensed Python and fit the FastAPI stack. Cost: free.
- **Firecrawl is a fallback, not the main crawler.** Its free tier is about 500–1,000 pages a month, while a starter set of blogs is likely tens of thousands of pages. Use it only for pages a plain fetch can't read.
- **Most recipe datasets can't be used commercially.** RecipeNLG (2M+ recipes) is non-commercial only. Kaggle scrapes such as Food.com have unclear rights. They're fine for testing our parser offline, but not for the product.
- **Recipe APIs don't fit as the foundation.** Spoonacular limits caching to 1 hour, so we couldn't build our own catalog from it. Edamam and TheMealDB have similar limits or paid tiers.
- **Public-domain starting point:** USDA MyPlate Kitchen. It has hundreds of budget-friendly recipes, is US government content, and `recipe-scrapers` already supports it.
- **Respect bloggers' wishes about AI use.** Several target blogs block AI training crawlers in `robots.txt`. Sous should crawl under its own honest name and never use recipe content to train models.

## Recommended pipeline

```
blog sitemap ──► recipe URLs ──► fetch page (polite, own user agent)
                                    │  blocked / needs JS?
                                    ├──────────────► Firecrawl (fallback)
                                    ▼
                         recipe-scrapers (schema.org Recipe JSON-LD)
                                    ▼
                    ingredient-parser-nlp (quantity, unit, name, prep)
                                    ▼
            diet tagging (TYL-10) ─► store per attribution policy (TYL-27)
```

- **Polite crawling:** obey `robots.txt`, one request every few seconds per site, run overnight in small batches, use a `SousBot` user agent with a contact URL, and stop for any site that asks.
- **Store:** title, source name and URL, image URL, times, servings, cuisine, ingredients (raw and parsed), and diet flags. Link to the source for instructions (TYL-8, TYL-27).
- **Recrawl:** use sitemap `lastmod` to only fetch new or changed recipes.

## Starter crawl list

All of these are supported by `recipe-scrapers` 15.12 (checked 2026-10-06), and none block general crawlers in `robots.txt`.

| Group                   | Sites                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vegetarian / vegan core | Cookie and Kate, Love and Lemons, Minimalist Baker, Rainbow Plant Life, Vegan Richa, Oh She Glows, 101 Cookbooks, Feasting at Home                      |
| Global cuisines         | Veg Recipes of India, Swasthi's (indianhealthyrecipes.com), The Woks of Life (Chinese), Maangchi (Korean), Just One Cookbook (Japanese), RecipeTin Eats |
| Budget                  | Budget Bytes                                                                                                                                            |
| General, well-tested    | Serious Eats, Pinch of Yum, Simply Recipes                                                                                                              |
| Public domain           | USDA MyPlate Kitchen (myplate.gov)                                                                                                                      |

- The general and global blogs include meat dishes too; diet tagging (TYL-10) filters them. They're on the list for discovery: cuisines you wouldn't find on a vegetarian-only blog.
- **Leave out big publishers for now** (NYT Cooking, Bon Appétit, Allrecipes, EatingWell, Food52). They have paywalls, stricter terms, and legal teams; they're better approached through partnerships later.
- Sizes are a guess until we read the sitemaps: roughly 500–3,000 recipes per blog, so about 15,000–40,000 recipes in total.

### AI crawler rules

Cookie and Kate, The Woks of Life, and Maangchi block `GPTBot`, `anthropic-ai`, `Claude-Web`, `CCBot` and `Google-Extended` while allowing other crawlers. Sous isn't an AI training crawler, but this tells us how these authors feel about AI use of their work. For the policy (TYL-27) and the assistant (TYL-25):

- Crawl under an honest `SousBot` user agent. Never borrow another bot's identity, and never get around a block.
- Don't use crawled recipe text to train or fine-tune models.
- The assistant answers from Sous's stored metadata and links to the source; it doesn't reproduce a blogger's instructions.
- Offer an easy opt-out (a contact address and honoring `SousBot` rules in `robots.txt`).

## Update 2026-10-07: bot protection blocks most of the list

Testing TYL-8, we requested each starter site's homepage once with an honest `SousBot/0.1` user agent. **11 of 19 refused us** even though their `robots.txt` allows it. Most of them run Cloudflare bot challenges (`cf-mitigated: challenge`, the "Just a moment…" page), which stop any client that isn't a real browser or a verified bot.

| Result        | Sites                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reachable (8) | Love and Lemons, Minimalist Baker, Vegan Richa, Oh She Glows, 101 Cookbooks, Just One Cookbook, RecipeTin Eats, Swasthi's                                                                                          |
| Blocked (11)  | Cookie and Kate, Rainbow Plant Life, Feasting at Home, Veg Recipes of India, The Woks of Life, Maangchi, Budget Bytes, Serious Eats, Pinch of Yum (CloudFront), Simply Recipes, MyPlate (403, no challenge header) |

The policy (TYL-27) rules out getting around these blocks: no browser user agent, no stealth proxies, no Firecrawl to bypass them. Honest options:

- **Become a verified bot.** Cloudflare's verified-bots program and its signed-agent ("Web Bot Auth") standard let sites recognize and allow a well-behaved crawler. Both need a public bot page (TYL-27's contact page) and a stable, documented crawler.
- **Ask the sites.** Bloggers can allowlist `SousBot`. A personal note with the attribution policy is a reasonable ask for a small set of favorite sites.
- **Import from the user's own browser.** For a single recipe the user is already looking at, a bookmarklet or share target can send the page's recipe data from their browser to Sous. That's the user's own visit, so nothing is being bypassed.
- **MyPlate** is public domain: check whether USDA publishes the recipes as a download or API before crawling.

## Update 2026-10-08: terms check and MyPlate

- **Terms:** checking the 8 reachable sites' terms before crawling (TYL-41) found none usable for a paid product without permission, and two more now block SousBot. Notes per site are in `recipe_sources.crawl_notes`.
- **MyPlate Kitchen** was retired with MyPlate.gov in January 2026, and not all of its recipes were federal works. Federal recipes now come from USDA's Food and Nutrition Service (TYL-42).
- What Sous does instead is in [ADR 0002](../adr/0002-recipe-catalog.md).

## Libraries

| Library                                                                      | License | Notes                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [recipe-scrapers](https://github.com/hhursev/recipe-scrapers) 15.12          | MIT     | 725 supported sites; reads schema.org JSON-LD, microdata and OpenGraph. Parses HTML only: we do the fetching, and it doesn't bypass bot protection.            |
| [ingredient-parser-nlp](https://github.com/strangetom/ingredient-parser) 2.8 | MIT     | ML model trained on 75,000 sentences; reported ~96% sentence-level and ~98% word-level accuracy. Strong candidate for TYL-9 instead of writing our own parser. |

Quick test of `ingredient-parser-nlp` on typical lines:

| Input                                                  | Name                  | Amount          | Prep               |
| ------------------------------------------------------ | --------------------- | --------------- | ------------------ |
| 2 1/2 cups all-purpose flour, sifted                   | all-purpose flour     | 5/2 cup         | sifted             |
| 1 (15 oz) can chickpeas, drained and rinsed            | chickpeas             | 1 can, 15 ounce | drained and rinsed |
| 3 cloves garlic, minced                                | garlic                | 3 cloves        | minced             |
| 14 oz extra-firm tofu, pressed                         | extra-firm tofu       | 14 ounce        | pressed            |
| Salt and pepper to taste                               | Salt, pepper          | (none)          | (none)             |
| 2 tablespoons fish sauce (or soy sauce for vegetarian) | fish sauce, soy sauce | 2 tablespoon    | (none)             |

The last row is the kind of line diet tagging must handle: the recipe is vegetarian only if the soy sauce option is chosen. Ranges like "1–2 tbsp" also need checking (the test showed only the lower bound).

Note: the parser downloads a small NLTK data file on first run, so the API's deploy step should include it.

## Datasets and APIs considered

| Source                          | Size                         | Commercial use?                                       | Verdict                                    |
| ------------------------------- | ---------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| RecipeNLG                       | 2M+                          | No (CC BY-NC-SA 4.0)                                  | Offline parser/tagger testing only         |
| Food.com / other Kaggle scrapes | 200K–2M                      | Unclear: scraped without the sites' permission        | Offline testing only                       |
| USDA MyPlate Kitchen            | Hundreds                     | Yes (US government work)                              | **Use:** safe seed, can store in full      |
| Spoonacular API                 | ~365K                        | Paid; cache max 1 hour; delete all data when you stop | No: can't build our own catalog            |
| Edamam Recipe Search            | ~2.3M (links to other sites) | Paid tiers, up to $999/month                          | No for v1; possible discovery add-on later |
| TheMealDB                       | Small; free tier 100 items   | Paid supporter tier required to publish an app        | No                                         |

## Open-source apps worth studying

- **[Mealie](https://github.com/mealie-recipes/mealie)** (AGPL-3.0) and **[Tandoor](https://github.com/TandoorRecipes/recipes)** (AGPL-3.0 + Commons Clause): self-hosted recipe managers with URL import, meal planning, and shopping lists grouped by aisle. Useful for UX and data model ideas.
- **Don't copy their code.** AGPL would require Sous to publish its source, and Tandoor's Commons Clause forbids selling it. Read for ideas only.

## Effects on the backlog

- **TYL-26 (crawling):** the main pipeline is sitemap + direct fetch; Firecrawl only as a fallback. Start with the list above.
- **TYL-9 (ingredient parsing):** adopt `ingredient-parser-nlp`; our work becomes canonical ingredient mapping, alternatives, and ranges.
- **TYL-27 (policy):** add the AI-related commitments above.
- **TYL-25 (assistant):** answer from stored metadata; link out for instructions.

## Sources

- [recipe-scrapers](https://github.com/hhursev/recipe-scrapers), [PyPI](https://pypi.python.org/project/recipe-scrapers); [ingredient-parser](https://github.com/strangetom/ingredient-parser), [docs](https://ingredient-parser.readthedocs.io/)
- [RecipeNLG on Hugging Face (license)](https://huggingface.co/datasets/mbien/recipe_nlg)
- Firecrawl pricing: [Costbench free plan summary](https://costbench.com/software/web-scraping/firecrawl/free-plan/), [eesel pricing review](https://www.eesel.ai/blog/firecrawl-pricing)
- [Spoonacular API terms](https://spoonacular.com/food-api/terms); [Edamam Recipe Search API](https://developer.edamam.com/edamam-recipe-api); [TheMealDB API](https://www.themealdb.com/api.php); [recipe API comparison](https://blog.suggestic.com/recipe-api-ultimate-list)
- [MyPlate Kitchen](https://www.myplate.gov/myplate-kitchen), [MyPlate about (public domain)](https://MyPlate.gov/about-us)
- Mealie/Tandoor: [Mealie license](https://awesome.ecosyste.ms/projects/github.com%2Fmealie-recipes%2Fmealie), [Tandoor license](https://isitreallyfoss.com/projects/tandoor), [comparison](https://cooklang.org/blog/42-tandoor-vs-mealie-vs-kitchenowl/)
- `robots.txt` files for each blog, fetched 2026-10-06
