# Spike: grocery pricing and weekly deals sources

- **Issue:** [TYL-13](https://linear.app/tyler-solo/issue/TYL-13/spike-grocery-pricing-and-weekly-deals-data-sources)
- **Date:** 2026-10-06
- **Status:** Findings ready for review. Two items still need a hands-on check (see [Open checks](#open-checks)).

## Summary

- **Only one of the six stores has an official price API:** Harris Teeter, through Kroger's free public API (probable; to confirm). It returns store-specific regular _and_ sale prices, so it covers deals too.
- **The rest have no API.** Prices for Trader Joe's and Aldi can be scraped from their own websites, which is fine for a personal prototype but not something to build a paid product on. Ingles, the co-op and farmers markets have no usable live price data.
- **Fallback estimates carry most of the weight in v1.** Public government data (BLS average prices, USDA retail and farmers market reports) gives free, commercially usable baseline prices, and user overrides fill in the rest.
- **Instacart is the revenue path, not a price source.** Its developer API returns no prices, but it can send a Sous shopping list to Instacart for ordering and pays affiliate commission on orders.

## Recommendation for v1

Build price lookup as pluggable sources, tried in this order for each ingredient and store:

1. **User override:** "Tofu is $2.49 at my co-op." Remembered per store.
2. **Live store price:** Kroger API for Harris Teeter (and any Kroger-family store later).
3. **Weekly deal:** Kroger promo prices to start; other stores' ads later.
4. **Baseline estimate:** BLS/USDA average prices, adjusted over time by the prices users enter.

Every price records where it came from, so the UI can show "~$4 (estimate)" vs. "$3.49 at Harris Teeter".

| Store               | v1 approach                                                         | OK for a paid product?                             |
| ------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| **Harris Teeter**   | Kroger public API: live store prices and promo prices               | Likely yes: built for third-party apps; read terms |
| **Trader Joe's**    | Seed a price list once (from their site), then user overrides       | Only with hand-entered or user-entered data        |
| **Aldi**            | Baseline estimates + user overrides; optional personal-only scraper | No (scraping); revisit via a data deal             |
| **Ingles**          | Baseline estimates + user overrides                                 | Yes (no third-party data used)                     |
| **Co-op**           | User overrides; maybe the Co+op Deals sale flyer, entered by hand   | Yes                                                |
| **Farmers markets** | User overrides; USDA farmers market reports for seasonal ranges     | Yes                                                |

## Findings by source

### Kroger public API (Harris Teeter)

- Free: register an app at [developer.kroger.com](https://developer.kroger.com/) for a client ID and secret.
- The Products API returns **regular and promo prices**, availability and aisle location, but only when the request includes a store's `locationId`. Prices are per store, one store per call.
- Rate limits: Products 10,000 calls/day, Locations 1,600/day per endpoint, Cart 5,000/day. Enough for one household, and with caching (prices change roughly weekly) enough for a small user base.
- The Locations API returns every chain Kroger owns when no chain filter is given.
- **Harris Teeter coverage is probable, not confirmed:** Harris Teeter is Kroger-owned, its app is published by The Kroger Co., and its product URLs use Kroger's format. A single Locations API call settles it (see Open checks).
- Use requires following Kroger's Terms of Service, API Acceptable Use policy, and branding guidelines. Read these for caching and display rules before launch. Partner APIs need a contract; the public ones don't.
- **Why it matters for revenue:** the same integration covers every Kroger-family chain nationally (Kroger, Harris Teeter, Ralphs, Fred Meyer, King Soopers, Smith's, and others), which is the most realistic path to price coverage beyond local stores.

### Trader Joe's

- Trader Joe's has no sales and steady prices, so a list refreshed every month or two stays accurate enough.
- Their website lists prices with sizes (e.g. "$7.99/12 Fl Oz") for many, but not all, products. An open-source daily price tracker reads them through the site's internal GraphQL endpoint, per store code.
- The site blocked a plain automated request during this spike (HTTP 403), so scraping is fragile and not approved for a product.
- **Plan:** seed a staples price list by hand (or a one-off personal scrape), then rely on user overrides.

### Aldi

- Aldi publishes a weekly ad and per-ZIP prices on its site (its online ordering runs through Instacart in many markets). There is no public API.
- Third-party scrapers exist, which shows it's possible, but this is scraping without permission.
- **Plan:** baseline estimates + user overrides in v1. A personal-only scraper is possible later if Aldi prices matter enough.

### Ingles

- Weekly ad and digital coupons are available on its website and app (Ingles Advantage card). No public API. This spike found no confirmation of Instacart or Flipp coverage for Ingles.
- **Plan:** baseline estimates + user overrides. Revisit weekly ad data if Ingles turns out to be a main store.

### Local co-op

- If the co-op belongs to National Co+op Grocers (168 co-ops), it runs the **Co+op Deals** sale program with a digital flyer and app. There is no API.
- **Plan:** user overrides; optionally enter the main Co+op Deals items by hand each cycle. Which co-op is it?

### Farmers markets

- USDA AMS Market News publishes farmers market and direct-to-consumer prices for some regions, with an API (MyMarketNews). Coverage varies by region.
- **Plan:** user overrides; use USDA data for seasonal price ranges where it exists.

### Baseline price data (for TYL-28)

- **BLS average prices:** about 70 food items monthly, nationally and by region (the South covers your stores). Free downloads at `download.bls.gov/pub/time.series/ap/` and via the BLS API. Public domain.
- **USDA AMS retail reports:** weekly advertised prices for several hundred commodities from about 220 grocery chains (about 26,000 stores). Has an API. Public domain.
- Together these give a reasonable starting estimate for common ingredients. The canonical ingredient list (TYL-9) will need a mapping to these series.

### Aggregators

- **Instacart Developer Platform (IDP):** takes a list of items and returns a link to a shopping list page on Instacart. **It does not return prices** to the developer, and the shopper picks the store on Instacart. Partners can join Instacart's affiliate program through Impact (commission on attributed orders; reported rates are around 5% of the cart or a flat fee per new customer, so confirm current terms). Covers Aldi in many markets and many other retailers. **Good post-v1 revenue feature:** "Order this list on Instacart."
- **Flipp:** aggregates weekly ads from many chains, but has no public API. Access would need a business deal. Third-party Flipp scrapers exist; avoid them.
- **Commercial data vendors** (Syndigo, scraping services): paid, aimed at brands and retailers. Not needed for v1.

## Open checks

1. **Register a Kroger developer app** (free, needs your account) and call the Locations API near your ZIP. Confirm Harris Teeter stores come back, then pull one product's price.
2. **Read the Kroger API terms** for caching limits, attribution/branding, and any restrictions on paid apps.
3. **Which co-op?** Check whether it's in the Co+op Deals program.

## Effects on the backlog

- **TYL-20 / TYL-21 (prices, deals):** start with the Kroger adapter only. Other stores get adapters only when a legitimate source exists.
- **TYL-19 (store lookup):** Kroger's Locations API handles Kroger-family stores. Other stores are picked from a simple list (no lookup needed in v1).
- **TYL-28 (fallback estimates):** becomes the main price source for four of six stores. Seed from BLS + USDA.
- **New (post-v1):** "Order on Instacart" via IDP and its affiliate program.

## Sources

- Kroger developer portal: [home](https://developer.kroger.com/), [API basics and rate limits](https://developer.kroger.com/documentation/public/getting-started/apis), [Products API](https://developer.kroger.com/api-products/api/product-api-partner), [Locations API](https://developer.kroger.com/reference/api/location-api-public), [FAQ](https://developer.kroger.com/support/faq)
- Harris Teeter product URL in Kroger format: [harristeeter.com example](https://www.harristeeter.com/p/api-8oz/0064584760158); [Harris Teeter app (The Kroger Co.)](https://apps.apple.com/app/id422306980)
- Instacart: [IDP introduction](https://docs.instacart.com/developer_platform_api), [shopping list page](https://docs.instacart.com/developer_platform_api/guide/concepts/shopping_list/), [conversions and affiliate payments](https://docs.instacart.com/developer_platform_api/guide/concepts/launch_activities/conversions_and_payments), [IDP announcement](https://www.instacart.com/company/updates/the-instacart-developer-platform-a-new-way-to-turn-inspiration-into-action), [Aldi + Instacart](https://www.supermarketnews.com/grocery-trends-data/aldi-goes-nationwide-with-instacart)
- Trader Joe's: [open-source price tracker](https://github.com/cmoog/traderjoes), [products page](https://www.traderjoes.com/home/products)
- Aldi digital ad structure: [Numerator methodology note](https://promointelhelp.numerator.com/en/articles/12294493-aldi-digital-ad-entry-methodology)
- Flipp: [API Evangelist profile (no public API)](https://providers.apievangelist.com/providers/flipp-wishabi/)
- Co-ops: [NCG partner introduction (Co+op Deals)](https://partnerconnection.ncg.coop/download/file/2026_NCG_Partner_Introduction.pdf)
- BLS: [average price data fact sheet](https://www.bls.gov/cpi/factsheets/average-prices.htm)
- USDA AMS: [My Market News](https://mymarketnews.ams.usda.gov/)
