-- A user may only save recipes they can already see: public, active ones, or
-- their own (TYL-45 security review).
--
-- Saving now happens from the browser (the Find page), and the "Read saved
-- web recipes" policy lets a user read any recipe with a source_url that they
-- have saved. With an unchecked insert, anyone who learned a private recipe's
-- id (say, another user's browser copy) could save it and then read it.
--
-- The check can't query recipes under RLS (that policy reads
-- user_saved_recipes, which would recurse), so it uses a security definer
-- function that looks at the recipe itself. Saves made by import_recipe()
-- (service role) are unaffected.
create function public.can_save_recipe(p_recipe uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.recipes r
    where r.id = p_recipe
      and ((r.visibility = 'public' and r.status = 'active') or r.added_by = auth.uid())
  )
$$;

revoke execute on function public.can_save_recipe(uuid) from public, anon;
grant execute on function public.can_save_recipe(uuid) to authenticated, service_role;

drop policy "Own rows" on public.user_saved_recipes;
create policy "Own rows" on public.user_saved_recipes for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.can_save_recipe(recipe_id));
