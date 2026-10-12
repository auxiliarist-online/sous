-- Find: search the shared catalog by what the user means, ranked for them.
--
-- The query is read for ingredients ("eggs", "red lentils"), cuisines
-- ("thai"), diets ("vegetarian") and time ("quick", "under 30"); leftover
-- words search titles and summaries. A recipe matches an ingredient when it
-- uses it, and ranks higher the more of the dish it is by weight (a frittata
-- before a cake with two eggs).
--
-- Ranking follows the signed-in user: recipes that break their diets or
-- allergies are left out, ones Sous can't fully check go last, favorite
-- cuisines and ingredients rise and disliked ingredients sink.

-- Which ingredients, cuisines, diets and time limit a query names.
create function public.read_search_query(p_query text)
returns table (
  ingredient_ids uuid[], cuisine_slugs text[], diet_slugs text[], course_slugs text[],
  max_minutes integer, rest text
)
language plpgsql stable as $$
declare
  v_words text[];
  v_used boolean[];
  v_phrase text;
  v_id uuid;
  v_slug text;
  i integer;
  n integer;
begin
  ingredient_ids := '{}';
  cuisine_slugs := '{}';
  diet_slugs := '{}';
  course_slugs := '{}';
  v_phrase := lower(coalesce(p_query, ''));
  v_phrase := regexp_replace(v_phrase, '[^a-z0-9''\- ]', ' ', 'g');

  -- Time: "under 30", "30 minutes", "quick".
  max_minutes := (regexp_match(v_phrase, '(?:under|less than|within)\s+(\d+)'))[1]::integer;
  if max_minutes is null and v_phrase ~ '\m(quick|fast|speedy|weeknight)\M' then
    max_minutes := 30;
  end if;
  v_phrase := regexp_replace(
    v_phrase, '\m(under|less than|within)\s+\d+(\s*(min|mins|minutes))?\M|\m(quick|fast|speedy|weeknight|easy|recipes?|dish(es)?|meals?|ideas?|with|and|a|an|the|for|of)\M',
    ' ', 'g'
  );
  v_words := array_remove(regexp_split_to_array(trim(v_phrase), '\s+'), '');
  n := coalesce(array_length(v_words, 1), 0);
  v_used := array_fill(false, array[greatest(n, 1)]);

  -- Two-word phrases first ("red lentils", "gluten free"), then single words.
  for size in reverse 2..1 loop
    for i in 1..greatest(n - size + 1, 0) loop
      if size = 2 and (v_used[i] or v_used[i + 1]) then continue; end if;
      if size = 1 and v_used[i] then continue; end if;
      v_phrase := array_to_string(v_words[i:i + size - 1], ' ');

      v_slug := case
        when v_phrase ~ '^(desserts?|sweets?|treats?|baking)$' then 'dessert'
        when v_phrase ~ '^(breakfasts?|brunch)$' then 'breakfast'
        when v_phrase ~ '^(dinners?|mains?|main course|main dish|entrees?|suppers?|lunch(es)?)$' then 'main'
        when v_phrase ~ '^(sides?|side dish(es)?)$' then 'side'
        when v_phrase ~ '^(soups?|stews?)$' then 'soup'
        when v_phrase ~ '^(salads?)$' then 'salad'
        when v_phrase ~ '^(snacks?|appetizers?|starters?)$' then 'snack'
        when v_phrase ~ '^(drinks?|beverages?|cocktails?|smoothies?)$' then 'drink'
        when v_phrase ~ '^(sauces?|dressings?|dips?|condiments?|marinades?)$' then 'sauce'
        when v_phrase ~ '^(breads?)$' then 'bread'
      end;
      if v_slug is not null then
        course_slugs := course_slugs || v_slug;
        v_used[i] := true; if size = 2 then v_used[i + 1] := true; end if;
        continue;
      end if;

      select d.slug into v_slug from public.diets d
      where lower(d.name) = v_phrase or d.slug = replace(replace(v_phrase, '-', '_'), ' ', '_')
      limit 1;
      if v_slug is not null then
        diet_slugs := diet_slugs || v_slug;
        v_used[i] := true; if size = 2 then v_used[i + 1] := true; end if;
        continue;
      end if;

      select c.slug into v_slug from public.cuisines c
      where lower(c.name) = v_phrase or c.slug = replace(v_phrase, ' ', '_')
      limit 1;
      if v_slug is not null then
        cuisine_slugs := cuisine_slugs || v_slug;
        v_used[i] := true; if size = 2 then v_used[i + 1] := true; end if;
        continue;
      end if;

      v_id := public.match_ingredient(array[
        v_phrase,
        regexp_replace(v_phrase, 'ies$', 'y'),
        regexp_replace(v_phrase, 'es$', ''),
        regexp_replace(v_phrase, 's$', ''),
        v_phrase || 's'
      ]);
      if v_id is not null then
        ingredient_ids := ingredient_ids || v_id;
        v_used[i] := true; if size = 2 then v_used[i + 1] := true; end if;
      end if;
    end loop;
  end loop;

  rest := trim(array_to_string(
    array(select v_words[k] from generate_subscripts(v_words, 1) k where not v_used[k]), ' '
  ));
  return next;
end
$$;

create function public.search_recipes(
  p_query text default '', p_limit integer default 30, p_offset integer default 0
)
returns table (
  id uuid, title text, source_name text, total_minutes integer, fit text, score real, why text[]
)
language plpgsql stable as $$
#variable_conflict use_column
declare
  v_user uuid := auth.uid();
  v_q record;
  v_ts tsquery;
  v_rules boolean;
  v_window integer := least(greatest(p_offset + p_limit, 1), 500) * 4;
begin
  select * into v_q from public.read_search_query(p_query);
  v_ts := case when v_q.rest <> '' then plainto_tsquery('english', v_q.rest) end;
  if v_ts is not null and numnode(v_ts) = 0 then
    v_ts := null;  -- only stop words left
  end if;
  -- Does the user rule anything out? If not, "can't fully check" doesn't matter.
  v_rules := exists (select 1 from public.user_diets where user_id = v_user)
    or exists (
      select 1 from public.profiles
      where user_id = v_user and (allergens <> '{}' or avoid_categories <> '{}')
    );

  return query
  with base as (
    select r.id, r.title, r.total_minutes, r.search, r.courses, s.name as source_name
    from public.recipes r
    left join public.recipe_sources s on s.id = r.source_id
    where r.visibility = 'public' and r.status = 'active'
      and (v_q.max_minutes is null or r.total_minutes <= v_q.max_minutes)
      and (v_ts is null or r.search @@ v_ts
           or r.title ilike '%' || v_q.rest || '%')
      -- A course in the query matches that course, or the word in the title
      -- (recipes from sources without categories).
      and (cardinality(v_q.course_slugs) = 0 or r.courses && v_q.course_slugs
           or exists (select 1 from unnest(v_q.course_slugs) c where r.title ilike '%' || c || '%'))
      and (cardinality(v_q.cuisine_slugs) = 0 or exists (
        select 1 from public.recipe_cuisines rc
        where rc.recipe_id = r.id and rc.cuisine_slug = any(v_q.cuisine_slugs)))
      and (cardinality(v_q.diet_slugs) = 0 or (
        select count(distinct rd.diet_slug) from public.recipe_diets rd
        where rd.recipe_id = r.id and rd.diet_slug = any(v_q.diet_slugs)
          and rd.source <> 'publisher'
      ) = cardinality(v_q.diet_slugs))
      and (cardinality(v_q.ingredient_ids) = 0 or (
        select count(distinct ri.ingredient_id) from public.recipe_ingredients ri
        where ri.recipe_id = r.id and ri.ingredient_id = any(v_q.ingredient_ids)
      ) = cardinality(v_q.ingredient_ids))
  ),
  scored as (
    select b.*,
      -- How much of the dish the searched ingredients are, by weight. A line
      -- whose weight isn't known counts as an average-sized line, so one
      -- unknown line doesn't make the searched ingredient look like it all.
      coalesce((
        select sum(ri.grams) filter (where ri.ingredient_id = any(v_q.ingredient_ids))
               / nullif(sum(ri.grams) + count(*) filter (where ri.grams is null) * avg(ri.grams), 0)
        from public.recipe_ingredients ri
        where ri.recipe_id = b.id and ri.option_no = 1 and not ri.is_optional
      ), 0)::real as share,
      (cardinality(v_q.ingredient_ids) > 0 and exists (
        select 1 from public.ingredients i
        where i.id = any(v_q.ingredient_ids)
          and b.title ilike '%' || regexp_replace(i.name, 's$', '') || '%'
      )) as named_in_title,
      case when v_ts is not null then ts_rank(b.search, v_ts) else 0 end::real as text_rank,
      exists (
        select 1 from public.recipe_cuisines rc
        join public.user_favorite_cuisines f
          on f.cuisine_slug = rc.cuisine_slug and f.user_id = v_user
        where rc.recipe_id = b.id
      ) as favorite_cuisine,
      (select count(distinct ri.ingredient_id) from public.recipe_ingredients ri
       join public.user_favorite_ingredients f
         on f.ingredient_id = ri.ingredient_id and f.user_id = v_user
       where ri.recipe_id = b.id) as favorites,
      (select count(distinct ri.ingredient_id) from public.recipe_ingredients ri
       join public.user_disliked_ingredients d
         on d.ingredient_id = ri.ingredient_id and d.user_id = v_user
       where ri.recipe_id = b.id) as dislikes
    from base b
  ),
  ranked as (
    select s.*,
      ( case when cardinality(v_q.ingredient_ids) > 0 then 1 + 4 * s.share else 0 end
      + case when s.named_in_title then 1.5 else 0 end
      + 6 * s.text_rank
      + case when s.favorite_cuisine then 0.6 else 0 end
      + 0.3 * least(s.favorites, 3)
      - 4 * s.dislikes
      -- Sauces, rubs and drinks are parts of a meal: they sink unless asked for.
      - case when cardinality(v_q.course_slugs) = 0 and s.courses && array['sauce', 'drink']
             and not s.courses && array['main', 'side', 'soup', 'salad', 'dessert', 'breakfast']
             then 3 else 0 end
      -- A small, stable daily shuffle so an empty search isn't always the same.
      + ('x' || substr(md5(s.id::text || current_date::text), 1, 6))::bit(24)::integer
        / 16777215.0 * 0.2
      )::real as pre_score
    from scored s
    order by pre_score desc
    limit v_window
  ),
  fitted as (
    select r.*, public.recipe_fit_for_user(r.id, v_user) as fit
    from ranked r
  )
  select f.id, f.title, f.source_name, f.total_minutes, f.fit,
    (f.pre_score
      - case when v_rules and f.fit = 'check_label' then 0.3 else 0 end)::real as score,
    array_remove(array[
      case when cardinality(v_q.ingredient_ids) > 0 and f.share >= 0.15
        then 'a main ingredient' end,
      case when f.favorite_cuisine then 'a favorite cuisine' end,
      case when f.favorites > 0 then 'uses ingredients you like' end,
      case when f.dislikes > 0 then 'has something you''d rather skip' end,
      case when v_rules and f.fit = 'unknown' then 'not every ingredient could be checked' end,
      case when f.fit = 'check_label' then 'fits if you check the label' end
    ], null) as why
  from fitted f
  where f.fit <> 'excluded'
  -- For someone with rules, recipes Sous can't fully check come after the
  -- ones it can, whatever their score.
  order by (v_rules and f.fit = 'unknown'), score desc, f.title
  offset p_offset
  limit p_limit;
end
$$;
