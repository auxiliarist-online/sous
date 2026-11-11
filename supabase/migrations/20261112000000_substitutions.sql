-- Substitutions (TYL-77): swap an ingredient you're out of, or one your diet
-- rules out. The swaps come from apps/api/data/substitutions.csv, via
-- apps/api/scripts/build_substitutions.py.

create table public.substitutions (
  id uuid primary key default gen_random_uuid(),
  -- Stable key for the data file's upserts: "from > to", plus " + extras".
  key text not null unique,
  from_ingredient_id uuid not null references public.ingredients on delete cascade,
  to_ingredient_id uuid not null references public.ingredients on delete cascade,
  -- The recipe's amount times factor. With to_unit, it's to_unit per one
  -- per_unit of the recipe's ingredient ("1 tbsp flaxseed per egg");
  -- without, the recipe's own unit.
  factor numeric not null check (factor > 0),
  to_unit text,
  per_unit text,
  check ((to_unit is null) = (per_unit is null)),
  -- Small amounts of something else it needs (lemon juice for buttermilk).
  extras uuid[] not null default '{}',
  uses text not null check (uses in ('any', 'baking', 'cooking')),
  quality text not null check (quality in ('good', 'pinch')),
  note text not null,
  unique (id, from_ingredient_id)
);

create index substitutions_from_idx on public.substitutions (from_ingredient_id);

alter table public.substitutions enable row level security;
create policy "Anyone reads" on public.substitutions for select to anon, authenticated
  using (true);
grant select on public.substitutions to anon;
grant select, insert, update, delete on public.substitutions to authenticated, service_role;

-- The swaps a user chose for a recipe: one per ingredient.
create table public.user_recipe_swaps (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  recipe_id uuid not null references public.recipes on delete cascade,
  from_ingredient_id uuid not null references public.ingredients on delete cascade,
  substitution_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, recipe_id, from_ingredient_id),
  -- The swap is for that ingredient.
  foreign key (substitution_id, from_ingredient_id)
    references public.substitutions (id, from_ingredient_id) on delete cascade
);

alter table public.user_recipe_swaps enable row level security;
create policy "Own rows" on public.user_recipe_swaps for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.recipes r where r.id = recipe_id)
  );
grant select on public.user_recipe_swaps to anon;
grant select, insert, update, delete on public.user_recipe_swaps to authenticated, service_role;
