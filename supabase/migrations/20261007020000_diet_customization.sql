-- Dietary customization (TYL-32). Design notes: docs/data-model.md
--
--   * Hard rules filter recipes out: diet presets, extra exclusions, allergies.
--   * "May contain" marks uncertainty (Parmesan may use animal rennet, flour
--     tortillas may use lard). By default such recipes are shown with a
--     check-the-label note; users can choose to leave them out instead.
--   * Soft goals ("Meatless Mondays") and weights ("less red meat") steer the
--     planner and recommendations without hiding anything.

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------

-- New: pork (also tagged meat), animal_rennet, alcohol.
create or replace function public.valid_contains(cats text[]) returns boolean
language sql immutable as $$
  select cats <@ array[
    'meat', 'pork', 'poultry', 'fish', 'shellfish', 'gelatin', 'animal_rennet',
    'dairy', 'egg', 'honey',
    'gluten', 'tree_nut', 'peanut', 'soy', 'sesame',
    'alcohol'
  ]::text[]
$$;

-- Categories an ingredient might include depending on brand or recipe.
alter table public.ingredients
  add column may_contain text[] not null default '{}'
    check (public.valid_contains(may_contain));

insert into public.diets (slug, name, excludes) values
  ('no_red_meat', 'No red meat', '{meat}'),
  ('no_pork', 'No pork', '{pork}'),
  ('no_alcohol', 'No alcohol', '{alcohol}'),
  ('shellfish_free', 'Shellfish-free', '{shellfish}');

-- ---------------------------------------------------------------------------
-- User rules
-- ---------------------------------------------------------------------------

alter table public.profiles
  -- Extra categories to avoid on top of diet presets (e.g. {animal_rennet}).
  add column avoid_categories text[] not null default '{}'
    check (public.valid_contains(avoid_categories)),
  -- Off: recipes with "may contain" ingredients are shown with a check-the-label
  -- note. On: they're left out. Allergies are always strict.
  add column strict_may_contain boolean not null default false;

-- ---------------------------------------------------------------------------
-- Soft goals and weights
-- ---------------------------------------------------------------------------

-- "Meatless Mondays": diet vegetarian, days {1}, meal dinner.
-- "4 vegetarian dinners a week": diet vegetarian, per_week 4, meal dinner.
create table public.user_diet_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  diet_slug text not null references public.diets on update cascade,
  -- ISO weekdays, 1 = Monday.
  days smallint[] check (days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[] and cardinality(days) > 0),
  per_week smallint check (per_week between 1 and 21),
  meal text check (meal in ('breakfast', 'lunch', 'dinner', 'snack')),
  created_at timestamptz not null default now(),
  check ((days is null) <> (per_week is null))
);

create index user_diet_goals_user_idx on public.user_diet_goals (user_id);

-- Nudges for recommendations: -1 = strongly less, +1 = strongly more.
create table public.user_category_weights (
  user_id uuid not null references auth.users on delete cascade,
  category text not null check (public.valid_contains(array[category])),
  weight real not null check (weight between -1 and 1 and weight <> 0),
  primary key (user_id, category)
);

alter table public.user_diet_goals enable row level security;
alter table public.user_category_weights enable row level security;

create policy "Own rows" on public.user_diet_goals for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own rows" on public.user_category_weights for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Rule checks
-- ---------------------------------------------------------------------------

-- Status of a recipe against a set of excluded categories:
--   fits         every required line has an option that clearly fits
--   check_label  fits only if an ingredient that *may* contain an excluded
--                category is bought without it (e.g. tortillas without lard)
--   unknown      some line can't be judged (unmapped ingredient)
--   excluded     some line has no option that fits
-- With p_strict, check_label becomes excluded.
create function public.recipe_rule_status(p_recipe_id uuid, p_excludes text[], p_strict boolean)
returns text
language sql stable as $$
  with options as (
    select
      ri.line_no,
      i.id is null as unknown,
      i.id is not null and not (i.contains && p_excludes) and not (i.may_contain && p_excludes) as clear,
      i.id is not null and not (i.contains && p_excludes) and (i.may_contain && p_excludes) as maybe
    from public.recipe_ingredients ri
    left join public.ingredients i on i.id = ri.ingredient_id
    where ri.recipe_id = p_recipe_id and not ri.is_optional
  ),
  lines as (
    select
      line_no,
      case
        when bool_or(clear) then 'fits'
        when bool_or(maybe) then 'check_label'
        when bool_or(unknown) then 'unknown'
        else 'excluded'
      end as status
    from options
    group by line_no
  ),
  overall as (
    select case
      when exists (select 1 from lines where status = 'excluded') then 'excluded'
      when exists (select 1 from lines where status = 'unknown') then 'unknown'
      when exists (select 1 from lines where status = 'check_label') then 'check_label'
      else 'fits'
    end as status
  )
  select case when p_strict and status = 'check_label' then 'excluded' else status end
  from overall
$$;

-- Diet labels on recipes: only "fits" earns the label.
create or replace function public.recipe_meets_diet(p_recipe_id uuid, p_diet text) returns boolean
language sql stable as $$
  select case public.recipe_rule_status(p_recipe_id, d.excludes, false)
    when 'fits' then true
    when 'excluded' then false
    else null
  end
  from (select 1) as one
  left join public.diets d on d.slug = p_diet
  where d.slug is not null
$$;

-- How a recipe fits everything a user has ruled out: their diet presets, extra
-- exclusions (using their strictness setting) and allergies (always strict).
-- Returns the worse of the two statuses.
create function public.recipe_fit_for_user(p_recipe_id uuid, p_user_id uuid) returns text
language sql stable as $$
  with rules as (
    select
      coalesce(p.avoid_categories, '{}') || coalesce(
        (select array_agg(distinct c)
           from public.user_diets ud
           join public.diets d on d.slug = ud.diet_slug,
           unnest(d.excludes) as c
          where ud.user_id = p_user_id),
        '{}'
      ) as excludes,
      coalesce(p.allergens, '{}') as allergens,
      coalesce(p.strict_may_contain, false) as strict
    from (select 1) as one
    left join public.profiles p on p.user_id = p_user_id
  ),
  statuses as (
    select public.recipe_rule_status(p_recipe_id, excludes, strict) as s from rules
    union all
    select public.recipe_rule_status(p_recipe_id, allergens, true) from rules
  )
  select case
    when bool_or(s = 'excluded') then 'excluded'
    when bool_or(s = 'unknown') then 'unknown'
    when bool_or(s = 'check_label') then 'check_label'
    else 'fits'
  end
  from statuses
$$;
