-- TYL-68. "Cooked it": what the user actually cooked, when, at what size, and
-- what they thought of it (a quick rating and a private note). It feeds the
-- recipe page ("Cooked 3 times, last on Oct 12"; "Your note: less salt"), the
-- user's history, and later variety, favorites and the pantry.

create table public.cooked_meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Deleting a user's own recipe (delete_my_account) takes its history with it.
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  -- The plan entry it was cooked from, if any; the history outlives the plan.
  plan_entry_id uuid references public.meal_plan_entries (id) on delete set null,
  cooked_on date not null default current_date,
  scale numeric not null default 1 check (scale > 0 and scale <= 10),
  rating text check (rating in ('down', 'up', 'love')),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);

create index cooked_meals_user_recipe on public.cooked_meals (user_id, recipe_id, cooked_on desc);
-- One "cooked" per plan entry: tapping twice doesn't count it twice.
create unique index cooked_meals_entry on public.cooked_meals (plan_entry_id)
  where plan_entry_id is not null;

alter table public.cooked_meals enable row level security;
-- Their own rows, for recipes they can see and from their own plans (the
-- subqueries run under row-level security: another user's recipe or plan
-- entry isn't found). Without the plan check, someone could claim another
-- user's entry and keep them from marking it cooked.
create policy "Own rows" on public.cooked_meals for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.recipes r where r.id = recipe_id)
    and (
      plan_entry_id is null
      or exists (select 1 from public.meal_plan_entries e where e.id = plan_entry_id)
    )
  );

grant select on public.cooked_meals to anon;
grant select, insert, update, delete on public.cooked_meals to authenticated, service_role;

-- The user's data export includes what they cooked.
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
    'pantry', coalesce((select jsonb_agg(jsonb_build_object('ingredient', i.name, 'status', up.status))
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
                        where c.user_id = auth.uid()), '[]')
  )
$$;
