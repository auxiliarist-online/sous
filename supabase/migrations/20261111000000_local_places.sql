-- Local food directory (TYL-69): farmers markets, co-ops, bakeries, butchers
-- and fish markets, starting with Buncombe County, NC. Kept apart from
-- `stores`, which are price sources (one primary store per user drives
-- Kroger pricing); a local place has opening hours and what it sells instead.
-- The places come from apps/api/data/local_places.csv, via
-- apps/api/scripts/build_local_places.py.

create table public.local_places (
  id uuid primary key default gen_random_uuid(),
  -- Stable key for the data file's upserts.
  slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name text not null,
  kind text not null check (kind in (
    'farmers_market', 'co_op', 'grocer', 'bakery', 'butcher', 'fish_market', 'farm_store'
  )),
  address text not null,
  town text not null,
  zip text not null check (zip ~ '^[0-9]{5}$'),
  latitude numeric not null check (latitude between -90 and 90),
  longitude numeric not null check (longitude between -180 and 180),
  -- What it sells, in terms the shopping list can match: ingredient aisles
  -- (produce, bread...) plus "groceries" for a full grocery.
  sells text[] not null default '{}' check (sells <@ array[
    'produce', 'eggs', 'dairy', 'meat', 'seafood', 'bread', 'honey', 'grains', 'groceries'
  ]::text[]),
  -- When it's open: [{"days": [6], "opens": "09:00", "closes": "12:00",
  -- "from": "04-04", "to": "11-28"}], days 0 (Sunday) to 6, local time, and
  -- an optional season by month-day (a winter season wraps the new year).
  hours jsonb not null default '[]' check (jsonb_typeof(hours) = 'array'),
  website text,
  -- Where the facts came from, and when they were checked.
  source_url text not null,
  checked_on date not null,
  created_at timestamptz not null default now()
);

alter table public.local_places enable row level security;
create policy "Anyone reads" on public.local_places for select to anon, authenticated
  using (true);
grant select on public.local_places to anon;
grant select, insert, update, delete on public.local_places to authenticated, service_role;

-- A user's favorite local places.
create table public.user_local_places (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  place_id uuid not null references public.local_places on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, place_id)
);

alter table public.user_local_places enable row level security;
create policy "Own rows" on public.user_local_places for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
grant select on public.user_local_places to anon;
grant select, insert, update, delete on public.user_local_places to authenticated, service_role;

-- Export my data (TYL-74) includes favorite local places.
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
    'cuisine_corrections', coalesce((select jsonb_agg(jsonb_build_object(
                                       'recipe', r.title, 'cuisine', c.cuisine_slug))
                                     from public.user_recipe_cuisines c
                                     join public.recipes r on r.id = c.recipe_id
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
                                             where d.user_id = auth.uid()), '[]'),
    'local_places', coalesce((select jsonb_agg(lp.name order by lp.name)
                              from public.user_local_places u
                              join public.local_places lp on lp.id = u.place_id
                              where u.user_id = auth.uid()), '[]')
  )
$$;
