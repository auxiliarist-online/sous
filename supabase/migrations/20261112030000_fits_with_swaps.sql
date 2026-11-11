-- Recipes that fit with swaps (TYL-77). A recipe ruled out by the user's
-- diets, avoids or allergies may fit if each line that rules it out can be
-- swapped for something that fits: everything the swap brings in (the
-- ingredient and its extras) clears every rule. Allergies stay strict:
-- "may contain" an allergen never clears it, swapped or not.

-- Whether an ingredient clears the user's rules (fits, or fits if you check
-- the label for a non-allergy rule, as recipe_rule_status() reads it).
create function public.ingredient_clears(
  p_ingredient uuid, p_excludes text[], p_allergens text[], p_strict boolean
) returns boolean
language sql stable as $$
  select coalesce((
    select not (i.contains && (p_excludes || p_allergens))
       and not (i.may_contain && p_allergens)
       and not (p_strict and i.may_contain && p_excludes)
    from public.ingredients i where i.id = p_ingredient
  ), false)
$$;

-- How a recipe fits the user with swaps: null when it fits without any, or
-- when some line can't be fixed (or can't be checked); otherwise how many
-- lines need a swap, and the swaps that fix each, by ingredient:
-- {"count": 1, "fixes": {"<butter id>": ["<swap id>", ...]}}.
create function public.recipe_swap_fit(p_recipe_id uuid, p_user_id uuid) returns jsonb
language sql stable as $$
  with rules as (
    select
      coalesce(p.avoid_categories, '{}') || coalesce(
        (select array_agg(distinct c)
           from public.user_diets ud
           join public.diets d on d.slug = ud.diet_slug,
           unnest(d.excludes) as c
          where ud.user_id = p_user_id),
        '{}'
      ) as excludes,
      coalesce(p.allergens, '{}') as allergens,
      coalesce(p.strict_may_contain, false) as strict
    from (select 1) as one
    left join public.profiles p on p.user_id = p_user_id
  ),
  options as (
    select ri.line_no, ri.ingredient_id,
      public.ingredient_clears(ri.ingredient_id, r.excludes, r.allergens, r.strict) as clear
    from public.recipe_ingredients ri, rules r
    where ri.recipe_id = p_recipe_id and not ri.is_optional
  ),
  -- Lines no option of which clears the rules: each option's swaps that do.
  stuck as (
    select o.line_no, o.ingredient_id,
      (select array_agg(s.id order by s.quality, s.key)
       from public.substitutions s, rules r
       where s.from_ingredient_id = o.ingredient_id
         and public.ingredient_clears(s.to_ingredient_id, r.excludes, r.allergens, r.strict)
         and not exists (
           select 1 from unnest(s.extras) x
           where not public.ingredient_clears(x, r.excludes, r.allergens, r.strict))
      ) as swaps
    from options o
    where o.line_no in (
      select line_no from options group by line_no having not bool_or(clear))
  ),
  lines as (
    select line_no,
      bool_or(swaps is not null) as fixable,
      jsonb_object_agg(ingredient_id, to_jsonb(swaps)) filter (where swaps is not null) as fixes
    from stuck
    group by line_no
  )
  select case
    when not exists (select 1 from lines) then null
    when exists (select 1 from lines where not fixable) then null
    else jsonb_build_object(
      'count', (select count(*) from lines),
      'fixes', (select jsonb_object_agg(k, v) from lines, jsonb_each(fixes) as e(k, v)))
  end
$$;

-- The signed-in user's swap fit for a recipe, for the recipe page.
create function public.my_recipe_swap_fit(p_recipe_id uuid) returns jsonb
language sql stable as $$
  select public.recipe_swap_fit(p_recipe_id, auth.uid())
$$;

-- Find shows recipes that fit with swaps, after the ones that fit as they
-- are (TYL-77). Otherwise as before.
create or replace function public.search_recipes(
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
      -- The recipe's cuisines as the user sees them (their correction wins).
      exists (
        select 1 from public.user_favorite_cuisines f
        where f.user_id = v_user and f.cuisine_slug in (
          select u.cuisine_slug from public.user_recipe_cuisines u
          where u.user_id = v_user and u.recipe_id = b.id
          union all
          select rc.cuisine_slug from public.recipe_cuisines rc
          where rc.recipe_id = b.id and not exists (
            select 1 from public.user_recipe_cuisines u
            where u.user_id = v_user and u.recipe_id = b.id))
      ) as favorite_cuisine,
      -- The user's latest rating from Cooked it (TYL-16).
      (select c.rating from public.cooked_meals c
       where c.user_id = v_user and c.recipe_id = b.id and c.rating is not null
       order by c.cooked_on desc, c.created_at desc limit 1) as rating,
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
      -- What the user thought last time they cooked it.
      + case s.rating when 'love' then 1.0 when 'up' then 0.4 when 'down' then -5 else 0 end
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
  checked as (
    select r.*, public.recipe_fit_for_user(r.id, v_user) as raw_fit
    from ranked r
  ),
  -- A recipe ruled out only by things that swap (TYL-77) is shown, as
  -- "swaps", with how many.
  fitted as (
    select c.*,
      case when c.raw_fit = 'excluded'
        then (public.recipe_swap_fit(c.id, v_user)->>'count')::integer end as swaps
    from checked c
  ),
  shown as (
    select f.*, case when f.swaps is not null then 'swaps' else f.raw_fit end as fit
    from fitted f
    where f.raw_fit <> 'excluded' or f.swaps is not null
  )
  select f.id, f.title, f.source_name, f.total_minutes, f.fit,
    (f.pre_score
      - case when v_rules and f.fit = 'check_label' then 0.3 else 0 end)::real as score,
    array_remove(array[
      case when cardinality(v_q.ingredient_ids) > 0 and f.share >= 0.15
        then 'a main ingredient' end,
      case when f.rating = 'love' then 'you loved it' end,
      case when f.rating = 'up' then 'you liked it' end,
      case when f.favorite_cuisine then 'a favorite cuisine' end,
      case when f.favorites > 0 then 'uses ingredients you like' end,
      case when f.dislikes > 0 then 'has something you''d rather skip' end,
      case when v_rules and f.fit = 'unknown' then 'not every ingredient could be checked' end,
      case when f.fit = 'check_label' then 'fits if you check the label' end,
      case when f.fit = 'swaps'
        then 'fits with ' || f.swaps || case when f.swaps = 1 then ' swap' else ' swaps' end end
    ], null) as why
  from shown f
  -- For someone with rules, recipes Sous can't fully check come after the
  -- ones it can, whatever their score; before them, those that fit with
  -- swaps follow those that fit as they are.
  order by (v_rules and f.fit = 'unknown'), (f.fit = 'swaps'), score desc, f.title
  offset p_offset
  limit p_limit;
end
$$;
