-- The shopping list (TYL-18): one per user and week, filled from the plan's
-- buy list and then freely edited. Kroger's prices are never stored here
-- (their terms, §5e.1): the list shows today's prices from the plan's cost.

alter table public.shopping_lists add column week_start date;
create unique index shopping_lists_user_week on public.shopping_lists (user_id, week_start)
  where week_start is not null;

alter table public.shopping_list_items
  -- What to buy, as the user reads it: "2 × 15 oz", "1 bunch", "a few".
  add column amount text check (length(amount) <= 60),
  -- The user changed it (amount, name or store): the plan no longer updates it.
  add column edited boolean not null default false,
  -- A plan item the user took off the list: kept so the plan doesn't add it back.
  add column removed boolean not null default false,
  add constraint shopping_list_items_name_length check (length(name) between 1 and 120);

-- One row per plan ingredient on a list; the user's own items are free.
create unique index shopping_list_items_planned on public.shopping_list_items
  (shopping_list_id, ingredient_id) where not is_manual and ingredient_id is not null;

-- Bring the signed-in user's list for a week in line with the plan: p_items is
-- the plan's buy list, [{ingredient_id, name, amount, aisle, position}]. New
-- items are added and amounts updated, except on items the user edited or
-- checked off; items the plan no longer needs go, unless checked off, edited
-- or taken off (a taken-off item stays off if the plan needs it again). The
-- user's own items are never touched. Returns the list's id.
-- Runs as the user: row-level security applies.
create function public.sync_shopping_list(p_week date, p_items jsonb) returns uuid
language plpgsql as $$
declare
  v_user uuid := auth.uid();
  v_list uuid;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if extract(isodow from p_week) <> 1 then
    raise exception 'weeks start on Monday' using errcode = '22023';
  end if;
  insert into public.shopping_lists (user_id, week_start)
  values (v_user, p_week)
  on conflict (user_id, week_start) where week_start is not null
    do update set updated_at = now()
  returning id into v_list;

  insert into public.shopping_list_items
    (shopping_list_id, ingredient_id, name, amount, aisle, position)
  select v_list, (x->>'ingredient_id')::uuid, x->>'name', x->>'amount', x->>'aisle',
         coalesce((x->>'position')::integer, 0)
  from jsonb_array_elements(p_items) as x
  where x->>'ingredient_id' is not null
  on conflict (shopping_list_id, ingredient_id) where not is_manual and ingredient_id is not null
  do update set
    aisle = excluded.aisle,
    position = excluded.position,
    name = case when shopping_list_items.edited then shopping_list_items.name else excluded.name end,
    amount = case
      when shopping_list_items.edited or shopping_list_items.checked_at is not null
        then shopping_list_items.amount
      else excluded.amount
    end;

  delete from public.shopping_list_items i
  where i.shopping_list_id = v_list
    and not i.is_manual
    and i.checked_at is null
    and not i.edited
    and not i.removed
    and not exists (
      select 1 from jsonb_array_elements(p_items) as x
      where (x->>'ingredient_id')::uuid = i.ingredient_id
    );
  return v_list;
end
$$;

revoke execute on function public.sync_shopping_list(date, jsonb) from public, anon;
grant execute on function public.sync_shopping_list(date, jsonb) to authenticated;
