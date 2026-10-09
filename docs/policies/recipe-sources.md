# Policy: recipe sources and attribution

- **Issue:** [TYL-27](https://linear.app/tyler-solo/issue/TYL-27/recipe-source-and-attribution-policy)
- **Date:** 2026-10-07
- **Applies to:** URL import (TYL-8), the bulk crawler (TYL-26), the catalog UI (TYL-12), and the assistant (TYL-25)
- **Background:** [research/0002-recipe-sources.md](../research/0002-recipe-sources.md)

Sous shows other people's recipes to help people find them and cook them. It should send readers to the bloggers who wrote them, not replace their sites. Every rule below follows from that, and each one is meant to hold up once Sous is a paid product, not just a personal tool.

## Summary

- **Sous is a tool for your own recipes, not a publisher of other people's.** Recipes from food blogs reach Sous mainly through each user's own imports, kept private to them. The shared catalog holds only recipes we're allowed to share: open licenses, federal works, and sites that give written permission. See [ADR 0002](../adr/0002-recipe-catalog.md).
- **Store facts, link to the writing.** For third-party recipes we keep the title, ingredients, times, servings and an image link. Instructions and the author's own prose stay on their site.
- **Credit every recipe where it's shown.** Every card and detail page shows the source name and a link to the original.
- **Crawl politely and honestly.** Use a `SousBot` user agent with a contact link, obey `robots.txt`, keep request rates low, and never get around a block.
- **Opting out is easy and quick.** A site that asks to be removed is hidden within 7 days and never crawled again.
- **No model training on recipe content.** The assistant answers from stored metadata and links out.

## What we store

The rules depend on `recipe_sources.content_rights`, which defaults to `link_only`.

| Field                                     | `link_only` (default)                                                     | `public_domain` / `licensed` |
| ----------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| Title                                     | Store                                                                     | Store                        |
| Source name, canonical URL                | Store (required)                                                          | Store (required)             |
| Ingredient lines (raw and parsed)         | Store                                                                     | Store                        |
| Times, servings, yield                    | Store                                                                     | Store                        |
| Cuisine, category, keywords               | Store                                                                     | Store                        |
| Publisher's diet tags (`suitableForDiet`) | Store as a hint only (`source = 'publisher'`); labels we show are derived | Same                         |
| Image                                     | Store the URL only; see [Images](#images)                                 | Store the URL only           |
| Description or headnote                   | **Don't store**; `summary` stays empty                                    | Store                        |
| Instructions                              | **Don't store**; link to the source                                       | Store                        |
| Reviews, ratings, comments, nutrition     | Don't store                                                               | Don't store                  |

Why we draw the line here: in the US, a list of ingredients is generally treated as facts, while instructions written with real explanation, and the stories around them, are the author's expression. A title, an ingredient list and a link are what a reader needs to decide whether to cook something. The rest is why they visit the blog.

Rules that follow from this:

- **`summary` is ours or nothing.** For `link_only` recipes it stays null, or we write it ourselves from facts ("Vegetarian · Thai · 35 min · serves 4"). We never copy, paraphrase or AI-rewrite the author's description.
- **Search** covers title, cuisine and ingredient names. It never indexes text we don't store.
- **Federal recipes** (USDA's Food and Nutrition Service) are US government work, so they're `public_domain` and instructions can be shown in full, with credit to the collection. Only recipes whose source is a federal agency count; recipes credited to a university or state partner may be copyrighted. (USDA MyPlate Kitchen was retired in January 2026.)
- **`licensed`** means we have written permission from the site, saved in the source's record. Never set it on our own judgement.

## Attribution

- Every recipe **card** shows the source name. Every **detail page** shows the source name and a prominent "View full recipe on {source}" button above the ingredients. That button is the main action, not a footnote.
- Links go straight to the recipe's canonical URL. Don't add our own tracking parameters, show an interstitial page, or frame the source site.
- Shopping lists and meal plans keep the source name and link next to each recipe.
- The assistant always gives the link whenever it names a recipe.

## Images

- **Show the source's own image by its URL; don't copy, cache, crop into new files, or re-host it.** Images are the most clearly copyrighted part of a recipe page, and a hotlinked image stays under the blogger's control.
- **Only when the source allows it.** Some sites forbid linking to their images (101 Cookbooks, for example). For catalog sources, store `image_url` only when the site's terms, license or written permission allow it, and note which in `crawl_notes`. Otherwise show the placeholder. A user's private import may keep the image link, since only they see it.
- Load images lazily and only on screens where the recipe is shown with its attribution.
- If an image fails to load or a site asks us not to hotlink, show a plain placeholder. Don't fall back to another copy of the image.
- Image thumbnails stored by Sous need permission from the site (that is, `licensed`).

## Crawling and fetching

These rules cover both the bulk crawler and a user pasting a URL.

- **User agent:** `SousBot/<version> (+<contact URL>)`. The contact URL must lead to a page that explains what Sous does and how to opt out. **Bulk crawling must not start until that page exists.** Never send another bot's or a browser's user agent.
- **`robots.txt`:** obey the rules for `SousBot`, falling back to `*`. Re-read it at least daily during a crawl. User imports follow the same rules: if `robots.txt` disallows the page, the import fails with a clear message and the user can still open the link.
- **Rate limits:** at most one request every 5 seconds per site, or the site's `Crawl-delay` if it's longer. Back off on `429` or `503` and stop for the day after repeated errors. Run bulk crawls in small overnight batches.
- **Only what we need:** fetch recipe pages found through the site's sitemap. Use sitemap `lastmod` to re-fetch only new or changed recipes.
- **No circumvention:** don't get past logins, paywalls, CAPTCHAs, bot challenges or IP blocks. A `401`, `403` or challenge page means stop for that page.
- **Firecrawl fallback:** allowed only to render a page that needs JavaScript and that `robots.txt` lets us fetch. Never use it to get past a block, and never use its stealth or proxy modes on recipe sites.
- **Before a site goes into the crawler** (`crawl_enabled = true`), check and note in the source record or PR:
  1. `robots.txt` allows `SousBot`.
  2. The site's terms don't forbid automated access or commercial reuse. If they do, the site stays out unless we get permission.
  3. `content_rights` is set correctly.

## User imports

A user pasting a URL (TYL-8) follows the same storage rules as the crawler. The one difference is who can see the result:

- If the URL's domain is an approved source (`crawl_enabled` and not opted out), the recipe joins the public catalog as `needs_review`.
- Otherwise it's saved as `private` to that user. It only becomes public after its source has been reviewed and approved.
- Imports from an opted-out site still work for the user's own private use, as a saved link: title, URL and ingredients, but no image. Imported recipes are never shown publicly.
- Recipes a user types in by hand are their own content; we store everything they enter, including instructions, and keep it private.

### Import from the user's browser

For sites that block Sous's server, the user's own browser sends the recipe data from a page they're viewing (a bookmarklet reads the page's schema.org JSON-LD; `POST /recipes/import-page`).

- **No fetch, so no robots.txt check.** The user visited the page themselves; Sous doesn't contact the site. This is the honest alternative to getting around a block, not a way around one: Sous's server still never fetches a page that refuses it.
- **Same storage rules.** The data goes through the same extractor, so `link_only` sources still lose the description and instructions.
- **Only trusted for that user.** Anyone could send made-up data for any address, so a browser import is always a private copy for the person who sent it (`origin = 'browser'`). It's never public, never shared with other users, and never reused when someone else imports the same address. If Sous has already fetched that recipe itself, the user gets that trusted copy instead.

## Opt-outs and takedowns

- The contact page lists an email address for opt-out and takedown requests. Reply within 3 business days.
- **Whole-site opt-out:** set `opted_out_at`, set `crawl_enabled = false`, and set the site's public recipes to `hidden` within 7 days. Users' existing meal plans and lists keep the title and link, so nothing breaks for them, but the recipes leave search and discovery.
- **Single-recipe takedown:** set that recipe to `removed` within 7 days, with the same behavior for existing plans.
- Honor `SousBot` disallow rules in `robots.txt` the same way as an emailed opt-out, from the next crawl.
- Keep a simple log of each request and what we did (date, site, action).

## AI use

- Never use crawled recipe text or images to train or fine-tune any model, ours or a vendor's. Only use model providers whose terms don't train on our API traffic.
- The assistant (TYL-25) answers from Sous's stored metadata: titles, ingredients, cuisines, times, diet labels and prices. It doesn't reproduce or summarize a blogger's instructions or headnotes, and it links to the source.
- Never generate "rewritten" versions of a source recipe's instructions.

## Datasets

- Non-commercial or unclear-rights datasets (RecipeNLG, Kaggle scrapes such as Food.com) may be used **offline only**, to test the ingredient parser and diet tagger. They never go into the production database, fixtures that ship, or anything users see.
- Keep any such data out of the repo. Store it locally and note its license next to the test that uses it.

## Needs legal review before charging money

This policy is a careful starting point, not legal advice. Before Sous takes payment, get a lawyer to review:

1. **Showing full ingredient lists** from `link_only` sources in a commercial product, and whether the parsed or raw form changes anything.
2. **Hotlinking images** in a paid app, versus showing no images or getting permission.
3. **Each crawled site's terms of service**, especially any that forbid commercial use of their content.
4. **DMCA safe harbor:** register a designated agent with the US Copyright Office and publish the takedown process.
5. **Affiliate or partnership revenue** tied to recipe traffic (for example Instacart, TYL-31), which can change how a court sees our use of third-party recipes.
6. **Terms of service and privacy policy** for Sous itself, covering user-imported recipes.

## Effects on the backlog

- **TYL-8 (import from URL):** follow [What we store](#what-we-store), [Crawling and fetching](#crawling-and-fetching) and [User imports](#user-imports). Don't store `description` or instructions for `link_only` sources.
- **TYL-26 (bulk crawl):** only for sources that gave written permission or whose license allows it. The first per-site check (TYL-41, 2026-10-08) found none of the starter blogs usable without permission; requests go out under TYL-46.
- **TYL-35 (import UI):** the main way blog recipes reach Sous, so importing must be quick from a phone.
- **TYL-12 (browse UI):** attribution on every card, "View full recipe" as the main action, image placeholder.
- **TYL-25 (assistant):** answers from metadata only, always with the link.
