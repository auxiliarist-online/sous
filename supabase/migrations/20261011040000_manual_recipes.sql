-- Recipes a user types in by hand (TYL-35). Policy: they're the user's own
-- content, so everything they enter is stored, including instructions, and
-- they stay private to them. No source_url; source_note says where the recipe
-- came from ("Grandma", "Salt Fat Acid Heat, p. 112").

alter table public.recipes
  add column source_note text check (char_length(source_note) <= 300);

-- Create (no recipe_id) or edit (recipe_id) a hand-typed recipe for added_by.
-- p: {added_by, recipe_id?, recipe: {title, summary, servings, prep_minutes,
--     cook_minutes, total_minutes, instructions: [step], source_note},
--     cuisines: [slug], ingredients: [parsed rows, see set_recipe_ingredients()]}
-- Returns {recipe_id, created}.
create function public.save_manual_recipe(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_user uuid := (p ->> 'added_by')::uuid;
  v_id uuid := (p ->> 'recipe_id')::uuid;
  v_title text := nullif(trim(p -> 'recipe' ->> 'title'), '');
  v_created boolean := v_id is null;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'save_manual_recipe is only callable by the API' using errcode = '42501';
  end if;
  if v_user is null or v_title is null then
    raise exception 'added_by and title are required' using errcode = '22023';
  end if;

  if v_created then
    insert into public.recipes (
      title, summary, servings, prep_minutes, cook_minutes, total_minutes, instructions,
      source_note, visibility, status, added_by
    )
    values (
      v_title,
      nullif(p -> 'recipe' ->> 'summary', ''),
      (p -> 'recipe' ->> 'servings')::numeric,
      (p -> 'recipe' ->> 'prep_minutes')::integer,
      (p -> 'recipe' ->> 'cook_minutes')::integer,
      (p -> 'recipe' ->> 'total_minutes')::integer,
      p -> 'recipe' -> 'instructions',
      nullif(p -> 'recipe' ->> 'source_note', ''),
      'private', 'active', v_user
    )
    returning id into v_id;
  else
    -- Only the author's own hand-typed recipes can be edited this way.
    update public.recipes set
      title = v_title,
      summary = nullif(p -> 'recipe' ->> 'summary', ''),
      servings = (p -> 'recipe' ->> 'servings')::numeric,
      prep_minutes = (p -> 'recipe' ->> 'prep_minutes')::integer,
      cook_minutes = (p -> 'recipe' ->> 'cook_minutes')::integer,
      total_minutes = (p -> 'recipe' ->> 'total_minutes')::integer,
      instructions = p -> 'recipe' -> 'instructions',
      source_note = nullif(p -> 'recipe' ->> 'source_note', '')
    where id = v_id and added_by = v_user and source_url is null;
    if not found then
      raise exception 'no such recipe of yours to edit' using errcode = '42501';
    end if;
  end if;

  perform public.set_recipe_ingredients(v_id, coalesce(p -> 'ingredients', '[]'));

  delete from public.recipe_cuisines where recipe_id = v_id;
  insert into public.recipe_cuisines (recipe_id, cuisine_slug)
  select distinct v_id, c.slug
  from jsonb_array_elements_text(coalesce(p -> 'cuisines', '[]')) as s(slug)
  join public.cuisines c on c.slug = s.slug;

  insert into public.user_saved_recipes (user_id, recipe_id)
  values (v_user, v_id) on conflict do nothing;

  return jsonb_build_object('recipe_id', v_id, 'created', v_created);
end
$$;

revoke execute on function public.save_manual_recipe(jsonb) from public, anon, authenticated;
grant execute on function public.save_manual_recipe(jsonb) to service_role;
