-- Past choices in recommendations (TYL-16): what the user thought of a recipe
-- when they cooked it (Cooked it ratings, TYL-68).
--
-- * Plan my week: plan_draft_pool() brings each recipe's latest rating. The
--   API favors loved ones and leaves out ones rated down (app/plans/draft.py).
-- * Find: loved recipes rise ("you loved it"), liked ones a little, ones rated
--   down sink. A favorite cuisine counts the user's own cuisine corrections
--   (TYL-56). Otherwise both as before.

create or replace function public.plan_draft_pool(p_user uuid, p_week date) returns jsonb
language plpgsql stable as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'plan_draft_pool is only callable by the API' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'cook_with_seasons', coalesce(
      (select p.cook_with_seasons from public.profiles p where p.user_id = p_user), false
    ),
    -- How much variety the user wants (TYL-66); the defaults with no profile.
    'variety', coalesce((
      select jsonb_build_object(
        'proteins', p.mix_proteins, 'cuisines', p.mix_cuisines,
        'styles', p.mix_styles, 'repeat_weeks', p.repeat_weeks)
      from public.profiles p where p.user_id = p_user
    ), jsonb_build_object('proteins', true, 'cuisines', true, 'styles', true, 'repeat_weeks', 3)),
    'candidates', coalesce((
    select jsonb_agg(jsonb_build_object(
      'recipe_id', r.id,
      'title', r.title,
      -- The user's own tags, which can name a cooking style ("soup").
      'tags', to_jsonb(coalesce(s.tags, '{}')),
      'fit', public.recipe_fit_for_user(r.id, p_user),
      'favorite', (select f.frequency from public.user_favorite_recipes f
                   where f.user_id = p_user and f.recipe_id = r.id),
      -- 0 is this week; null is not in the last 8 weeks.
      'weeks_ago', (
        select min(greatest(0, ceil((p_week - d)::numeric / 7)))::int
        from (
          select mp.week_start as d
          from public.meal_plan_entries e
          join public.meal_plans mp on mp.id = e.meal_plan_id
          where mp.user_id = p_user and e.recipe_id = r.id
            and mp.week_start between p_week - 56 and p_week - 7
          union all
          select c.cooked_on from public.cooked_meals c
          where c.user_id = p_user and c.recipe_id = r.id
            and c.cooked_on between p_week - 56 and p_week - 1
        ) had
      ),
      -- The user's own correction wins (TYL-56).
      'cuisines', public.recipe_cuisine_names(r.id, p_user),
      -- The user's latest rating of it, from Cooked it (TYL-16).
      'rating', (select c.rating from public.cooked_meals c
                 where c.user_id = p_user and c.recipe_id = r.id and c.rating is not null
                 order by c.cooked_on desc, c.created_at desc limit 1),
      -- Its seasonal produce (in season 8 months a year or fewer) that's in
      -- season the week planned, and how much isn't (TYL-70).
      'in_season', coalesce((
        select jsonb_agg(distinct s2.name)
        from public.recipe_seasonal(r.id, p_user, p_week) s2 where s2.in_season
      ), '[]'),
      'out_of_season', (
        select count(*) from public.recipe_seasonal(r.id, p_user, p_week) s2
        where not s2.in_season
      )
    ) order by s.created_at desc)
    from public.user_saved_recipes s
    join public.recipes r on r.id = s.recipe_id
    where s.user_id = p_user
      and ((r.visibility = 'public' and r.status = 'active') or r.added_by = p_user)
  ), '[]'));
end
$$;

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
      case when f.rating = 'love' then 'you loved it' end,
      case when f.rating = 'up' then 'you liked it' end,
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
