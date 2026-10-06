# ADR 0001: Platform and tech stack

- **Status:** Accepted
- **Date:** 2026-10-06
- **Issue:** [TYL-5](https://linear.app/tyler-solo/issue/TYL-5/decide-platform-and-tech-stack)

## Context

Sous plans home-cooked meals for the week and builds a budget-aware shopping list from local grocery prices and deals. The v1 decision has to cover:

- **Planning:** browse recipes, build a weekly plan, set preferences.
- **Shopping:** use the list in the store, check items off, see prices.
- **Data work:** import recipes from URLs, parse ingredients, match them to store products, and pull in weekly deals on a schedule.

The data is relational: recipes ↔ ingredients ↔ products ↔ prices/deals ↔ users/plans.

## Decision

| Area        | Choice                                                       |
| ----------- | ------------------------------------------------------------ |
| Platform    | Web app only, designed mobile-first                          |
| Frontend    | React + TypeScript, built with Vite                          |
| Backend/API | Python, FastAPI                                              |
| Database    | Postgres on Supabase                                         |
| Auth        | Supabase Auth (email magic link + Google)                    |
| Hosting     | Vercel for the web app and API; Supabase for DB/auth/storage |

### Rationale

- **Web, mobile-first:** the shopping list is used on a phone in the store, so layouts are designed for small screens first and scale up for planning on a desktop. A single web deployable avoids app store accounts, review, and release overhead while the product is taking shape. It can be made installable as a PWA later.
- **Python API:** recipe scraping, ingredient parsing/normalization, and product matching all have mature Python libraries (e.g. `recipe-scrapers`, NLP/fuzzy-matching tools). FastAPI gives typed request/response models and an OpenAPI schema, which we can turn into a TypeScript client for the frontend.
- **Postgres on Supabase:** the data is relational and Postgres fits it. Supabase is managed, has a free tier, and provides auth and storage (recipe images) in the same place.
- **Supabase Auth:** the frontend signs in with the Supabase JS client. The API verifies the Supabase JWT on each request, and row-level security can guard user-owned tables.

## Consequences

- **Two apps in one repo:** a monorepo with `apps/web` (Vite/React) and `apps/api` (FastAPI). The OpenAPI-generated client keeps the types in sync between them.
- **Mobile-first is a design rule, not a feature:** every screen is built and checked at phone width first. Touch targets, one-handed use, and poor in-store connectivity (keep the current list usable offline once loaded) matter more than desktop polish.
- **Vercel's limits for Python:** Vercel runs FastAPI as serverless functions, which is fine for request/response endpoints. Recurring, long-running jobs (weekly deal ingestion, bulk price refresh) may exceed function time limits. Options, in order of preference:
  1. Supabase scheduled functions / `pg_cron` triggering short batch endpoints.
  2. A small worker on Fly.io or Railway if jobs outgrow that.

  The data-source spike (TYL-13) will settle this.

- **Native later, if ever:** if a native app becomes worth it, React Native/Expo can reuse the API, auth, and generated client.

## Alternatives considered

- **Native mobile first (Expo):** a better in-store experience, but store accounts and release overhead aren't worth it this early. Deferred.
- **Next.js full-stack TypeScript:** a single deployable, but weaker libraries for the parsing and matching work than Python.
- **Auth.js / Clerk:** both are viable, but redundant once Supabase is the database.
