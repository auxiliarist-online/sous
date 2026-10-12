-- Weight of each ingredient line, so search can tell what a recipe is mostly
-- made of ("eggs" -> a frittata, not a cake with two eggs). The standard
-- units are the same table as apps/api/app/pricing/units.py (a unit test
-- keeps them in step); ingredient-specific units come from ingredient_units.

create table public.units (
  unit text primary key,
  kind text not null check (kind in ('mass', 'volume', 'count')),
  -- Grams, millilitres or items in one of this unit.
  factor numeric not null check (factor > 0)
);

insert into public.units (unit, kind, factor) values
  ('mg', 'mass', 0.001),
  ('g', 'mass', 1.0),
  ('kg', 'mass', 1000.0),
  ('oz', 'mass', 28.3495),
  ('lb', 'mass', 453.592),
  ('smidgen', 'volume', 0.154),
  ('pinch', 'volume', 0.308),
  ('dash', 'volume', 0.616),
  ('ml', 'volume', 1.0),
  ('cl', 'volume', 10.0),
  ('dl', 'volume', 100.0),
  ('l', 'volume', 1000.0),
  ('tsp', 'volume', 4.92892),
  ('tbsp', 'volume', 14.7868),
  ('cup', 'volume', 236.588),
  ('fl_oz', 'volume', 29.5735),
  ('pint', 'volume', 473.176),
  ('quart', 'volume', 946.353),
  ('gallon', 'volume', 3785.41),
  ('each', 'count', 1.0),
  ('dozen', 'count', 12.0);

alter table public.units enable row level security;
create policy "Public read" on public.units for select to anon, authenticated using (true);

-- Grams for an amount of an ingredient, or null when it can't be known (no
-- amount, an unmatched ingredient, or cups of something with no density).
create function public.line_grams(p_ingredient uuid, p_quantity numeric, p_unit text)
returns numeric
language sql stable as $$
  select case
    when p_quantity is null or p_ingredient is null then null
    when iu.grams is not null then p_quantity * iu.grams
    when u.kind = 'mass' then p_quantity * u.factor
    when u.kind = 'volume' and i.grams_per_cup is not null
      then p_quantity * u.factor / 236.588 * i.grams_per_cup
    when u.kind = 'count' and i.grams_per_each is not null
      then p_quantity * u.factor * i.grams_per_each
  end
  from (select 1) as one
  left join public.ingredients i on i.id = p_ingredient
  left join public.units u on u.unit = coalesce(p_unit, 'each')
  left join public.ingredient_units iu on iu.ingredient_id = p_ingredient and iu.unit = p_unit
$$;

alter table public.recipe_ingredients add column grams numeric check (grams >= 0);

create function public.set_line_grams() returns trigger
language plpgsql as $$
begin
  new.grams := public.line_grams(new.ingredient_id, new.quantity, new.unit);
  return new;
end
$$;

create trigger recipe_ingredients_grams
  before insert or update of ingredient_id, quantity, unit on public.recipe_ingredients
  for each row execute function public.set_line_grams();

-- Recompute every line's grams after weights or units change. Service role only.
create function public.refresh_line_grams() returns integer
language plpgsql as $$
declare
  v_count integer;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'refresh_line_grams is only callable by the API' using errcode = '42501';
  end if;
  update public.recipe_ingredients
  set grams = public.line_grams(ingredient_id, quantity, unit);
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke execute on function public.refresh_line_grams() from public, anon, authenticated;
grant execute on function public.refresh_line_grams() to service_role;

update public.recipe_ingredients set grams = public.line_grams(ingredient_id, quantity, unit);
