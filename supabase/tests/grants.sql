-- What Supabase grants on its own, applied after the migrations in tests. Since
-- October 30, 2026 that's no longer table access (TYL-117): tables are reachable
-- only through the grants in the migrations, as in production.
grant usage on schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;
