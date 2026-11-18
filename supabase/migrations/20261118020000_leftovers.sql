-- Leftovers (TYL-67): a plan entry can be leftovers of another entry in the
-- same plan (lunch Tuesday from Monday's dinner). It's the same recipe and
-- adds nothing to the buy list. And a user can say how many a recipe serves
-- when the recipe doesn't, so leftovers can be worked out.

alter table public.meal_plan_entries
  add column leftover_of uuid references public.meal_plan_entries on delete cascade,
  add constraint leftover_not_itself check (leftover_of is distinct from id);

create index meal_plan_entries_leftover_of_idx on public.meal_plan_entries (leftover_of);

-- Leftovers come from an entry in the same plan with the same recipe, and
-- not from other leftovers.
create function public.check_leftover() returns trigger
language plpgsql as $$
declare
  v_source public.meal_plan_entries;
begin
  if new.leftover_of is null then
    return new;
  end if;
  select * into v_source from public.meal_plan_entries where id = new.leftover_of;
  if v_source.id is null
     or v_source.meal_plan_id <> new.meal_plan_id
     or v_source.recipe_id <> new.recipe_id
     or v_source.leftover_of is not null then
    raise exception 'leftovers come from a meal in the same plan, with the same recipe'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger meal_plan_entries_leftover
  before insert or update of leftover_of, recipe_id, meal_plan_id on public.meal_plan_entries
  for each row execute function public.check_leftover();

-- Plan leftovers of a meal on a day (and meal: lunch, dinner...), at the
-- end of the week's plan. Runs as the user: their plan only (row-level
-- security). Returns the new entry's id.
create function public.add_leftover(p_source uuid, p_day date, p_meal text default 'lunch')
returns uuid
language plpgsql as $$
declare
  v_source public.meal_plan_entries;
  v_id uuid;
begin
  select * into v_source from public.meal_plan_entries where id = p_source;
  if v_source.id is null then
    raise exception 'no such meal' using errcode = '22023';
  end if;
  insert into public.meal_plan_entries
    (meal_plan_id, recipe_id, scale, planned_for, meal, position, reviewed, leftover_of)
  values (
    v_source.meal_plan_id, v_source.recipe_id, 1, p_day, p_meal,
    coalesce((select max(position) + 1 from public.meal_plan_entries
              where meal_plan_id = v_source.meal_plan_id), 0),
    true, v_source.id)
  returning id into v_id;
  return v_id;
end
$$;

revoke execute on function public.add_leftover(uuid, date, text) from public, anon;
grant execute on function public.add_leftover(uuid, date, text) to authenticated;

-- How many a recipe serves, as the user says, when the recipe doesn't.
create table public.user_recipe_servings (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  recipe_id uuid not null references public.recipes on delete cascade,
  servings numeric not null check (servings > 0 and servings <= 100),
  primary key (user_id, recipe_id)
);

alter table public.user_recipe_servings enable row level security;
create policy "Own rows" on public.user_recipe_servings for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.recipes r where r.id = recipe_id)
  );
grant select on public.user_recipe_servings to anon;
grant select, insert, update, delete on public.user_recipe_servings to authenticated, service_role;

-- plan_cost_inputs() leaves leftover entries out (counting leftover dinners
-- for Plan my week). Otherwise as in
-- 20261112020000_swaps_on_the_list.
create or replace function public.plan_cost_inputs(
  p_user uuid, p_week date, p_candidates uuid[] default '{}', p_extra uuid[] default '{}'
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
    select e.id, e.recipe_id, e.scale, e.meal, e.reviewed
    from public.meal_plan_entries e
    join public.recipes r on r.id = e.recipe_id
    where e.meal_plan_id = v_plan.id
      -- Leftovers are eaten from another entry: nothing more to buy (TYL-67).
      and e.leftover_of is null
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
      ri.raw_text, ri.name
    from public.recipe_ingredients ri
    where (ri.recipe_id in (select recipe_id from entries)
           or ri.recipe_id in (select recipe_id from candidates))
      and not ri.is_optional
  ),
  -- The user's swaps for these recipes (TYL-77): what each ingredient is
  -- swapped for, and how much.
  swaps as (
    select us.recipe_id, s.from_ingredient_id, s.to_ingredient_id, s.factor,
      s.to_unit, s.per_unit, s.extras
    from public.user_recipe_swaps us
    join public.substitutions s on s.id = us.substitution_id
    where us.user_id = p_user
      and (us.recipe_id in (select recipe_id from entries)
           or us.recipe_id in (select recipe_id from candidates))
  ),
  -- The lines' ingredients, what they're swapped for, and what those are
  -- bought as (egg yolks -> eggs).
  used as (
    select ingredient_id as id from lines where ingredient_id is not null
    union
    select to_ingredient_id from swaps
    union
    select unnest(extras) from swaps
    union
    select i.buy_as from public.ingredients i
    where i.id in (select to_ingredient_id from swaps union select unnest(extras) from swaps)
      and i.buy_as is not null
    union
    select i.buy_as from public.ingredients i
    where i.id in (select ingredient_id from lines) and i.buy_as is not null
    union
    -- Items the user added to the list themselves (TYL-146), priced on the
    -- side, and what they're bought as.
    select unnest(p_extra)
    union
    select i.buy_as from public.ingredients i
    where i.id = any(p_extra) and i.buy_as is not null
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
    -- Leftover dinners fill a night for Plan my week, though they buy nothing.
    'leftover_dinners', (
      select count(*) from public.meal_plan_entries e
      where e.meal_plan_id = v_plan.id and e.leftover_of is not null
        and coalesce(e.meal, 'dinner') = 'dinner'),
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
        -- Checked against the pantry for the list (TYL-150).
        'reviewed', e.reviewed,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'line_no', l.line_no, 'option_no', l.option_no,
            'ingredient_id', l.ingredient_id, 'quantity', l.quantity, 'unit', l.unit,
            'raw_text', l.raw_text,
            -- The recipe's word for it ("whipped cream", bought as heavy cream),
            -- to name an "or" line's options as the recipe does (TYL-141).
            'name', l.name
          ) order by l.line_no, l.option_no)
          from lines l where l.recipe_id = e.recipe_id
        ), '[]'),
        -- The user's swaps for this recipe, by the ingredient swapped out.
        'swaps', coalesce((
          select jsonb_object_agg(s.from_ingredient_id, jsonb_build_object(
            'to', s.to_ingredient_id, 'factor', s.factor, 'to_unit', s.to_unit,
            'per_unit', s.per_unit, 'extras', to_jsonb(s.extras)
          ))
          from swaps s where s.recipe_id = e.recipe_id
        ), '{}')
      ))
      from (
        select id::text as id, recipe_id, scale, meal, false as candidate, reviewed from entries
        union all
        select 'candidate-' || recipe_id, recipe_id, 1, null, true, false from candidates
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
