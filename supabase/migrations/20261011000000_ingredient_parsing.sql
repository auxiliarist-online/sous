-- Ingredient parsing (TYL-9). The API parses each line (app/recipes/ingredients.py)
-- into amount, unit, name and notes, and sends candidate names; the database
-- picks the first that names a canonical ingredient or an alias. Lines that
-- don't match keep their parsed name and are flagged for review.

-- The parsed ingredient name ("fresh cilantro"), kept even when it doesn't
-- match a canonical ingredient yet.
alter table public.recipe_ingredients add column name text;

-- The first candidate that is a canonical ingredient name or an alias.
create function public.match_ingredient(p_candidates text[]) returns uuid
language sql stable as $$
  select coalesce(i.id, a.ingredient_id)
  from unnest(p_candidates) with ordinality as c(name, n)
  left join public.ingredients i on lower(i.name) = lower(c.name)
  left join public.ingredient_aliases a on a.alias = lower(c.name)
  where i.id is not null or a.ingredient_id is not null
  order by c.n
  limit 1
$$;

-- Replace a recipe's ingredient lines with parsed ones. Used by import_recipe()
-- and to re-parse stored recipes when the parser or aliases improve.
-- p_rows: [{line_no, option_no, raw_text, section, name, candidates, quantity,
--          quantity_max, unit, preparation, note, is_optional, parse_confidence,
--          needs_review}]; only line_no and raw_text are required.
create function public.set_recipe_ingredients(p_recipe uuid, p_rows jsonb) returns integer
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
  return v_count;
end
$$;

revoke execute on function public.set_recipe_ingredients(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_recipe_ingredients(uuid, jsonb) to service_role;

-- Common names for the canonical ingredients (lowercase; see the alias check).
insert into public.ingredient_aliases (alias, ingredient_id)
select v.alias, i.id
from (values
  ('green onions', 'scallions'),
  ('green onion', 'scallions'),
  ('spring onions', 'scallions'),
  ('spring onion', 'scallions'),
  ('yellow onion', 'onion'),
  ('white onion', 'onion'),
  ('red onion', 'onion'),
  ('sweet onion', 'onion'),
  ('onions', 'onion'),
  ('garlic cloves', 'garlic'),
  ('garlic clove', 'garlic'),
  ('cloves garlic', 'garlic'),
  ('clove garlic', 'garlic'),
  ('sea salt', 'salt'),
  ('table salt', 'salt'),
  ('kosher salt', 'salt'),
  ('fine sea salt', 'salt'),
  ('pepper', 'black pepper'),
  ('ground black pepper', 'black pepper'),
  ('black peppercorns', 'black pepper'),
  ('cracked black pepper', 'black pepper'),
  ('extra virgin olive oil', 'olive oil'),
  ('extra-virgin olive oil', 'olive oil'),
  ('evoo', 'olive oil'),
  ('canola oil', 'vegetable oil'),
  ('neutral oil', 'vegetable oil'),
  ('sunflower oil', 'vegetable oil'),
  ('granulated sugar', 'sugar'),
  ('white sugar', 'sugar'),
  ('cane sugar', 'sugar'),
  ('flour', 'all-purpose flour'),
  ('plain flour', 'all-purpose flour'),
  ('ap flour', 'all-purpose flour'),
  ('spaghetti', 'pasta'),
  ('penne', 'pasta'),
  ('rigatoni', 'pasta'),
  ('fusilli', 'pasta'),
  ('linguine', 'pasta'),
  ('fettuccine', 'pasta'),
  ('macaroni', 'pasta'),
  ('farfalle', 'pasta'),
  ('rotini', 'pasta'),
  ('orzo', 'pasta'),
  ('rice', 'white rice'),
  ('long-grain white rice', 'white rice'),
  ('long grain white rice', 'white rice'),
  ('basmati rice', 'white rice'),
  ('jasmine rice', 'white rice'),
  ('oats', 'rolled oats'),
  ('old-fashioned oats', 'rolled oats'),
  ('old fashioned oats', 'rolled oats'),
  ('vegetable stock', 'vegetable broth'),
  ('chickpeas', 'canned chickpeas'),
  ('garbanzo beans', 'canned chickpeas'),
  ('black beans', 'canned black beans'),
  ('kidney beans', 'canned kidney beans'),
  ('red kidney beans', 'canned kidney beans'),
  ('pinto beans', 'canned pinto beans'),
  ('white beans', 'canned white beans'),
  ('cannellini beans', 'canned white beans'),
  ('great northern beans', 'canned white beans'),
  ('navy beans', 'canned white beans'),
  ('diced tomatoes', 'canned tomatoes'),
  ('crushed tomatoes', 'canned tomatoes'),
  ('whole peeled tomatoes', 'canned tomatoes'),
  ('canned diced tomatoes', 'canned tomatoes'),
  ('canned crushed tomatoes', 'canned tomatoes'),
  ('fire-roasted tomatoes', 'canned tomatoes'),
  ('pumpkin puree', 'canned pumpkin'),
  ('pumpkin purée', 'canned pumpkin'),
  ('coriander leaves', 'cilantro'),
  ('fresh coriander', 'cilantro'),
  ('cilantro leaves', 'cilantro'),
  ('ginger root', 'ginger'),
  ('fresh ginger', 'ginger'),
  ('jalapeno pepper', 'jalapeno'),
  ('jalapeno peppers', 'jalapeno'),
  ('red pepper', 'red bell pepper'),
  ('red peppers', 'red bell pepper'),
  ('green pepper', 'green bell pepper'),
  ('green peppers', 'green bell pepper'),
  ('bell pepper', 'green bell pepper'),
  ('bell peppers', 'green bell pepper'),
  ('parmesan cheese', 'parmesan'),
  ('parmigiano reggiano', 'parmesan'),
  ('parmigiano-reggiano', 'parmesan'),
  ('cheddar', 'cheddar cheese'),
  ('sharp cheddar', 'cheddar cheese'),
  ('sharp cheddar cheese', 'cheddar cheese'),
  ('feta cheese', 'feta'),
  ('yogurt', 'plain yogurt'),
  ('greek yogurt', 'plain yogurt'),
  ('plain greek yogurt', 'plain yogurt'),
  ('milk', 'whole milk'),
  ('unsalted butter', 'butter'),
  ('salted butter', 'butter'),
  ('tofu', 'firm tofu'),
  ('extra-firm tofu', 'firm tofu'),
  ('extra firm tofu', 'firm tofu'),
  ('russet potatoes', 'potatoes'),
  ('yukon gold potatoes', 'potatoes'),
  ('red potatoes', 'potatoes'),
  ('baby potatoes', 'potatoes'),
  ('cremini mushrooms', 'mushrooms'),
  ('button mushrooms', 'mushrooms'),
  ('white mushrooms', 'mushrooms'),
  ('baby bella mushrooms', 'mushrooms'),
  ('chicken breast', 'boneless chicken breast'),
  ('chicken breasts', 'boneless chicken breast'),
  ('boneless skinless chicken breasts', 'boneless chicken breast'),
  ('boneless skinless chicken breast', 'boneless chicken breast'),
  ('tamari', 'soy sauce'),
  ('low-sodium soy sauce', 'soy sauce'),
  ('low sodium soy sauce', 'soy sauce'),
  ('shoyu', 'soy sauce'),
  ('red lentils', 'lentils'),
  ('green lentils', 'lentils'),
  ('brown lentils', 'lentils'),
  ('french lentils', 'lentils'),
  ('cumin', 'ground cumin'),
  ('baby spinach', 'spinach'),
  ('lacinato kale', 'kale'),
  ('curly kale', 'kale'),
  ('tuscan kale', 'kale'),
  ('cabbage', 'green cabbage'),
  ('grape tomatoes', 'cherry tomatoes'),
  ('plum tomatoes', 'roma tomatoes'),
  ('tomato', 'tomatoes'),
  ('string beans', 'green beans'),
  ('kalamata olives', 'olives'),
  ('black olives', 'olives'),
  ('green olives', 'olives'),
  ('lean ground beef', 'ground beef'),
  ('stew beef', 'beef stew meat'),
  ('beef chuck', 'beef stew meat'),
  ('pork chops', 'boneless pork chops'),
  ('romaine', 'romaine lettuce'),
  ('lemon', 'lemons'),
  ('limes', 'lime'),
  ('avocados', 'avocado'),
  ('creamy peanut butter', 'peanut butter'),
  ('natural peanut butter', 'peanut butter'),
  ('full-fat coconut milk', 'coconut milk'),
  ('light coconut milk', 'coconut milk'),
  ('canned coconut milk', 'coconut milk'),
  ('peas', 'frozen peas')
) as v(alias, canonical)
join public.ingredients i on lower(i.name) = v.canonical
on conflict (alias) do nothing;

-- import_recipe() now stores parsed ingredient lines through set_recipe_ingredients().
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
