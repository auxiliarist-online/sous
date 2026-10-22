-- TYL-70. Seasonal produce, by region. The national baseline ("US") is the
-- USDA SNAP-Ed Seasonal Produce Guide; a state with its own chart ("NC": the
-- NC Department of Agriculture's availability chart) has rows of its own.
-- A user's region is their home zip's state when it has rows, else "US"
-- (season_region()). Rows come from apps/api/data/seasonality.csv
-- (scripts/build_seasonality.py), in the next migration.

create table public.ingredient_seasons (
  ingredient_id uuid not null references public.ingredients (id) on delete cascade,
  region text not null check (region ~ '^(US|[A-Z]{2})$'),
  months smallint[] not null
    check (cardinality(months) between 1 and 12 and months <@ array[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[]),
  primary key (ingredient_id, region)
);

alter table public.ingredient_seasons enable row level security;
-- Catalog data: anyone can read it; only the API's migrations write it.
create policy "Anyone reads" on public.ingredient_seasons for select to anon, authenticated
  using (true);

grant select on public.ingredient_seasons to anon;
grant select, insert, update, delete on public.ingredient_seasons to authenticated, service_role;

-- The region a zip code's seasons come from: its state where Sous has that
-- state's chart, else the national guide. Add a state's zip range here with
-- its rows.
create function public.season_region(p_zip text) returns text
language sql immutable as $$
  select case
    when p_zip ~ '^(27|28)[0-9]{3}$' then 'NC'
    else 'US'
  end
$$;

-- A user's seasons: for each ingredient, their region's months if there are
-- any, else the national ones.
create function public.user_seasons(p_user uuid)
returns table (ingredient_id uuid, name text, months smallint[])
language sql stable as $$
  with region as (
    select public.season_region((select home_zip from public.profiles where user_id = p_user)) as r
  )
  select distinct on (s.ingredient_id) s.ingredient_id, i.name, s.months
  from public.ingredient_seasons s
  join public.ingredients i on i.id = s.ingredient_id
  where s.region in ((select r from region), 'US')
  order by s.ingredient_id, (s.region = 'US')
$$;

-- What the signed-in user's seasons are, for the web app.
create function public.my_seasons() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'ingredient_id', s.ingredient_id, 'name', s.name, 'months', s.months
  ) order by s.name), '[]')
  from public.user_seasons(auth.uid()) s
$$;

revoke execute on function public.my_seasons() from public, anon;
grant execute on function public.my_seasons() to authenticated;

-- A recipe's seasonal produce (in season 8 months a year or fewer: herbs and
-- onions aren't news), and whether each is in season in a given week.
create function public.recipe_seasonal(p_recipe uuid, p_user uuid, p_week date)
returns table (name text, in_season boolean)
language sql stable as $$
  select distinct s.name, extract(month from p_week + 3)::smallint = any(s.months)
  from public.recipe_ingredients ri
  join public.user_seasons(p_user) s on s.ingredient_id = ri.ingredient_id
  where ri.recipe_id = p_recipe and ri.option_no = 1 and not ri.is_optional
    and cardinality(s.months) <= 8
$$;

-- "Cook with the seasons": the user turns up how much "Plan my week" favors
-- what's in season.
alter table public.profiles add column cook_with_seasons boolean not null default false;

-- The draft pool, now with each recipe's produce in and out of season, and
-- the user's setting.
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
    'candidates', coalesce((
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
