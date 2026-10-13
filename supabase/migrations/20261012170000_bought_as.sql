-- Ingredients you don't buy on their own (TYL-61; Tyler: "you'd never buy egg
-- yolks at the store, you'd just buy eggs"). buy_as names what you buy and
-- buy_ratio how many grams of it per gram of this ingredient. The data comes
-- from apps/api/data/bought_as.csv (scripts/build_packaging.py).

alter table public.ingredients
  add column buy_as uuid references public.ingredients on delete set null,
  add column buy_ratio numeric check (buy_ratio > 0),
  add constraint ingredients_buy_as check (
    (buy_as is null) = (buy_ratio is null) and buy_as is distinct from id
  );

-- The plan's cost inputs gain what each ingredient is bought as, and include
-- that ingredient (with its prices) too.
create or replace function public.plan_cost_inputs(p_user uuid, p_week date) returns jsonb
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
  lines as (
    select ri.recipe_id, ri.ingredient_id, ri.quantity, ri.unit, ri.raw_text
    from public.recipe_ingredients ri
    where ri.recipe_id in (select recipe_id from entries)
      and ri.option_no = 1 and not ri.is_optional
  ),
  -- The lines' ingredients, and what those are bought as (egg yolks -> eggs).
  used as (
    select ingredient_id as id from lines where ingredient_id is not null
    union
    select i.buy_as from public.ingredients i
    where i.id in (select ingredient_id from lines) and i.buy_as is not null
  )
  select jsonb_build_object(
    'budget_cents', coalesce(
      v_plan.budget_cents,
      (select weekly_budget_cents from public.profiles where user_id = p_user)
    ),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'recipe_id', e.recipe_id,
        'scale', e.scale,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ingredient_id', l.ingredient_id, 'quantity', l.quantity, 'unit', l.unit,
            'raw_text', l.raw_text
          ))
          from lines l where l.recipe_id = e.recipe_id
        ), '[]')
      ))
      from entries e
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
                   where up.user_id = p_user and up.ingredient_id = i.id)
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
