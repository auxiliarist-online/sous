-- TYL-117. From October 30, 2026, Supabase no longer grants the Data API
-- (supabase-js, PostgREST) access to new tables in public: each migration that
-- creates a table must grant it. This grants every table created so far, so a
-- database rebuilt from these migrations (a new project, a preview branch, a
-- reset) exposes the same tables production does. In production these are
-- already granted, so nothing changes there. Row-level security still decides
-- which rows each role sees.
--
-- A new table, from here on, grants in its own migration:
--   grant select on public.t to anon;
--   grant select, insert, update, delete on public.t to authenticated, service_role;
do $$
declare
  t text;
begin
  for t in
    select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  loop
    execute format('grant select on public.%I to anon', t);
    execute format(
      'grant select, insert, update, delete on public.%I to authenticated, service_role', t
    );
  end loop;
end
$$;
