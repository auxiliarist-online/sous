-- Diet labels on recipes (TYL-10). Labels are derived from the parsed,
-- matched ingredients with recipe_meets_diet(): a recipe earns a diet only
-- when every required line clearly fits it. "Check the label" and "can't
-- tell" (unmatched ingredients) earn nothing. The source's own tags are kept
-- as source = 'publisher' hints and never shown as labels.

-- Recompute a recipe's derived labels. Called whenever its ingredients change.
create function public.refresh_recipe_diets(p_recipe uuid) returns integer
language plpgsql as $$
declare
  v_count integer;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'refresh_recipe_diets is only callable by the API' using errcode = '42501';
  end if;
  delete from public.recipe_diets where recipe_id = p_recipe and source = 'derived';
  -- A recipe with no required ingredient lines proves nothing, so it gets no labels.
  if not exists (
    select 1 from public.recipe_ingredients
    where recipe_id = p_recipe and not is_optional and name is not null
  ) then
    return 0;
  end if;
  insert into public.recipe_diets (recipe_id, diet_slug, source)
  select p_recipe, d.slug, 'derived'
  from public.diets d
  where public.recipe_meets_diet(p_recipe, d.slug)
  on conflict (recipe_id, diet_slug) do update set source = 'derived'
    where recipe_diets.source = 'publisher';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke execute on function public.refresh_recipe_diets(uuid) from public, anon, authenticated;
grant execute on function public.refresh_recipe_diets(uuid) to service_role;

-- set_recipe_ingredients() now refreshes the labels after storing the lines.
create or replace function public.set_recipe_ingredients(p_recipe uuid, p_rows jsonb) returns integer
language plpgsql as $$
declare
  v_count integer;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'set_recipe_ingredients is only callable by the API' using errcode = '42501';
  end if;
  delete from public.recipe_ingredients where recipe_id = p_recipe;
  insert into public.recipe_ingredients (
    recipe_id, line_no, option_no, raw_text, section, name, ingredient_id, quantity,
    quantity_max, unit, preparation, note, is_optional, parse_confidence, needs_review
  )
  select
    p_recipe, r.line_no, coalesce(r.option_no, 1), r.raw_text, nullif(r.section, ''), r.name, m.id,
    r.quantity, r.quantity_max, r.unit, r.preparation, r.note, coalesce(r.is_optional, false),
    r.parse_confidence,
    -- a named ingredient we can't match needs a person (or a new alias)
    coalesce(r.needs_review, false) or (r.name is not null and m.id is null)
  from jsonb_to_recordset(p_rows) as r(
    line_no smallint, option_no smallint, raw_text text, section text, name text, candidates text[],
    quantity numeric, quantity_max numeric, unit text, preparation text, note text,
    is_optional boolean, parse_confidence real, needs_review boolean
  )
  left join lateral (select public.match_ingredient(r.candidates) as id) m on true
  where coalesce(r.raw_text, '') <> '';
  get diagnostics v_count = row_count;
  perform public.refresh_recipe_diets(p_recipe);
  return v_count;
end
$$;

-- import_recipe() also keeps the publisher's diet tags (p.publisher_diets: [slug]) as hints.
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
    delete from public.recipe_cuisines where recipe_id = v_recipe.id;
    delete from public.recipe_diets where recipe_id = v_recipe.id and source = 'derived';
  end if;

  if v_created or v_rewrite then
    perform public.set_recipe_ingredients(v_recipe.id, coalesce(p -> 'ingredients', '[]'));

    insert into public.recipe_cuisines (recipe_id, cuisine_slug)
    select distinct v_recipe.id, c.slug
    from jsonb_array_elements_text(coalesce(p -> 'cuisines', '[]')) as s(slug)
    join public.cuisines c on c.slug = s.slug;
  end if;

  -- The source's own diet tags (schema.org suitableForDiet), kept only as a hint:
  -- a label we derived from the ingredients always wins, and the app shows only
  -- derived or reviewed labels.
  if v_created or v_rewrite then
    delete from public.recipe_diets where recipe_id = v_recipe.id and source = 'publisher';
    insert into public.recipe_diets (recipe_id, diet_slug, source)
    select v_recipe.id, d.slug, 'publisher'
    from jsonb_array_elements_text(coalesce(p -> 'publisher_diets', '[]')) as s(slug)
    join public.diets d on d.slug = s.slug
    on conflict (recipe_id, diet_slug) do nothing;
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

-- Label the recipes stored so far.
select public.refresh_recipe_diets(id) from public.recipes;
