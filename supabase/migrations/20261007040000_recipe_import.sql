-- Import a recipe from a URL (TYL-8). Policy: docs/policies/recipe-sources.md
--
-- The API extracts the recipe and calls import_recipe() with the service role.
-- Everything happens in one transaction: find or create the source, dedupe on
-- the canonical URL, apply the source's content rights, and save the recipe
-- for the user who imported it.

-- A user can read a web recipe they saved, even if someone else imported it
-- privately first. Hand-typed recipes (no source_url) stay private to their author.
create policy "Read saved web recipes" on public.recipes for select to authenticated
  using (
    source_url is not null
    and exists (
      select 1 from public.user_saved_recipes s
      where s.recipe_id = recipes.id and s.user_id = (select auth.uid())
    )
  );

-- p: {
--   added_by: uuid,
--   source: {domain, name, homepage_url},
--   recipe: {source_url, title, image_url, servings, prep_minutes, cook_minutes,
--            total_minutes, summary, instructions},
--   cuisines: [slug],            -- unknown slugs are ignored
--   ingredients: [{line_no, raw_text, section}]
-- }
-- Returns {recipe_id, created, visibility, status}.
create function public.import_recipe(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_user uuid := (p ->> 'added_by')::uuid;
  v_domain text := lower(regexp_replace(p -> 'source' ->> 'domain', '^www\.', ''));
  v_url text := p -> 'recipe' ->> 'source_url';
  v_source public.recipe_sources;
  v_recipe public.recipes;
  v_public boolean;
  v_full_text boolean;
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

  if v_recipe.id is null then
    -- Already imported (by anyone): reuse it and save it for this user.
    select * into v_recipe from public.recipes where source_url = v_url;
    if v_user is not null then
      insert into public.user_saved_recipes (user_id, recipe_id)
      values (v_user, v_recipe.id) on conflict do nothing;
    end if;
    return jsonb_build_object(
      'recipe_id', v_recipe.id, 'created', false,
      'visibility', v_recipe.visibility, 'status', v_recipe.status
    );
  end if;

  insert into public.recipe_ingredients (recipe_id, line_no, raw_text, section)
  select v_recipe.id, i.line_no, i.raw_text, nullif(i.section, '')
  from jsonb_to_recordset(coalesce(p -> 'ingredients', '[]')) as i(line_no smallint, raw_text text, section text)
  where coalesce(i.raw_text, '') <> '';

  insert into public.recipe_cuisines (recipe_id, cuisine_slug)
  select distinct v_recipe.id, c.slug
  from jsonb_array_elements_text(coalesce(p -> 'cuisines', '[]')) as s(slug)
  join public.cuisines c on c.slug = s.slug;

  if v_user is not null then
    insert into public.user_saved_recipes (user_id, recipe_id)
    values (v_user, v_recipe.id) on conflict do nothing;
  end if;

  return jsonb_build_object(
    'recipe_id', v_recipe.id, 'created', true,
    'visibility', v_recipe.visibility, 'status', v_recipe.status
  );
end
$$;

revoke execute on function public.import_recipe(jsonb) from public, anon, authenticated;
grant execute on function public.import_recipe(jsonb) to service_role;
