-- TYL-98. "Almond milk or cow's milk": the week settles which option it buys,
-- instead of always the first. The user's choices for a week are kept on its
-- plan, keyed by the options' ingredient ids (sorted, joined with commas), so
-- one choice covers every recipe that offers the same options. The API reads
-- every option of each line, with what each ingredient contains and what the
-- user rules out, and settles each line (app/plans/options.py).

alter table public.meal_plans
  add column choices jsonb not null default '{}'
    constraint meal_plans_choices_object check (jsonb_typeof(choices) = 'object');

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
    select e.id, e.recipe_id, e.scale
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
        select id::text as id, recipe_id, scale, false as candidate from entries
        union all
        select 'candidate-' || recipe_id, recipe_id, 1, true from candidates
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
