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

## Deploying the web app (Vercel)

1. In the [Vercel dashboard](https://vercel.com/new), import the `auxiliarist-online/sous` GitHub repo.
2. Set **Root Directory** to `apps/web`. Vercel detects Vite; keep the default build (`npm run build`) and output (`dist`).
3. Add the `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` environment variables.
4. Deploy. Every merge to `main` then deploys to production, and every pull request gets a preview URL.

`apps/web/vercel.json` turns on clean URLs, so `public/sousbot.html` is served at `/sousbot`. That page is SousBot's public contact and opt-out page (TYL-36). Once it's live, set `SOUSBOT_CONTACT_URL` in the API's environment to its address so the crawler's user agent links to it.

The API isn't deployed yet; the web app only needs it for features that call `/api`.
