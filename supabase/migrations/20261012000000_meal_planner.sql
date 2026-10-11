-- Weekly meal planner (TYL-15). Plans and entries already exist (core schema);
-- this adds the rules the planner relies on and a few helpers.

-- Weeks start on Monday, so "this week" means one plan.
alter table public.meal_plans
  add constraint meal_plans_week_starts_monday check (extract(isodow from week_start) = 1);

-- A plan can only hold recipes the user can see: public ones, or their own
-- private ones. The recipe check runs under the user's row-level security.
drop policy "Own plan entries" on public.meal_plan_entries;
create policy "Own plan entries" on public.meal_plan_entries for all to authenticated
  using (exists (
    select 1 from public.meal_plans p
    where p.id = meal_plan_id and p.user_id = (select auth.uid())
  ))
  with check (
    exists (
      select 1 from public.meal_plans p
      where p.id = meal_plan_id and p.user_id = (select auth.uid())
    )
    and exists (select 1 from public.recipes r where r.id = recipe_id)
  );

-- Add a recipe to the signed-in user's plan for a week, creating the plan if
-- needed. p_day, if given, must fall in that week. Returns the entry id.
create function public.add_to_meal_plan(
  p_week date, p_recipe uuid, p_servings numeric, p_day date default null, p_meal text default null
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

  insert into public.meal_plan_entries (meal_plan_id, recipe_id, servings, planned_for, meal, position)
  select v_plan, p_recipe, p_servings, p_day, p_meal,
         coalesce(max(position) + 1, 0)
  from public.meal_plan_entries where meal_plan_id = v_plan
  returning id into v_entry;
  return v_entry;
end
$$;

-- Copy one week's plan into another (same weekdays, same servings), skipping
-- recipes the user can no longer see. Returns how many entries were copied.
create function public.copy_meal_plan(p_from date, p_to date) returns integer
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

  insert into public.meal_plan_entries (meal_plan_id, recipe_id, servings, planned_for, meal, position)
  select v_to, e.recipe_id, e.servings, e.planned_for + (p_to - p_from), e.meal,
         e.position + coalesce((select max(position) + 1 from public.meal_plan_entries
                                where meal_plan_id = v_to), 0)
  from public.meal_plan_entries e
  join public.recipes r on r.id = e.recipe_id and r.status = 'active'
  where e.meal_plan_id = v_from;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- How each of these recipes fits everything the signed-in user has ruled out
-- (see recipe_fit_for_user): fits, check_label, unknown or excluded.
create function public.my_recipe_fits(p_recipe_ids uuid[])
returns table (recipe_id uuid, fit text)
language sql stable as $$
  select r.id, public.recipe_fit_for_user(r.id, auth.uid())
  from public.recipes r
  where r.id = any(p_recipe_ids)
$$;

-- Everything the API needs to estimate a week's cost for a user (TYL-15,
-- TYL-30): the plan's entries with their ingredient lines, those ingredients'
-- conversions, and the prices that apply to the user (shared ones plus their
-- own). The API is trusted to pass the right user, so only it may call this.
create function public.plan_cost_inputs(p_user uuid, p_week date) returns jsonb
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
    select e.id, e.recipe_id, e.servings, r.servings as recipe_servings
    from public.meal_plan_entries e
    join public.recipes r on r.id = e.recipe_id
    where e.meal_plan_id = v_plan.id
      -- What the user can still see (as row-level security would show them).
      and ((r.visibility = 'public' and r.status = 'active') or r.added_by = p_user)
  ),
  lines as (
    select ri.recipe_id, ri.ingredient_id, ri.quantity, ri.unit
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
        'servings', e.servings,
        'recipe_servings', e.recipe_servings,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ingredient_id', l.ingredient_id, 'quantity', l.quantity, 'unit', l.unit
          ))
          from lines l where l.recipe_id = e.recipe_id
        ), '[]')
      ))
      from entries e
    ), '[]'),
    'ingredients', coalesce((
      select jsonb_object_agg(i.id, jsonb_build_object(
        'grams_per_cup', i.grams_per_cup, 'grams_per_each', i.grams_per_each
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

revoke execute on function public.plan_cost_inputs(uuid, date) from public, anon, authenticated;
grant execute on function public.plan_cost_inputs(uuid, date) to service_role;
