-- Budget by what you'd actually buy (TYL-15, TYL-18, TYL-49).
--
-- * Recipes are planned at half, full or double size, not by servings.
-- * Ingredients say how they're bought: whole packages (a can, a 2 lb bag, a
--   bunch, one lemon) or loose by the amount needed (produce by the pound,
--   meat from the counter). Packages round up across the week.
-- * The user's pantry says what they already have. Until it says otherwise,
--   pantry staples (salt, oil, spices) are assumed on hand and everything else
--   is bought. This is the start of the pantry tracker (TYL-49).

-- ---------------------------------------------------------------------------
-- How ingredients are bought (data in the next migration, from packaging.csv)
-- ---------------------------------------------------------------------------

alter table public.ingredients
  add column sold_by text check (sold_by in ('package', 'loose')),
  add column package_quantity numeric check (package_quantity > 0),
  add column package_unit text,
  add column pantry_staple boolean not null default false,
  add constraint ingredients_package_size check (
    (sold_by = 'package') = (package_quantity is not null and package_unit is not null)
  );

-- ---------------------------------------------------------------------------
-- The user's pantry
-- ---------------------------------------------------------------------------

create table public.user_pantry (
  user_id uuid not null references auth.users on delete cascade,
  ingredient_id uuid not null references public.ingredients on delete cascade,
  -- have: on hand, don't buy it. out: buy it when a recipe needs it.
  status text not null check (status in ('have', 'out')),
  updated_at timestamptz not null default now(),
  primary key (user_id, ingredient_id)
);

create trigger user_pantry_set_updated_at before update on public.user_pantry
  for each row execute function public.set_updated_at();

alter table public.user_pantry enable row level security;
create policy "Own rows" on public.user_pantry for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Recipe size in the plan: half, full or double
-- ---------------------------------------------------------------------------

alter table public.meal_plan_entries
  add column scale numeric not null default 1 check (scale in (0.5, 1, 2));

update public.meal_plan_entries e set scale = case
  when r.servings is null or r.servings = 0 then 1
  when e.servings / r.servings <= 0.75 then 0.5
  when e.servings / r.servings >= 1.5 then 2
  else 1
end
from public.recipes r where r.id = e.recipe_id;

alter table public.meal_plan_entries drop column servings;

drop function public.add_to_meal_plan(date, uuid, numeric, date, text);

-- Add a recipe to the signed-in user's plan for a week, creating the plan if
-- needed. p_day, if given, must fall in that week. Returns the entry id.
create function public.add_to_meal_plan(
  p_week date, p_recipe uuid, p_scale numeric default 1, p_day date default null,
  p_meal text default null
) returns uuid
language plpgsql as $$
declare
  v_plan uuid;
  v_entry uuid;
begin
  if p_day is not null and (p_day < p_week or p_day > p_week + 6) then
    raise exception 'that day is not in this week' using errcode = '22023';
  end if;
  insert into public.meal_plans (user_id, week_start)
  values (auth.uid(), p_week)
  on conflict (user_id, week_start) do nothing;
  select id into v_plan from public.meal_plans
  where user_id = auth.uid() and week_start = p_week;

  insert into public.meal_plan_entries (meal_plan_id, recipe_id, scale, planned_for, meal, position)
  select v_plan, p_recipe, p_scale, p_day, p_meal,
         coalesce(max(position) + 1, 0)
  from public.meal_plan_entries where meal_plan_id = v_plan
  returning id into v_entry;
  return v_entry;
end
$$;

create or replace function public.copy_meal_plan(p_from date, p_to date) returns integer
language plpgsql as $$
declare
  v_from uuid;
  v_to uuid;
  v_count integer;
begin
  select id into v_from from public.meal_plans
  where user_id = auth.uid() and week_start = p_from;
  if v_from is null then
    return 0;
  end if;
  insert into public.meal_plans (user_id, week_start, budget_cents)
  select auth.uid(), p_to, budget_cents from public.meal_plans where id = v_from
  on conflict (user_id, week_start) do nothing;
  select id into v_to from public.meal_plans
  where user_id = auth.uid() and week_start = p_to;

  insert into public.meal_plan_entries (meal_plan_id, recipe_id, scale, planned_for, meal, position)
  select v_to, e.recipe_id, e.scale, e.planned_for + (p_to - p_from), e.meal,
         e.position + coalesce((select max(position) + 1 from public.meal_plan_entries
                                where meal_plan_id = v_to), 0)
  from public.meal_plan_entries e
  join public.recipes r on r.id = e.recipe_id and r.status = 'active'
  where e.meal_plan_id = v_from;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- What the API needs to price a week
-- ---------------------------------------------------------------------------

-- As before, plus how each ingredient is bought and what the user's pantry
-- says about it. Lines keep their raw text so unmatched ones can be listed.
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
