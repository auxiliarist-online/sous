# Sous

Plan home-cooked meals for the week and get a budget-aware shopping list built around local grocery prices and deals.

Stack and reasoning: [docs/adr/0001-stack.md](docs/adr/0001-stack.md).

## Layout

```
apps/
  web/   React + TypeScript (Vite), mobile-first UI
  api/   Python FastAPI service
supabase/
  migrations/   Postgres schema (Supabase migrations)
  tests/        Schema tests, run against PGlite
docs/
  adr/          Architecture decision records
  research/     Spikes and research notes
  policies/     Product policies (recipe sources and attribution)
  data-model.md Schema overview and diagram
```

## Prerequisites

- Node 22+ and npm
- Python 3.12+

## Setup

```sh
# Web
npm install
cp apps/web/.env.example apps/web/.env.local

# API
cd apps/api
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
cp .env.example .env
```

Fill in the Supabase values in both env files. They are gitignored; never commit real keys.

## Running locally

In two terminals:

```sh
# API on http://localhost:8000
cd apps/api && .venv/bin/uvicorn app.main:app --reload

# Web on http://localhost:5173
npm run dev
```

The web dev server proxies `/api/*` to the API, so the frontend calls `/api/health` and so on.

## Checks

These are the same checks CI runs on every pull request.

```sh
# Web (from the repo root)
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:db   # database migrations + access rules

# API (from apps/api)
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/mypy app tests
.venv/bin/pytest --cov   # unit tests; see apps/api/tests/README.md for integration and live tests
```

## Crawling recipe sites

The crawler (`apps/api/app/crawl`, TYL-26) seeds the catalog from approved sites, following [docs/policies/recipe-sources.md](docs/policies/recipe-sources.md). It only crawls sources with `crawl_enabled` set, which happens after the per-site check in the policy (noted in `recipe_sources.crawl_notes`). It refuses to run until `SOUSBOT_CONTACT_URL` points at the live SousBot page.

```sh
cd apps/api
.venv/bin/python -m app.crawl                         # every approved site, 100 pages each
.venv/bin/python -m app.crawl --source example.com --max-pages 20
```

Each run reads the site's sitemaps, queues new or changed URLs (by `lastmod`), and fetches them at most once every 5 seconds per site (longer if `robots.txt` sets `Crawl-delay`). Progress is in `crawl_pages` and `crawl_runs`. It's meant to run nightly as a batch job; where that runs is still open (ADR 0001).

## Deploying (Vercel)

Two Vercel projects deploy from this repo on every merge to `main`, and every pull request gets preview links:

| Project              | Root Directory | Production                       |
| -------------------- | -------------- | -------------------------------- |
| `sous` (web)         | `apps/web`     | https://sous-tawny.vercel.app    |
| `sous-api` (FastAPI) | `apps/api`     | https://sous-api-five.vercel.app |

- **Web:** Vite defaults (`npm run build`, output `dist`). `apps/web/vercel.json` turns on clean URLs, so `public/sousbot.html` is served at `/sousbot`, and rewrites `/api/*` to the API project, so the browser only ever talks to one origin.
- **API:** Vercel runs the FastAPI `app` in `app/main.py` as one function. Its environment needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (set as a sensitive variable) and `SOUSBOT_CONTACT_URL` (the `/sousbot` page above).
- **Web environment:** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the public anon key only).
