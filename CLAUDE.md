# Sous

Meal planner: discover recipes, plan the week under a dollar budget, and get a shopping list priced against local stores. Work is tracked in Linear project P-TYL-1 (issue keys `TYL-*`).

## Layout and commands

- `apps/web`: React + TypeScript (Vite), mobile-first. From the repo root: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`.
- `apps/api`: FastAPI. From `apps/api`: `.venv/bin/ruff check .`, `.venv/bin/ruff format --check .`, `.venv/bin/mypy app tests`, `.venv/bin/pytest --cov`. Test layers are described in `apps/api/tests/README.md`.
- `supabase/migrations`: Postgres schema; `npm run test:db` checks migrations and row-level security.
- Design docs: `docs/adr/`, `docs/data-model.md`, `docs/policies/`, `docs/research/`.

## Rules

- **Changes go through pull requests.** Never push to `main`. Branch names follow the Linear issue's branch name (`tylernhughes/tyl-<n>-...`).
- **Recipe content follows `docs/policies/recipe-sources.md`.** For `link_only` sources, never store or show the author's instructions or description; images are linked, never copied. Crawling uses the honest `SousBot` user agent, obeys `robots.txt`, and never gets around blocks.
- **Never commit real blog pages** as test fixtures. Write small synthetic HTML instead (`apps/api/tests/helpers.py`).
- **Diet labels are derived from ingredients**, never trusted from the source (`recipe_meets_diet()`).
- **Server-side fetching of user URLs** must keep the SSRF checks in `app/recipes/fetch.py` (public addresses only, every redirect hop checked).
- **Database:** money is integer cents; IDs are UUIDs; recipes are never deleted (`status = 'removed'`). Catalog tables are written only by the API (service role); user tables are protected by RLS. New migrations need tests in `supabase/tests`.
- **Secrets** live in gitignored env files. Never commit keys, and never send the service-role key to the browser.

## Reviewing

Focus on correctness, security (RLS, SSRF, secrets), and the rules above. Skip style nits that ruff, prettier, or oxlint already enforce.
