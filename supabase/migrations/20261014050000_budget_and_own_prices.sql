-- Budget-aware planning (TYL-30) and the user's own prices (TYL-34).

-- plan_cost_inputs() can also bring recipes the user might add, so the API can
-- say what each would add to the week. They come back as entries marked
-- "candidate", at full size. Same as before otherwise (20261012170000).
drop function public.plan_cost_inputs(uuid, date);

create function public.plan_cost_inputs(
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
  lines as (
    select ri.recipe_id, ri.ingredient_id, ri.quantity, ri.unit, ri.raw_text
    from public.recipe_ingredients ri
    where (ri.recipe_id in (select recipe_id from entries)
           or ri.recipe_id in (select recipe_id from candidates))
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
        'candidate', e.candidate,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'ingredient_id', l.ingredient_id, 'quantity', l.quantity, 'unit', l.unit,
            'raw_text', l.raw_text
          ))
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

-- Only the API may call it, as before (20261012000000).
revoke execute on function public.plan_cost_inputs(uuid, date, uuid[]) from public, anon, authenticated;
grant execute on function public.plan_cost_inputs(uuid, date, uuid[]) to service_role;

-- The user's own price for an ingredient (TYL-34): "tofu is $2.49 at my
-- co-op". One per ingredient and store (or one for anywhere, with no store),
-- private to them under the prices table's row-level security. Pricing
-- prefers it over the store's and over estimates.
create unique index prices_user_own_idx on public.prices
  (user_id, ingredient_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where source = 'user';

-- Set the signed-in user's price: p_price_cents buys p_quantity p_unit, a
-- standard unit or one of the ingredient's own (a bunch). Replaces their
-- earlier price there. Runs as the user, so row-level security applies.
create function public.set_my_price(
  p_ingredient uuid, p_store uuid, p_price_cents integer, p_quantity numeric, p_unit text
) returns void
language plpgsql as $$
begin
  if p_unit not in (
    'g', 'kg', 'mg', 'oz', 'lb', 'ml', 'l', 'cl', 'dl', 'fl_oz', 'cup', 'pint', 'quart',
    'gallon', 'tbsp', 'tsp', 'each', 'dozen'
  ) and not exists (
    select 1 from public.ingredient_units u where u.ingredient_id = p_ingredient and u.unit = p_unit
  ) then
    raise exception 'unknown unit %', p_unit using errcode = '22023';
  end if;
  delete from public.prices
  where source = 'user' and user_id = auth.uid() and ingredient_id = p_ingredient
    and store_id is not distinct from p_store;
  insert into public.prices (source, user_id, ingredient_id, store_id, price_cents, quantity, unit)
  values ('user', auth.uid(), p_ingredient, p_store, p_price_cents, p_quantity, p_unit);
end
$$;

-- Go back to the usual price for an ingredient at a store: forget the
-- signed-in user's price there, and their price for anywhere, which applies
-- at every store too.
create function public.clear_my_price(p_ingredient uuid, p_store uuid) returns void
language sql as $$
  delete from public.prices
  where source = 'user' and user_id = auth.uid() and ingredient_id = p_ingredient
    and (store_id is null or store_id = p_store);
$$;
