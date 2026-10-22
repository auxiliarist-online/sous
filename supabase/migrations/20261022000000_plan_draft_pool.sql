-- TYL-65. "Plan my week": the recipes a draft can pick from. They're the user's
-- saved recipes they can still see, each with how it fits their rules
-- (recipe_fit_for_user), whether it's a favorite and how often (TYL-66), how
-- many weeks ago it was last planned or cooked (TYL-68), and its cuisines.
-- The API prices them with plan_cost_inputs() and drafts the week.
create function public.plan_draft_pool(p_user uuid, p_week date) returns jsonb
language plpgsql stable as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'plan_draft_pool is only callable by the API' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'recipe_id', r.id,
      'title', r.title,
      'fit', public.recipe_fit_for_user(r.id, p_user),
      'favorite', (select f.frequency from public.user_favorite_recipes f
                   where f.user_id = p_user and f.recipe_id = r.id),
      -- 0 is this week; null is not in the last 8 weeks.
      'weeks_ago', (
        select min(greatest(0, ceil((p_week - d)::numeric / 7)))::int
        from (
          select mp.week_start as d
          from public.meal_plan_entries e
          join public.meal_plans mp on mp.id = e.meal_plan_id
          where mp.user_id = p_user and e.recipe_id = r.id
            and mp.week_start between p_week - 56 and p_week - 7
          union all
          select c.cooked_on from public.cooked_meals c
          where c.user_id = p_user and c.recipe_id = r.id
            and c.cooked_on between p_week - 56 and p_week - 1
        ) had
      ),
      'cuisines', coalesce((
        select jsonb_agg(cu.name order by cu.name)
        from public.recipe_cuisines rc join public.cuisines cu on cu.slug = rc.cuisine_slug
        where rc.recipe_id = r.id
      ), '[]')
    ) order by s.created_at desc)
    from public.user_saved_recipes s
    join public.recipes r on r.id = s.recipe_id
    where s.user_id = p_user
      and ((r.visibility = 'public' and r.status = 'active') or r.added_by = p_user)
  ), '[]');
end
$$;

revoke execute on function public.plan_draft_pool(uuid, date) from public, anon, authenticated;
grant execute on function public.plan_draft_pool(uuid, date) to service_role;
