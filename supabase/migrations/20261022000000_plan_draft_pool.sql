-- TYL-65. "Plan my week": the recipes a draft can pick from. They're the user's
-- saved recipes they can still see, each with how it fits their rules
-- (recipe_fit_for_user), whether it's a favorite and how often (TYL-66), how
-- many weeks ago it was last planned or cooked (TYL-68), and its cuisines.
-- The API prices them with plan_cost_inputs() and drafts the week.
create function public.plan_draft_pool(p_user uuid, p_week date) returns jsonb
language plpgsql stable as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'plan_draft_pool is only callable by the API' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'recipe_id', r.id,
      'title', r.title,
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
      'cuisines', coalesce((
        select jsonb_agg(cu.name order by cu.name)
        from public.recipe_cuisines rc join public.cuisines cu on cu.slug = rc.cuisine_slug
        where rc.recipe_id = r.id
      ), '[]')
    ) order by s.created_at desc)
    from public.user_saved_recipes s
    join public.recipes r on r.id = s.recipe_id
    where s.user_id = p_user
      and ((r.visibility = 'public' and r.status = 'active') or r.added_by = p_user)
  ), '[]');
end
$$;

revoke execute on function public.plan_draft_pool(uuid, date) from public, anon, authenticated;
grant execute on function public.plan_draft_pool(uuid, date) to service_role;

-- Each planned entry now says which meal it is, so a draft counts only the
-- week's dinners (an entry without a meal is a dinner). Otherwise as before.
create or replace function public.plan_cost_inputs(
  p_user uuid, p_week date, p_candidates uuid[] default '{}'
) returns jsonb
language plpgsql stable as $$
declare
  v_plan public.meal_plans;
  v_result jsonb;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'plan_cost_inputs is only callable by the API' using errcode = '42501';
  end if;
  select * into v_plan from public.meal_plans where user_id = p_user and week_start = p_week;

  with entries as (
    select e.id, e.recipe_id, e.scale, e.meal
    from public.meal_plan_entries e
    join public.recipes r on r.id = e.recipe_id
    where e.meal_plan_id = v_plan.id
      -- What the user can still see (as row-level security would show them).
      and ((r.visibility = 'public' and r.status = 'active') or r.added_by = p_user)
  ),
  -- Recipes the user might add (TYL-30), at full size, priced on the side.
  candidates as (
    select r.id as recipe_id
    from public.recipes r
    where r.id = any(p_candidates)
      and ((r.visibility = 'public' and r.status = 'active') or r.added_by = p_user)
  ),
  -- Every option of each line ("almond milk or cow's milk"): the API settles
  -- which one is bought (TYL-98).
  lines as (
    select ri.recipe_id, ri.line_no, ri.option_no, ri.ingredient_id, ri.quantity, ri.unit,
      ri.raw_text
    from public.recipe_ingredients ri
    where (ri.recipe_id in (select recipe_id from entries)
           or ri.recipe_id in (select recipe_id from candidates))
      and not ri.is_optional
  ),
  -- The lines' ingredients, and what those are bought as (egg yolks -> eggs).
  used as (
    select ingredient_id as id from lines where ingredient_id is not null
    union
    select i.buy_as from public.ingredients i
    where i.id in (select ingredient_id from lines) and i.buy_as is not null
  )
  select jsonb_build_object(
    -- What the user rules out, as recipe_fit_for_user() reads it, to settle
    -- "or" lines by diet; and what they've chosen this week.
    'rules', (
      select jsonb_build_object(
        'excludes', to_jsonb(coalesce(p.avoid_categories, '{}') || coalesce(
          (select array_agg(distinct c)
             from public.user_diets ud
             join public.diets d on d.slug = ud.diet_slug,
             unnest(d.excludes) as c
            where ud.user_id = p_user),
          '{}'
        )),
        'allergens', to_jsonb(coalesce(p.allergens, '{}')),
        'strict', coalesce(p.strict_may_contain, false)
      )
      from (select 1) as one
      left join public.profiles p on p.user_id = p_user
    ),
    'choices', coalesce(v_plan.choices, '{}'),
    'budget_cents', coalesce(
      v_plan.budget_cents,
      (select weekly_budget_cents from public.profiles where user_id = p_user)
    ),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'recipe_id', e.recipe_id,
        'scale', e.scale,
        'meal', e.meal,
        'candidate', e.candidate,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'line_no', l.line_no, 'option_no', l.option_no,
            'ingredient_id', l.ingredient_id, 'quantity', l.quantity, 'unit', l.unit,
            'raw_text', l.raw_text
          ) order by l.line_no, l.option_no)
          from lines l where l.recipe_id = e.recipe_id
        ), '[]')
      ))
      from (
        select id::text as id, recipe_id, scale, meal, false as candidate from entries
        union all
        select 'candidate-' || recipe_id, recipe_id, 1, null, true from candidates
      ) e
    ), '[]'),
    'ingredients', coalesce((
      select jsonb_object_agg(i.id, jsonb_build_object(
        'name', i.name,
        'aisle', i.aisle,
        'grams_per_cup', i.grams_per_cup,
        'grams_per_each', i.grams_per_each,
        'sold_by', i.sold_by,
        'package_quantity', i.package_quantity,
        'package_unit', i.package_unit,
        'pantry_staple', i.pantry_staple,
        'buy_as', i.buy_as,
        'buy_ratio', i.buy_ratio,
        'units', coalesce((
          select jsonb_object_agg(u.unit, u.grams)
          from public.ingredient_units u where u.ingredient_id = i.id
        ), '{}'),
        'pantry', (select up.status from public.user_pantry up
                   where up.user_id = p_user and up.ingredient_id = i.id),
        'contains', to_jsonb(i.contains),
        'may_contain', to_jsonb(i.may_contain),
        'disliked', exists (select 1 from public.user_disliked_ingredients ud
                            where ud.user_id = p_user and ud.ingredient_id = i.id)
      ))
      from public.ingredients i
      where i.id in (select id from used)
    ), '{}'),
    'prices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'ingredient_id', pr.ingredient_id,
        'source', pr.source,
        'price_cents', pr.price_cents,
        'quantity', pr.quantity,
        'unit', pr.unit,
        'store_id', pr.store_id,
        'valid_from', pr.valid_from,
        'valid_to', pr.valid_to,
        'observed_at', pr.observed_at
      ))
      from public.prices pr
      where pr.ingredient_id in (select id from used)
        and (pr.user_id is null or pr.user_id = p_user)
    ), '[]')
  ) into v_result;
  return v_result;
end
$$;
