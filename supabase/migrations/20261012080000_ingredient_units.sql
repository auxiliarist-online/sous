-- Ingredient-specific units (TYL-79): a clove of garlic, a stick of butter, a
-- slice of bread, a bunch of cilantro. Grams per unit, from USDA portions and
-- data/unit_equivalents.csv (scripts/build_weights.py writes the data).
-- Standard units (cups, ounces, pinches) live in app/pricing/units.py.

create table public.ingredient_units (
  ingredient_id uuid not null references public.ingredients on delete cascade,
  unit text not null check (unit ~ '^[a-z_]+$'),
  grams numeric not null check (grams > 0),
  source text not null check (source in ('usda', 'hand')),
  primary key (ingredient_id, unit)
);

alter table public.ingredient_units enable row level security;
create policy "Public read" on public.ingredient_units for select to anon, authenticated using (true);

-- The plan's cost inputs gain each ingredient's units.
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
        'units', coalesce((
          select jsonb_object_agg(u.unit, u.grams)
          from public.ingredient_units u where u.ingredient_id = i.id
        ), '{}'),
        'pantry', (select up.status from public.user_pantry up
                   where up.user_id = p_user and up.ingredient_id = i.id)
      ))
      from public.ingredients i
      where i.id in (select ingredient_id from lines)
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
      where pr.ingredient_id in (select ingredient_id from lines)
        and (pr.user_id is null or pr.user_id = p_user)
    ), '[]')
  ) into v_result;
  return v_result;
end
$$;
