-- The user's store (TYL-19), and their account: export and delete (TYL-74).

-- Kroger-family chains other than Harris Teeter (Kroger, Ralphs, Fred
-- Meyer...) sell Kroger's own brand: one chain here, one set of product matches.
insert into public.store_chains (slug, name, price_source)
values ('kroger', 'Kroger', 'kroger_api')
on conflict (slug) do nothing;

-- A user's own stores (a farm stand, say) can't claim a price source's
-- location id: those are shared stores, set up by the API. Otherwise a user
-- could create "Kroger, location 02900540" first, and everyone choosing that
-- store would be attached to (and renamed by) their row.
drop policy "Manage own stores" on public.stores;
create policy "Manage own stores" on public.stores for all to authenticated
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()) and external_location_id is null);

-- Make a Kroger-family store the user's store. The API calls it after checking
-- the store with Kroger; only the user's choice is kept (name, address, zip,
-- location id). Returns the store's id.
create function public.set_my_store(
  p_user uuid, p_chain text, p_name text, p_address text, p_zip text, p_location_id text
) returns uuid
language plpgsql as $$
declare
  v_store uuid;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'set_my_store is only callable by the API' using errcode = '42501';
  end if;
  -- A shared store already there is used as it is (its name may be our own).
  select id into v_store from public.stores
  where chain_slug = p_chain and external_location_id = p_location_id and created_by is null;
  if v_store is null then
    insert into public.stores (chain_slug, name, address, zip, external_location_id)
    values (p_chain, p_name, p_address, p_zip, p_location_id)
    returning id into v_store;
  end if;
  update public.user_stores set is_primary = false
  where user_id = p_user and is_primary and store_id <> v_store;
  insert into public.user_stores (user_id, store_id, is_primary)
  values (p_user, v_store, true)
  on conflict (user_id, store_id) do update set is_primary = true;
  return v_store;
end
$$;

revoke execute on function public.set_my_store(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.set_my_store(uuid, text, text, text, text, text)
  to service_role;

-- Everything Sous keeps about the signed-in user, as JSON (TYL-74: "Export my
-- data"). Runs as the user, so row-level security limits it to their rows.
create function public.export_my_data() returns jsonb
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
                        where us.user_id = auth.uid()), '[]')
  )
$$;

-- Delete the signed-in user's account and everything Sous keeps about them
-- (TYL-74). Their rows go with the auth user (every user table cascades);
-- recipes they typed in themselves are deleted too. Recipes they imported
-- from the web stay in the shared catalog, without them as the importer.
create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_recipes uuid[];
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select coalesce(array_agg(id), '{}') into v_recipes
  from public.recipes where added_by = v_user and source_url is null;
  delete from auth.users where id = v_user;
  -- Unless someone else somehow has one in a plan (plans hold on to recipes).
  delete from public.recipes r
  where r.id = any(v_recipes)
    and not exists (select 1 from public.meal_plan_entries e where e.recipe_id = r.id);
end
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
