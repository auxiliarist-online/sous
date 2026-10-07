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
.venv/bin/pytest
```
