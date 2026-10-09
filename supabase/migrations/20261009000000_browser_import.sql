-- Import from the user's own browser (TYL-35). Policy: docs/policies/recipe-sources.md
--
-- For sites that block Sous's server, the user's browser sends the page's
-- recipe data instead. That data is only trusted for the person who sent it:
-- it becomes a private copy for them, never the shared recipe for its URL,
-- and it never names a source, so made-up data can't reach other users or
-- the public catalog.

alter table public.recipes
  -- fetched: Sous read the page itself (or a user typed the recipe; then source_url is null).
  -- browser: sent from a user's browser; a private copy for added_by only.
  add column origin text not null default 'fetched' check (origin in ('fetched', 'browser')),
  add constraint recipes_browser_private check (
    origin = 'fetched' or (visibility = 'private' and added_by is not null)
  );

-- One shared recipe per URL from fetched pages; one private copy per user
-- per URL from browsers.
alter table public.recipes drop constraint recipes_source_url_key;
create unique index recipes_fetched_url_key on public.recipes (source_url) where origin = 'fetched';
create unique index recipes_browser_url_key on public.recipes (source_url, added_by) where origin = 'browser';

-- p: as before, plus origin: 'fetched' (default) or 'browser'. A browser
-- import needs added_by; it reuses a recipe Sous fetched itself if there is
-- one, and otherwise creates or updates that user's private copy.
-- Returns {recipe_id, created, updated, visibility, status}.
create or replace function public.import_recipe(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_user uuid := (p ->> 'added_by')::uuid;
  v_domain text := lower(regexp_replace(p -> 'source' ->> 'domain', '^www\.', ''));
  v_url text := p -> 'recipe' ->> 'source_url';
  v_refresh boolean := coalesce((p ->> 'refresh')::boolean, false);
  v_browser boolean := coalesce(p ->> 'origin', 'fetched') = 'browser';
  v_source public.recipe_sources;
  v_recipe public.recipes;
  v_public boolean;
  v_full_text boolean;
  v_created boolean := false;
  v_rewrite boolean := false;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'import_recipe is only callable by the API' using errcode = '42501';
  end if;
  if v_domain is null or v_url is null or coalesce(p -> 'recipe' ->> 'title', '') = '' then
    raise exception 'domain, source_url and title are required' using errcode = '22023';
  end if;
  if coalesce(p ->> 'origin', 'fetched') not in ('fetched', 'browser') then
    raise exception 'origin must be fetched or browser' using errcode = '22023';
  end if;
  if v_browser and v_user is null then
    raise exception 'a browser import needs added_by' using errcode = '22023';
  end if;

  -- The first import from a site creates its source record, which everyone
  -- sees. Browser data mustn't name it: a new source from a browser import
  -- is named after its domain until Sous fetches a page from it.
  insert into public.recipe_sources (name, domain, homepage_url)
  values (
    case when v_browser then v_domain
         else coalesce(nullif(p -> 'source' ->> 'name', ''), v_domain) end,
    v_domain,
    'https://' || v_domain || '/'
  )
  on conflict (domain) do nothing;
  select * into v_source from public.recipe_sources where domain = v_domain;

  -- Approved sources join the public catalog (after review); anything else stays
  -- private to the importer until its source is reviewed. Browser data never does.
  v_public := v_source.crawl_enabled and v_source.opted_out_at is null and not v_browser;
  v_full_text := v_source.content_rights in ('public_domain', 'licensed');

  if v_browser then
    -- A copy Sous fetched itself is trusted: save that one for the user.
    select * into v_recipe from public.recipes where source_url = v_url and origin = 'fetched';
  end if;

  if v_recipe.id is null then
    insert into public.recipes (
      source_id, source_url, title, summary, image_url, servings,
      prep_minutes, cook_minutes, total_minutes, instructions,
      visibility, status, added_by, origin
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
      v_user,
      case when v_browser then 'browser' else 'fetched' end
    )
    on conflict do nothing
    returning * into v_recipe;
    v_created := v_recipe.id is not null;

    if not v_created then
      if v_browser then
        -- The user is importing this page again from their browser: update their copy.
        select * into v_recipe from public.recipes
        where source_url = v_url and origin = 'browser' and added_by = v_user;
        v_rewrite := true;
      else
        -- Already fetched (by anyone): reuse it, and update it if the crawler asked.
        select * into v_recipe from public.recipes where source_url = v_url and origin = 'fetched';
        v_rewrite := v_refresh and v_recipe.source_id = v_source.id;
      end if;
      v_rewrite := v_rewrite and v_recipe.status in ('active', 'needs_review');
    end if;
  end if;

  if v_rewrite then
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
  end if;

  if v_created or v_rewrite then
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
    'recipe_id', v_recipe.id, 'created', v_created, 'updated', v_rewrite,
    'visibility', v_recipe.visibility, 'status', v_recipe.status
  );
end
$$;
