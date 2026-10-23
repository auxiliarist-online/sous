-- TYL-66. How much variety the user wants, in Preferences under "Variety":
-- mix up main proteins, cuisines and cooking styles (at most two dinners of
-- each a week), and how many weeks before a recipe is suggested again (0:
-- don't mind repeats). Favorites come back at their own rhythm regardless.
-- "Plan my week" reads these, and each recipe's tags (a style can be a tag),
-- from plan_draft_pool().

alter table public.profiles
  add column mix_proteins boolean not null default true,
  add column mix_cuisines boolean not null default true,
  add column mix_styles boolean not null default true,
  add column repeat_weeks smallint not null default 3 check (repeat_weeks between 0 and 8);

-- As in 20261022010000_seasons.sql, plus the variety settings and tags.
create or replace function public.plan_draft_pool(p_user uuid, p_week date) returns jsonb
language plpgsql stable as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'plan_draft_pool is only callable by the API' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'cook_with_seasons', coalesce(
      (select p.cook_with_seasons from public.profiles p where p.user_id = p_user), false
    ),
    -- How much variety the user wants (TYL-66); the defaults with no profile.
    'variety', coalesce((
      select jsonb_build_object(
        'proteins', p.mix_proteins, 'cuisines', p.mix_cuisines,
        'styles', p.mix_styles, 'repeat_weeks', p.repeat_weeks)
      from public.profiles p where p.user_id = p_user
    ), jsonb_build_object('proteins', true, 'cuisines', true, 'styles', true, 'repeat_weeks', 3)),
    'candidates', coalesce((
    select jsonb_agg(jsonb_build_object(
      'recipe_id', r.id,
      'title', r.title,
      -- The user's own tags, which can name a cooking style ("soup").
      'tags', to_jsonb(coalesce(s.tags, '{}')),
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
      ), '[]'),
      -- Its seasonal produce (in season 8 months a year or fewer) that's in
      -- season the week planned, and how much isn't (TYL-70).
      'in_season', coalesce((
        select jsonb_agg(distinct s2.name)
        from public.recipe_seasonal(r.id, p_user, p_week) s2 where s2.in_season
      ), '[]'),
      'out_of_season', (
        select count(*) from public.recipe_seasonal(r.id, p_user, p_week) s2
        where not s2.in_season
      )
    ) order by s.created_at desc)
    from public.user_saved_recipes s
    join public.recipes r on r.id = s.recipe_id
    where s.user_id = p_user
      and ((r.visibility = 'public' and r.status = 'active') or r.added_by = p_user)
  ), '[]'));
end
$$;
