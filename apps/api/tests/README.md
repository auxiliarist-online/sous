# API tests

| Layer | Folder | Runs | Needs |
| --- | --- | --- | --- |
| Unit | `tests/unit` | always | nothing: HTTP is mocked, no database |
| Integration | `tests/integration` | when `SOUS_TEST_DATABASE_URL` is set; always in CI | Postgres with the Sous migrations |
| Live | `tests/live` | only with `--live`; never in CI | internet access |

```sh
cd apps/api
.venv/bin/pytest                 # unit (integration and live are skipped)
.venv/bin/pytest --cov           # with coverage; CI fails under 90%
.venv/bin/pytest --live          # also hit real recipe sites (one request each)
```

## Integration tests

They import a synthetic recipe page all the way through `extract_recipe()` and the `import_recipe()` database function, so the Python payload and the SQL can't drift apart. **Every test runs in a transaction that is rolled back**, so nothing is kept.

- **CI** starts a fresh `postgres:17` container. `SOUS_TEST_DB_FRESH=1` applies `supabase/tests/supabase_stub.sql`, every migration, and `supabase/tests/grants.sql` before the tests.
- **Locally**, point `SOUS_TEST_DATABASE_URL` at a migrated database. The Supabase project works through its IPv4 session pooler: `postgresql://postgres.<project-id>:<db-password>@aws-1-ca-central-1.pooler.supabase.com:5432/postgres` (URL-encode the password), and so does a local Postgres if you set `SOUS_TEST_DB_FRESH=1` against an empty database.

## Writing tests

- Shared synthetic pages live in `tests/helpers.py`. **Don't commit real blog pages** as fixtures: write small synthetic HTML instead (`docs/policies/recipe-sources.md`).
- Integration fixtures (`tests/integration/conftest.py`): `db` (rolled-back connection), `make_user()` (a throwaway auth user), `as_user(id)` (run queries as that signed-in user, or `None` for anon, so row-level security applies).
- Markers are added by folder, so you don't need to mark tests yourself. `--strict-markers` is on.
- Live tests send real traffic: keep them to one request per site, and check a failing site by hand before changing code.
