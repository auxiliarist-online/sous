# ADR 0002: Where Sous's recipes come from

- **Status:** Accepted
- **Date:** 2026-10-08
- **Issues:** [TYL-41](https://linear.app/tyler-solo/issue/TYL-41) (per-site check), [TYL-42](https://linear.app/tyler-solo/issue/TYL-42) (federal recipes)
- **Policy:** [policies/recipe-sources.md](../policies/recipe-sources.md)

## Context

The plan was to seed a public catalog by crawling popular food blogs (TYL-26): store each recipe's title, ingredients and times, link back for the instructions, and start from USDA MyPlate Kitchen as public-domain content. The crawler is built, but checking the starter sites before switching it on changed the picture.

- **None of the 8 reachable starter blogs can be crawled for a paid product.** Six have terms that forbid commercial reuse without written permission, several naming ingredient lists or reposting recipes. 101 Cookbooks also forbids linking to its images. Oh She Glows and Just One Cookbook now block SousBot outright. The other 11 starter blogs were already blocked. Details per site are in `recipe_sources.crawl_notes` and on TYL-41.
- **MyPlate Kitchen is gone.** USDA retired MyPlate in January 2026, and myplate.gov now refuses all clients. Many of its recipes came from university and state partners, so they weren't all public domain anyway. The surviving copies don't fit: the Wayback Machine grants access "for scholarship and research purposes only", and myplate.food is a commercial mirror that licenses bulk use.
- **Copyright isn't the obstacle; the sites' terms are.** In the US, ingredient lists are generally treated as facts. The blogs' terms of use are contracts, and the policy chose to respect them. That stays the right line for a product that will charge money.

## Decision

**Sous is a tool for a person's own recipes, not a publisher of other people's.** Recipes come from three layers:

1. **Your library (private).** Recipes each user imports from any site (TYL-8, TYL-35) or types in. Saving a recipe for your own use is the personal use every one of these sites allows. The full recipe is stored privately, so search, diet labels, planning and price estimates all work on it. This is the main source of recipes, so importing must be effortless: a share target from the phone's browser, and import from the user's own browser for sites that block servers.
2. **The Sous catalog (shared).** Only recipes we're allowed to share: openly licensed collections such as the Wikibooks Cookbook (TYL-45), federal works from USDA's Food and Nutrition Service (TYL-42), and sites that give written permission (TYL-46). It's smaller, but complete, so a new user has something to plan with on day one.
3. **Web search (deferred).** Searching the web through a search API, with "Save to Sous" into the library, costs money per query. It's back-burnered to keep Sous free to run (TYL-47).

The crawler (TYL-26) stays, but only for sources that have given permission or whose license allows it.

## Alternatives considered

- **Crawl the blogs anyway, since ingredients are facts.** Rejected: it breaks the sites' terms, and it's the kind of thing that hurts a paid product later.
- **A personal, non-commercial proof of concept** that crawls these blogs into a catalog only Tyler can see. It would fit most of their personal-use terms, but anything collected that way could never become the product's catalog. The library model gives the same result for any user, through their own imports.
- **Accept donations (e.g. Patreon) and call it non-commercial.** Taking money for an app built on these sites' recipes is hard to call non-commercial, and letting other people browse crawled recipes is republishing, which several sites forbid regardless.
- **Index titles and links only** from these sites, as a search engine would. Defensible, but it still means crawling sites with unfriendly terms. Revisit after the legal review the policy calls for.
- **License MyPlate Kitchen from myplate.food.** Costs money for content that's mostly available from USDA directly (TYL-42).

## Consequences

- TYL-35 (import UI, share target, browser import) is now the most important M2 work.
- Browse and discovery (TYL-12) and recommendations (TYL-16) work over the user's library plus the catalog.
- The catalog needs a way to record open licenses and their attribution rules (TYL-45).
- Images: some sites forbid linking to their images, so a crawled or catalog recipe shows the source's image only when its terms or license allow it.
