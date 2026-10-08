-- Bulk crawler (TYL-26). Policy: docs/policies/recipe-sources.md
--
-- The API's batch job reads each approved source's sitemap, queues new and
-- changed URLs in crawl_pages, fetches them politely, and saves recipes through
-- import_recipe() with refresh on. crawl_runs keeps a log per site. Both tables
-- are internal: RLS is on with no policies, so only the service role sees them.

alter table public.recipe_sources
  -- Where to start; if null the crawler uses the Sitemap lines in robots.txt.
  add column sitemap_url text,
  -- The per-site check the policy requires before crawl_enabled is set:
  -- robots.txt allows SousBot, the terms allow it, content_rights is right.
  add column crawl_notes text;

create table public.crawl_pages (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.recipe_sources on delete cascade,
  url text not null unique,
  -- From the sitemap; fetched_lastmod is what it was when we last fetched.
  lastmod timestamptz,
  fetched_lastmod timestamptz,
  -- pending: due for a fetch. blocked and robots_disallowed are never retried
  -- automatically; the other outcomes are retried when the sitemap's lastmod changes.
  status text not null default 'pending'
    check (status in ('pending', 'imported', 'not_recipe', 'not_found', 'blocked', 'robots_disallowed', 'error')),
  error_code text,
  -- Consecutive failed attempts; errors are retried on later runs up to 3 times.
  attempts smallint not null default 0,
  recipe_id uuid references public.recipes on delete set null,
  first_seen_at timestamptz not null default now(),
  last_fetched_at timestamptz
);

create index crawl_pages_due_idx on public.crawl_pages (source_id, status);

create table public.crawl_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.recipe_sources on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- stopped: the site blocked us or kept failing; we try again on a later day.
  status text not null default 'running' check (status in ('running', 'done', 'stopped', 'failed')),
  stop_reason text,
  urls_queued integer not null default 0,
  pages_fetched integer not null default 0,
  recipes_created integer not null default 0,
  recipes_updated integer not null default 0,
  pages_failed integer not null default 0
);

create index crawl_runs_source_idx on public.crawl_runs (source_id, started_at desc);

alter table public.crawl_pages enable row level security;
alter table public.crawl_runs enable row level security;

-- True if a fetched page should be fetched again because the sitemap says it changed.
create function public.crawl_page_changed(c public.crawl_pages, new_lastmod timestamptz)
returns boolean language sql immutable as $$
  select c.status not in ('pending', 'blocked', 'robots_disallowed')
    and new_lastmod > coalesce(c.fetched_lastmod, '-infinity')
$$;

-- Add a sitemap's entries to the queue. A new URL is due; a known one is due
-- again when its lastmod moves forward, unless we were blocked or disallowed.
-- p_entries: [{url, lastmod}] (lastmod may be null). Returns how many are due.
create function public.crawl_enqueue(p_source uuid, p_entries jsonb) returns integer
language plpgsql as $$
declare
  v_due integer;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'crawl_enqueue is only callable by the API' using errcode = '42501';
  end if;

  insert into public.crawl_pages as c (source_id, url, lastmod)
  select distinct on (e.url) p_source, e.url, e.lastmod
  from jsonb_to_recordset(coalesce(p_entries, '[]')) as e(url text, lastmod timestamptz)
  where coalesce(e.url, '') <> ''
  order by e.url, e.lastmod desc nulls last
  on conflict (url) do update set
    lastmod = excluded.lastmod,
    status = case when public.crawl_page_changed(c, excluded.lastmod) then 'pending' else c.status end,
    attempts = case when public.crawl_page_changed(c, excluded.lastmod) then 0 else c.attempts end
  where c.source_id = p_source;

  select count(*) into v_due from public.crawl_pages
  where source_id = p_source
    and (status = 'pending' or (status = 'error' and attempts < 3));
  return v_due;
end
$$;

-- A site opted out (by email, or by disallowing SousBot in robots.txt): stop
-- crawling it and take its recipes out of the public catalog. Users' private
-- copies and saved plans keep working. Returns how many recipes were hidden.
create function public.opt_out_source(p_source uuid) returns integer
language plpgsql as $$
declare
  v_hidden integer;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'opt_out_source is only callable by the API' using errcode = '42501';
  end if;

  update public.recipe_sources
  set opted_out_at = coalesce(opted_out_at, now()), crawl_enabled = false
  where id = p_source;

  update public.recipes set status = 'hidden'
  where source_id = p_source and visibility = 'public' and status in ('active', 'needs_review');
  get diagnostics v_hidden = row_count;
  return v_hidden;
end
$$;

-- import_recipe() gains `refresh`: when the crawler sees a changed page it
-- updates the stored recipe (same content-rights rules) instead of skipping it,
-- and sends it back to review since its ingredients may have changed.
-- p: as before, plus refresh: boolean (default false).
-- Returns {recipe_id, created, updated, visibility, status}.
create or replace function public.import_recipe(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_user uuid := (p ->> 'added_by')::uuid;
  v_domain text := lower(regexp_replace(p -> 'source' ->> 'domain', '^www\.', ''));
  v_url text := p -> 'recipe' ->> 'source_url';
  v_refresh boolean := coalesce((p ->> 'refresh')::boolean, false);
  v_source public.recipe_sources;
  v_recipe public.recipes;
  v_public boolean;
  v_full_text boolean;
  v_created boolean := false;
  v_updated boolean := false;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'import_recipe is only callable by the API' using errcode = '42501';
  end if;
  if v_domain is null or v_url is null or coalesce(p -> 'recipe' ->> 'title', '') = '' then
    raise exception 'domain, source_url and title are required' using errcode = '22023';
  end if;

  insert into public.recipe_sources (name, domain, homepage_url)
  values (
    coalesce(nullif(p -> 'source' ->> 'name', ''), v_domain),
    v_domain,
    p -> 'source' ->> 'homepage_url'
  )
  on conflict (domain) do nothing;
  select * into v_source from public.recipe_sources where domain = v_domain;

  -- Approved sources join the public catalog (after review); anything else stays
  -- private to the importer until its source is reviewed.
  v_public := v_source.crawl_enabled and v_source.opted_out_at is null;
  v_full_text := v_source.content_rights in ('public_domain', 'licensed');

  insert into public.recipes (
    source_id, source_url, title, summary, image_url, servings,
    prep_minutes, cook_minutes, total_minutes, instructions,
    visibility, status, added_by
  )
  values (
    v_source.id,
    v_url,
    p -> 'recipe' ->> 'title',
    case when v_full_text then p -> 'recipe' ->> 'summary' end,
    case when v_source.opted_out_at is null then p -> 'recipe' ->> 'image_url' end,
    (p -> 'recipe' ->> 'servings')::numeric,
    (p -> 'recipe' ->> 'prep_minutes')::integer,
    (p -> 'recipe' ->> 'cook_minutes')::integer,
    (p -> 'recipe' ->> 'total_minutes')::integer,
    case when v_full_text then p -> 'recipe' -> 'instructions' end,
    case when v_public then 'public' else 'private' end,
    'needs_review',
    v_user
  )
  on conflict (source_url) do nothing
  returning * into v_recipe;
  v_created := v_recipe.id is not null;

  if not v_created then
    -- Already imported (by anyone): reuse it, and update it if the crawler asked.
    select * into v_recipe from public.recipes where source_url = v_url;
    if v_refresh and v_recipe.source_id = v_source.id and v_recipe.status in ('active', 'needs_review') then
      update public.recipes set
        title = p -> 'recipe' ->> 'title',
        summary = case when v_full_text then p -> 'recipe' ->> 'summary' end,
        image_url = case when v_source.opted_out_at is null then p -> 'recipe' ->> 'image_url' end,
        servings = (p -> 'recipe' ->> 'servings')::numeric,
        prep_minutes = (p -> 'recipe' ->> 'prep_minutes')::integer,
        cook_minutes = (p -> 'recipe' ->> 'cook_minutes')::integer,
        total_minutes = (p -> 'recipe' ->> 'total_minutes')::integer,
        instructions = case when v_full_text then p -> 'recipe' -> 'instructions' end,
        visibility = case when v_public then 'public' else visibility end,
        status = 'needs_review'
      where id = v_recipe.id
      returning * into v_recipe;
      delete from public.recipe_ingredients where recipe_id = v_recipe.id;
      delete from public.recipe_cuisines where recipe_id = v_recipe.id;
      delete from public.recipe_diets where recipe_id = v_recipe.id and source = 'derived';
      v_updated := true;
    end if;
  end if;

  if v_created or v_updated then
    insert into public.recipe_ingredients (recipe_id, line_no, raw_text, section)
    select v_recipe.id, i.line_no, i.raw_text, nullif(i.section, '')
    from jsonb_to_recordset(coalesce(p -> 'ingredients', '[]')) as i(line_no smallint, raw_text text, section text)
    where coalesce(i.raw_text, '') <> '';

    insert into public.recipe_cuisines (recipe_id, cuisine_slug)
    select distinct v_recipe.id, c.slug
    from jsonb_array_elements_text(coalesce(p -> 'cuisines', '[]')) as s(slug)
    join public.cuisines c on c.slug = s.slug;
  end if;

  if v_user is not null then
    insert into public.user_saved_recipes (user_id, recipe_id)
    values (v_user, v_recipe.id) on conflict do nothing;
  end if;

  return jsonb_build_object(
    'recipe_id', v_recipe.id, 'created', v_created, 'updated', v_updated,
    'visibility', v_recipe.visibility, 'status', v_recipe.status
  );
end
$$;

revoke execute on function public.crawl_enqueue(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.opt_out_source(uuid) from public, anon, authenticated;
grant execute on function public.crawl_enqueue(uuid, jsonb) to service_role;
grant execute on function public.opt_out_source(uuid) to service_role;
