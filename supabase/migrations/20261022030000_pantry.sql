-- The pantry (TYL-133 to TYL-137, designed in TYL-97): two kinds of entry.
--
-- * A staple is something the user always keeps (salt, rice, soy sauce): it's
--   "have" until they mark it "out". An out staple goes on the shopping list,
--   and checking it off there marks it "have" again.
-- * On hand is a one-off (half a bag of spinach): always "have", gone when
--   it's used up ("Cooked it" asks) or removed.
--
-- Either way, "have" is left off the buy list. Nothing is assumed on hand, so
-- an ingredient with no row is bought (TYL-88).
--
-- Staples are offered by aisle group (ingredients.pantry_group) and as
-- starter kits (pantry_kits): basics, one per cuisine, one per diet. Both come
-- from apps/api/data/pantry.csv, in the next migration.

alter table public.user_pantry
  add column kind text not null default 'staple' check (kind in ('staple', 'on_hand')),
  add constraint user_pantry_on_hand_is_have check (kind = 'staple' or status = 'have');

-- What was marked before: a catalog staple stays a staple; anything else
-- marked "have" was on hand.
update public.user_pantry up set kind = 'on_hand'
from public.ingredients i
where i.id = up.ingredient_id and up.status = 'have' and not i.pantry_staple;

-- ---------------------------------------------------------------------------
-- Aisle groups and starter kits
-- ---------------------------------------------------------------------------

alter table public.ingredients
  add column pantry_group text check (pantry_group in (
    'spices', 'oils_vinegars', 'baking', 'sauces', 'grains', 'cans', 'broths', 'nuts'
  ));

-- A kit is "basics", a cuisine's slug or a diet's slug.
create table public.pantry_kits (
  kit text not null check (kit ~ '^[a-z_]+$'),
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  primary key (kit, ingredient_id)
);

alter table public.pantry_kits enable row level security;
-- Catalog data: anyone can read it; only the API's migrations write it.
create policy "Anyone reads" on public.pantry_kits for select to anon, authenticated
  using (true);

grant select on public.pantry_kits to anon;
grant select, insert, update, delete on public.pantry_kits to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Suggestions the user turned down, so they aren't offered again (TYL-136)
-- ---------------------------------------------------------------------------

create table public.user_pantry_dismissed (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, ingredient_id)
);

alter table public.user_pantry_dismissed enable row level security;
create policy "Own rows" on public.user_pantry_dismissed for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select on public.user_pantry_dismissed to anon;
grant select, insert, update, delete on public.user_pantry_dismissed
  to authenticated, service_role;

-- Pantry-type ingredients the signed-in user keeps reaching for: used in at
-- least three of the recipes they've planned or cooked, not in their pantry,
-- and not turned down. Most used first. Runs as the user (row-level security
-- applies).
create function public.pantry_suggestions() returns jsonb
language sql stable as $$
  with mine as (
    select e.recipe_id from public.meal_plan_entries e
    join public.meal_plans mp on mp.id = e.meal_plan_id
    where mp.user_id = auth.uid()
    union
    select c.recipe_id from public.cooked_meals c where c.user_id = auth.uid()
  ),
  used as (
    select ri.ingredient_id, count(distinct ri.recipe_id) as recipes
    from public.recipe_ingredients ri
    join public.ingredients i on i.id = ri.ingredient_id
    where ri.recipe_id in (select recipe_id from mine)
      and i.pantry_group is not null
      and not exists (select 1 from public.user_pantry up
                      where up.user_id = auth.uid() and up.ingredient_id = i.id)
      and not exists (select 1 from public.user_pantry_dismissed d
                      where d.user_id = auth.uid() and d.ingredient_id = i.id)
    group by ri.ingredient_id
    having count(distinct ri.recipe_id) >= 3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'ingredient_id', i.id, 'name', i.name, 'recipes', u.recipes
  ) order by u.recipes desc, i.name), '[]')
  from (select * from used order by recipes desc, ingredient_id limit 5) u
  join public.ingredients i on i.id = u.ingredient_id
$$;

revoke execute on function public.pantry_suggestions() from public, anon;
grant execute on function public.pantry_suggestions() to authenticated;

-- What's on hand that a recipe uses, for "Used up the spinach?" after
-- "Cooked it" (TYL-137). Staples aren't asked about: they're always kept.
create function public.on_hand_in(p_recipe uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('ingredient_id', i.id, 'name', i.name)
                            order by i.name), '[]')
  from public.user_pantry up
  join public.ingredients i on i.id = up.ingredient_id
  where up.user_id = auth.uid() and up.kind = 'on_hand'
    and exists (select 1 from public.recipe_ingredients ri
                where ri.recipe_id = p_recipe and ri.ingredient_id = up.ingredient_id)
$$;

revoke execute on function public.on_hand_in(uuid) from public, anon;
grant execute on function public.on_hand_in(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The shopping list: out staples go on it, and checking one off restocks it
-- ---------------------------------------------------------------------------

-- As before (20261015020000_shopping_list.sql), plus: staples the user marked
-- out are on the list of any week that isn't over, needed by a recipe or not,
-- and stay while they're out.
create or replace function public.sync_shopping_list(p_week date, p_items jsonb) returns uuid
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

  if p_week + 6 >= current_date then
    insert into public.shopping_list_items
      (shopping_list_id, ingredient_id, name, aisle, position)
    select v_list, i.id, i.name, i.aisle, 9000
    from public.user_pantry up
    join public.ingredients i on i.id = up.ingredient_id
    where up.user_id = v_user and up.kind = 'staple' and up.status = 'out'
    on conflict (shopping_list_id, ingredient_id) where not is_manual and ingredient_id is not null
    do nothing;
  end if;

  delete from public.shopping_list_items i
  where i.shopping_list_id = v_list
    and not i.is_manual
    and i.checked_at is null
    and not i.edited
    and not i.removed
    and not exists (
      select 1 from jsonb_array_elements(p_items) as x
      where (x->>'ingredient_id')::uuid = i.ingredient_id
    )
    and not (p_week + 6 >= current_date and exists (
      select 1 from public.user_pantry up
      where up.user_id = v_user and up.ingredient_id = i.ingredient_id
        and up.kind = 'staple' and up.status = 'out'
    ));
  return v_list;
end
$$;

-- Checking an out staple off the list marks it "have"; unchecking it (a
-- mis-tap) marks it out again. Only staples: other items don't touch the
-- pantry. Runs as whoever changed the item, under row-level security.
create function public.shopping_item_restocks() returns trigger
language plpgsql as $$
declare
  v_user uuid := (select user_id from public.shopping_lists where id = new.shopping_list_id);
begin
  if new.ingredient_id is null or new.is_manual then
    return new;
  end if;
  if new.checked_at is not null and old.checked_at is null then
    update public.user_pantry set status = 'have'
    where user_id = v_user and ingredient_id = new.ingredient_id
      and kind = 'staple' and status = 'out';
  elsif new.checked_at is null and old.checked_at is not null then
    update public.user_pantry set status = 'out'
    where user_id = v_user and ingredient_id = new.ingredient_id
      and kind = 'staple' and status = 'have';
  end if;
  return new;
end
$$;

create trigger shopping_list_items_restock after update of checked_at
  on public.shopping_list_items
  for each row execute function public.shopping_item_restocks();

-- ---------------------------------------------------------------------------
-- The user's data export: the pantry's kinds, and suggestions turned down
-- ---------------------------------------------------------------------------

create or replace function public.export_my_data() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.user_id = auth.uid()),
    'diets', coalesce((select jsonb_agg(d.diet_slug) from public.user_diets d
                       where d.user_id = auth.uid()), '[]'),
    'diet_goals', coalesce((select jsonb_agg(to_jsonb(g)) from public.user_diet_goals g
                            where g.user_id = auth.uid()), '[]'),
    'category_weights', coalesce((select jsonb_agg(to_jsonb(w)) from public.user_category_weights w
                                  where w.user_id = auth.uid()), '[]'),
    'favorite_cuisines', coalesce((select jsonb_agg(c.cuisine_slug) from public.user_favorite_cuisines c
                                   where c.user_id = auth.uid()), '[]'),
    'favorite_ingredients', coalesce((select jsonb_agg(i.name)
                                      from public.user_favorite_ingredients f
                                      join public.ingredients i on i.id = f.ingredient_id
                                      where f.user_id = auth.uid()), '[]'),
    'disliked_ingredients', coalesce((select jsonb_agg(i.name)
                                      from public.user_disliked_ingredients d
                                      join public.ingredients i on i.id = d.ingredient_id
                                      where d.user_id = auth.uid()), '[]'),
    'saved_recipes', coalesce((select jsonb_agg(jsonb_build_object(
                                 'title', r.title, 'source_url', r.source_url,
                                 'tags', s.tags, 'saved_at', s.created_at)
                               order by s.created_at)
                               from public.user_saved_recipes s
                               join public.recipes r on r.id = s.recipe_id
                               where s.user_id = auth.uid()), '[]'),
    'your_recipes', coalesce((select jsonb_agg(jsonb_build_object(
                                'title', r.title, 'servings', r.servings,
                                'ingredients', (select jsonb_agg(ri.raw_text order by ri.line_no)
                                                from public.recipe_ingredients ri
                                                where ri.recipe_id = r.id and ri.option_no = 1),
                                'instructions', r.instructions, 'note', r.source_note))
                              from public.recipes r
                              where r.added_by = auth.uid() and r.source_url is null), '[]'),
    'meal_plans', coalesce((select jsonb_agg(jsonb_build_object(
                              'week_start', mp.week_start, 'budget_cents', mp.budget_cents,
                              'meals', (select jsonb_agg(jsonb_build_object(
                                          'recipe', r.title, 'scale', e.scale,
                                          'day', e.planned_for, 'meal', e.meal)
                                        order by e.position)
                                        from public.meal_plan_entries e
                                        join public.recipes r on r.id = e.recipe_id
                                        where e.meal_plan_id = mp.id))
                            order by mp.week_start)
                            from public.meal_plans mp where mp.user_id = auth.uid()), '[]'),
    'pantry', coalesce((select jsonb_agg(jsonb_build_object('ingredient', i.name, 'kind', up.kind, 'status', up.status))
                        from public.user_pantry up join public.ingredients i on i.id = up.ingredient_id
                        where up.user_id = auth.uid()), '[]'),
    'your_prices', coalesce((select jsonb_agg(jsonb_build_object(
                               'ingredient', i.name, 'price_cents', pr.price_cents,
                               'quantity', pr.quantity, 'unit', pr.unit, 'store', st.name))
                             from public.prices pr
                             join public.ingredients i on i.id = pr.ingredient_id
                             left join public.stores st on st.id = pr.store_id
                             where pr.source = 'user' and pr.user_id = auth.uid()), '[]'),
    'stores', coalesce((select jsonb_agg(jsonb_build_object(
                          'name', st.name, 'address', st.address, 'primary', us.is_primary)
                        order by us.is_primary desc, st.name)
                        from public.user_stores us join public.stores st on st.id = us.store_id
                        where us.user_id = auth.uid()), '[]'),
    'shopping_lists', coalesce((select jsonb_agg(jsonb_build_object(
                                  'week_start', sl.week_start,
                                  'items', (select jsonb_agg(jsonb_build_object(
                                              'name', it.name, 'amount', it.amount,
                                              'checked', it.checked_at is not null,
                                              'removed', it.removed)
                                            order by it.position)
                                            from public.shopping_list_items it
                                            where it.shopping_list_id = sl.id))
                                order by sl.week_start)
                                from public.shopping_lists sl where sl.user_id = auth.uid()), '[]'),
    'feedback', coalesce((select jsonb_agg(jsonb_build_object(
                            'message', f.message, 'page', f.page, 'sent_at', f.created_at)
                          order by f.created_at)
                          from public.feedback f where f.user_id = auth.uid()), '[]'),
    'cooked', coalesce((select jsonb_agg(jsonb_build_object(
                          'recipe', r.title, 'cooked_on', c.cooked_on, 'scale', c.scale,
                          'rating', c.rating, 'note', c.note)
                        order by c.cooked_on, c.created_at)
                        from public.cooked_meals c join public.recipes r on r.id = c.recipe_id
                        where c.user_id = auth.uid()), '[]'),
    'favorite_recipes', coalesce((select jsonb_agg(jsonb_build_object(
                                    'recipe', r.title, 'how_often', f.frequency)
                                  order by r.title)
                                  from public.user_favorite_recipes f
                                  join public.recipes r on r.id = f.recipe_id
                                  where f.user_id = auth.uid()), '[]'),
    'pantry_suggestions_declined', coalesce((select jsonb_agg(i.name order by i.name)
                                             from public.user_pantry_dismissed d
                                             join public.ingredients i on i.id = d.ingredient_id
                                             where d.user_id = auth.uid()), '[]')
  )
$$;
