-- Feedback from beta testers: a message from inside the app, with the page
-- they were on. Read by the team with apps/api/scripts/read_feedback.py.

create table public.feedback (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  message text not null check (length(btrim(message)) between 1 and 2000),
  -- The app's path when it was sent ("/plan"), to see what it's about.
  page text check (length(page) <= 200),
  created_at timestamptz not null default now()
);

create index feedback_user_time on public.feedback (user_id, created_at);

alter table public.feedback enable row level security;

-- Users send their own feedback and see only what they sent. Nothing is
-- changed or deleted afterwards (except with the account).
create policy feedback_insert on public.feedback for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy feedback_select on public.feedback for select to authenticated
  using (user_id = (select auth.uid()));

revoke update, delete on public.feedback from anon, authenticated;

-- Up to 20 messages a day each, so a stuck button or a script can't flood it.
create function public.feedback_daily_limit() returns trigger
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('feedback:' || new.user_id::text));
  if (select count(*) from public.feedback
      where user_id = new.user_id and created_at > now() - interval '1 day') >= 20 then
    raise exception 'too much feedback today' using errcode = '54000';
  end if;
  return new;
end
$$;

create trigger feedback_daily_limit before insert on public.feedback
  for each row execute function public.feedback_daily_limit();

-- "Download my data" covers everything on the privacy page: now the
-- shopping list (TYL-18) and feedback too.
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
                          from public.feedback f where f.user_id = auth.uid()), '[]')
  )
$$;
