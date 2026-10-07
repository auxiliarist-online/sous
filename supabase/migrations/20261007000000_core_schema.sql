-- Sous core schema (TYL-7). Design notes: docs/data-model.md
--
-- Conventions:
--   * Money is integer cents.
--   * Small fixed sets are text + CHECK; sets that carry data (diets, cuisines,
--     store chains) are lookup tables keyed by slug.
--   * Catalog tables are readable by everyone and written only by the API
--     (service role, which bypasses RLS). User tables are owned via auth.uid().

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end
$$;

-- What an ingredient can contain. Diets and allergies are defined in terms of
-- these categories, so diet tagging is derived from ingredients, not trusted
-- from the recipe source.
create function public.valid_contains(cats text[]) returns boolean
language sql immutable as $$
  select cats <@ array[
    'meat', 'poultry', 'fish', 'shellfish', 'gelatin',
    'dairy', 'egg', 'honey',
    'gluten', 'tree_nut', 'peanut', 'soy', 'sesame'
  ]::text[]
$$;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

create table public.diets (
  slug text primary key,
  name text not null,
  -- Ingredient categories that break this diet.
  excludes text[] not null check (public.valid_contains(excludes))
);

create table public.cuisines (
  slug text primary key,
  name text not null
);

-- ---------------------------------------------------------------------------
-- Ingredients (canonical)
-- ---------------------------------------------------------------------------

create table public.ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  aisle text not null default 'other' check (aisle in (
    'produce', 'dairy_eggs', 'meat_seafood', 'bakery', 'pantry', 'spices',
    'frozen', 'beverages', 'international', 'other'
  )),
  default_unit text,
  contains text[] not null default '{}' check (public.valid_contains(contains)),
  -- Optional conversions so the shopping list can merge volume, weight and counts.
  grams_per_cup numeric check (grams_per_cup > 0),
  grams_per_each numeric check (grams_per_each > 0),
  created_at timestamptz not null default now()
);

create unique index ingredients_name_key on public.ingredients (lower(name));

-- Synonyms: "scallion" -> green onion. Stored lowercase.
create table public.ingredient_aliases (
  alias text primary key check (alias = lower(alias)),
  ingredient_id uuid not null references public.ingredients on delete cascade
);

create index ingredient_aliases_ingredient_idx on public.ingredient_aliases (ingredient_id);

-- ---------------------------------------------------------------------------
-- Recipes
-- ---------------------------------------------------------------------------

create table public.recipe_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text not null unique,
  homepage_url text,
  -- link_only: store metadata + ingredients, link out for instructions.
  -- public_domain / licensed: instructions may be stored and shown.
  content_rights text not null default 'link_only'
    check (content_rights in ('link_only', 'public_domain', 'licensed')),
  crawl_enabled boolean not null default false,
  last_crawled_at timestamptz,
  -- Set when a site asks to be removed; the crawler skips it and its recipes are hidden.
  opted_out_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.recipe_sources on delete set null,
  -- Canonical URL. Null only for recipes a user typed in by hand.
  source_url text unique,
  title text not null,
  summary text,
  image_url text,
  servings numeric check (servings > 0),
  prep_minutes integer check (prep_minutes >= 0),
  cook_minutes integer check (cook_minutes >= 0),
  total_minutes integer check (total_minutes >= 0),
  -- Only stored when the source's content_rights allow it, or for a user's own private recipe.
  instructions jsonb,
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  -- needs_review: parsed but not yet trusted (e.g. unmapped ingredients); not shown publicly.
  status text not null default 'needs_review'
    check (status in ('active', 'needs_review', 'hidden', 'removed')),
  added_by uuid references auth.users on delete set null,
  search tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index recipes_source_idx on public.recipes (source_id);
create index recipes_added_by_idx on public.recipes (added_by);
create index recipes_search_idx on public.recipes using gin (search);

create trigger recipes_set_updated_at before update on public.recipes
  for each row execute function public.set_updated_at();

create table public.recipe_cuisines (
  recipe_id uuid not null references public.recipes on delete cascade,
  cuisine_slug text not null references public.cuisines on update cascade,
  primary key (recipe_id, cuisine_slug)
);

create index recipe_cuisines_cuisine_idx on public.recipe_cuisines (cuisine_slug);

-- One row per ingredient option. Rows that share a line_no are alternatives
-- ("2 tbsp fish sauce (or soy sauce)" -> two rows, line_no 3, option_no 1 and 2).
create table public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes on delete cascade,
  line_no smallint not null check (line_no >= 0),
  option_no smallint not null default 1 check (option_no >= 1),
  raw_text text not null,
  section text,
  -- Null until the parsed name is mapped to a canonical ingredient.
  ingredient_id uuid references public.ingredients on delete set null,
  quantity numeric check (quantity >= 0),
  quantity_max numeric check (quantity_max >= quantity),
  unit text,
  preparation text,
  note text,
  is_optional boolean not null default false,
  parse_confidence real check (parse_confidence between 0 and 1),
  needs_review boolean not null default false,
  unique (recipe_id, line_no, option_no)
);

create index recipe_ingredients_ingredient_idx on public.recipe_ingredients (ingredient_id);

create table public.recipe_diets (
  recipe_id uuid not null references public.recipes on delete cascade,
  diet_slug text not null references public.diets on update cascade,
  -- derived: from recipe_meets_diet(); publisher: from the source's JSON-LD; manual: a reviewer.
  source text not null default 'derived' check (source in ('derived', 'publisher', 'manual')),
  primary key (recipe_id, diet_slug)
);

create index recipe_diets_diet_idx on public.recipe_diets (diet_slug);

-- True if every required ingredient line has at least one option that fits the
-- diet. False if some line has no fitting option. Null if we can't tell (a line
-- has no fitting option but has an unmapped one), so the recipe isn't labeled.
-- Optional lines are ignored; the planner should drop ones that break the diet.
create function public.recipe_meets_diet(p_recipe_id uuid, p_diet text) returns boolean
language sql stable as $$
  with excl as (
    select excludes from public.diets where slug = p_diet
  ),
  lines as (
    select
      ri.line_no,
      bool_or(i.id is not null and not (i.contains && (select excludes from excl))) as has_ok_option,
      bool_or(i.id is null) as has_unknown
    from public.recipe_ingredients ri
    left join public.ingredients i on i.id = ri.ingredient_id
    where ri.recipe_id = p_recipe_id and not ri.is_optional
    group by ri.line_no
  )
  select case
    when not exists (select 1 from excl) then null
    when exists (select 1 from lines where not has_ok_option and not has_unknown) then false
    when exists (select 1 from lines where not has_ok_option) then null
    else true
  end
$$;

-- ---------------------------------------------------------------------------
-- Users and preferences
-- ---------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  display_name text,
  weekly_budget_cents integer check (weekly_budget_cents > 0),
  household_size smallint not null default 1 check (household_size between 1 and 20),
  home_zip text check (home_zip ~ '^[0-9]{5}$'),
  -- Hard exclusions by category (e.g. {peanut, tree_nut}).
  allergens text[] not null default '{}' check (public.valid_contains(allergens)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.user_diets (
  user_id uuid not null references auth.users on delete cascade,
  diet_slug text not null references public.diets on update cascade,
  primary key (user_id, diet_slug)
);

create table public.user_favorite_cuisines (
  user_id uuid not null references auth.users on delete cascade,
  cuisine_slug text not null references public.cuisines on update cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, cuisine_slug)
);

create table public.user_favorite_ingredients (
  user_id uuid not null references auth.users on delete cascade,
  ingredient_id uuid not null references public.ingredients on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, ingredient_id)
);

-- Specific ingredients to leave out (e.g. cilantro). Allergies by category live on profiles.
create table public.user_disliked_ingredients (
  user_id uuid not null references auth.users on delete cascade,
  ingredient_id uuid not null references public.ingredients on delete cascade,
  primary key (user_id, ingredient_id)
);

create table public.user_saved_recipes (
  user_id uuid not null references auth.users on delete cascade,
  recipe_id uuid not null references public.recipes on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, recipe_id)
);

-- "Already have it": staples left off generated shopping lists.
create table public.user_pantry_staples (
  user_id uuid not null references auth.users on delete cascade,
  ingredient_id uuid not null references public.ingredients on delete cascade,
  primary key (user_id, ingredient_id)
);

-- ---------------------------------------------------------------------------
-- Stores and products
-- ---------------------------------------------------------------------------

create table public.store_chains (
  slug text primary key,
  name text not null,
  -- Where live prices come from. manual = user entries + baseline estimates only.
  price_source text not null default 'manual' check (price_source in ('kroger_api', 'manual'))
);

create table public.stores (
  id uuid primary key default gen_random_uuid(),
  chain_slug text not null references public.store_chains on update cascade,
  name text not null,
  address text,
  zip text check (zip ~ '^[0-9]{5}$'),
  latitude numeric,
  longitude numeric,
  -- The price source's ID for this store, e.g. a Kroger locationId.
  external_location_id text,
  -- Null for shared stores; set when a user adds their own (e.g. a farmers market stall).
  created_by uuid references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  unique (chain_slug, external_location_id)
);

create index stores_created_by_idx on public.stores (created_by);

create table public.user_stores (
  user_id uuid not null references auth.users on delete cascade,
  store_id uuid not null references public.stores on delete cascade,
  is_primary boolean not null default false,
  primary key (user_id, store_id)
);

create unique index user_stores_one_primary on public.user_stores (user_id) where is_primary;

create table public.store_products (
  id uuid primary key default gen_random_uuid(),
  chain_slug text not null references public.store_chains on update cascade,
  external_product_id text,
  upc text,
  name text not null,
  brand text,
  size_quantity numeric check (size_quantity > 0),
  size_unit text,
  ingredient_id uuid references public.ingredients on delete set null,
  created_at timestamptz not null default now(),
  unique (chain_slug, external_product_id)
);

create index store_products_ingredient_idx on public.store_products (ingredient_id);

-- The product a user buys for an ingredient at a given store.
create table public.user_product_choices (
  user_id uuid not null references auth.users on delete cascade,
  ingredient_id uuid not null references public.ingredients on delete cascade,
  store_id uuid not null references public.stores on delete cascade,
  store_product_id uuid not null references public.store_products on delete cascade,
  primary key (user_id, ingredient_id, store_id)
);

-- ---------------------------------------------------------------------------
-- Prices
-- ---------------------------------------------------------------------------

-- Every price from every source in one table. The app picks per ingredient and
-- store in this order: user > store_api > deal > baseline (see TYL-13, TYL-28).
-- A row means "price_cents buys quantity of unit", e.g. 249 for 14 oz.
create table public.prices (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in (
    'user', 'store_api', 'deal', 'baseline_bls', 'baseline_usda', 'seed'
  )),
  ingredient_id uuid references public.ingredients on delete cascade,
  store_product_id uuid references public.store_products on delete cascade,
  -- Null for regional or national baselines.
  store_id uuid references public.stores on delete cascade,
  region text,
  -- Set only for user-entered prices, which stay private to that user.
  user_id uuid references auth.users on delete cascade,
  price_cents integer not null check (price_cents >= 0),
  quantity numeric not null check (quantity > 0),
  unit text not null,
  -- Deals: the price before the discount, and conditions like "digital coupon" or "BOGO".
  regular_price_cents integer check (regular_price_cents >= 0),
  deal_terms text,
  valid_from date,
  valid_to date,
  observed_at timestamptz not null default now(),
  check (ingredient_id is not null or store_product_id is not null),
  check ((source = 'user') = (user_id is not null)),
  check (source <> 'deal' or valid_to is not null),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create index prices_ingredient_store_idx on public.prices (ingredient_id, store_id);
create index prices_product_idx on public.prices (store_product_id);
create index prices_user_idx on public.prices (user_id) where user_id is not null;

-- ---------------------------------------------------------------------------
-- Meal plans
-- ---------------------------------------------------------------------------

create table public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  week_start date not null,
  -- Budget for this week; defaults from the profile when the plan is created.
  budget_cents integer check (budget_cents > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, week_start)
);

create trigger meal_plans_set_updated_at before update on public.meal_plans
  for each row execute function public.set_updated_at();

create table public.meal_plan_entries (
  id uuid primary key default gen_random_uuid(),
  meal_plan_id uuid not null references public.meal_plans on delete cascade,
  -- Recipes are hidden or marked removed, never deleted, so plans keep their history.
  recipe_id uuid not null references public.recipes on delete restrict,
  servings numeric not null check (servings > 0),
  planned_for date,
  meal text check (meal in ('breakfast', 'lunch', 'dinner', 'snack')),
  position smallint not null default 0,
  created_at timestamptz not null default now()
);

create index meal_plan_entries_plan_idx on public.meal_plan_entries (meal_plan_id);
create index meal_plan_entries_recipe_idx on public.meal_plan_entries (recipe_id);

-- ---------------------------------------------------------------------------
-- Shopping lists
-- ---------------------------------------------------------------------------

create table public.shopping_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  meal_plan_id uuid references public.meal_plans on delete set null,
  name text not null default 'Shopping list',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index shopping_lists_user_idx on public.shopping_lists (user_id);

create trigger shopping_lists_set_updated_at before update on public.shopping_lists
  for each row execute function public.set_updated_at();

-- Generated from the plan, then freely edited. Prices are a snapshot taken when
-- the list was built, so the total doesn't shift while shopping.
create table public.shopping_list_items (
  id uuid primary key default gen_random_uuid(),
  shopping_list_id uuid not null references public.shopping_lists on delete cascade,
  ingredient_id uuid references public.ingredients on delete set null,
  store_id uuid references public.stores on delete set null,
  store_product_id uuid references public.store_products on delete set null,
  name text not null,
  quantity numeric check (quantity >= 0),
  unit text,
  aisle text,
  est_price_cents integer check (est_price_cents >= 0),
  price_source text check (price_source in (
    'user', 'store_api', 'deal', 'baseline_bls', 'baseline_usda', 'seed'
  )),
  is_manual boolean not null default false,
  checked_at timestamptz,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index shopping_list_items_list_idx on public.shopping_list_items (shopping_list_id);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.diets enable row level security;
alter table public.cuisines enable row level security;
alter table public.ingredients enable row level security;
alter table public.ingredient_aliases enable row level security;
alter table public.recipe_sources enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_cuisines enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.recipe_diets enable row level security;
alter table public.profiles enable row level security;
alter table public.user_diets enable row level security;
alter table public.user_favorite_cuisines enable row level security;
alter table public.user_favorite_ingredients enable row level security;
alter table public.user_disliked_ingredients enable row level security;
alter table public.user_saved_recipes enable row level security;
alter table public.user_pantry_staples enable row level security;
alter table public.store_chains enable row level security;
alter table public.stores enable row level security;
alter table public.user_stores enable row level security;
alter table public.store_products enable row level security;
alter table public.user_product_choices enable row level security;
alter table public.prices enable row level security;
alter table public.meal_plans enable row level security;
alter table public.meal_plan_entries enable row level security;
alter table public.shopping_lists enable row level security;
alter table public.shopping_list_items enable row level security;

-- Catalog: readable by everyone, written only by the API (service role).
create policy "Public read" on public.diets for select to anon, authenticated using (true);
create policy "Public read" on public.cuisines for select to anon, authenticated using (true);
create policy "Public read" on public.ingredients for select to anon, authenticated using (true);
create policy "Public read" on public.ingredient_aliases for select to anon, authenticated using (true);
create policy "Public read" on public.recipe_sources for select to anon, authenticated using (true);
create policy "Public read" on public.store_chains for select to anon, authenticated using (true);
create policy "Public read" on public.store_products for select to anon, authenticated using (true);

-- Recipes: public active ones, plus anything the user added.
create policy "Read visible recipes" on public.recipes for select to anon, authenticated
  using (
    (visibility = 'public' and status = 'active')
    or added_by = (select auth.uid())
  );

-- Child rows follow their recipe: the subquery is itself filtered by the recipes policy.
create policy "Read with recipe" on public.recipe_cuisines for select to anon, authenticated
  using (exists (select 1 from public.recipes r where r.id = recipe_id));
create policy "Read with recipe" on public.recipe_ingredients for select to anon, authenticated
  using (exists (select 1 from public.recipes r where r.id = recipe_id));
create policy "Read with recipe" on public.recipe_diets for select to anon, authenticated
  using (exists (select 1 from public.recipes r where r.id = recipe_id));

-- Stores: shared ones for everyone; a user's own stores only for them.
create policy "Read stores" on public.stores for select to anon, authenticated
  using (created_by is null or created_by = (select auth.uid()));
create policy "Manage own stores" on public.stores for all to authenticated
  using (created_by = (select auth.uid()))
  with check (created_by = (select auth.uid()));

-- Prices: shared prices for everyone; user-entered prices only for their owner.
create policy "Read prices" on public.prices for select to anon, authenticated
  using (user_id is null or user_id = (select auth.uid()));
create policy "Manage own prices" on public.prices for all to authenticated
  using (user_id = (select auth.uid()))
  with check (source = 'user' and user_id = (select auth.uid()));

-- User-owned tables.
create policy "Own rows" on public.profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own rows" on public.user_diets for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own rows" on public.user_favorite_cuisines for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own rows" on public.user_favorite_ingredients for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own rows" on public.user_disliked_ingredients for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own rows" on public.user_saved_recipes for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own rows" on public.user_pantry_staples for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own rows" on public.user_stores for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own rows" on public.user_product_choices for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own rows" on public.meal_plans for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own rows" on public.shopping_lists for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Children of user-owned tables follow their parent.
create policy "Own plan entries" on public.meal_plan_entries for all to authenticated
  using (exists (
    select 1 from public.meal_plans p
    where p.id = meal_plan_id and p.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.meal_plans p
    where p.id = meal_plan_id and p.user_id = (select auth.uid())
  ));
create policy "Own list items" on public.shopping_list_items for all to authenticated
  using (exists (
    select 1 from public.shopping_lists l
    where l.id = shopping_list_id and l.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.shopping_lists l
    where l.id = shopping_list_id and l.user_id = (select auth.uid())
  ));

-- ---------------------------------------------------------------------------
-- Seed reference data
-- ---------------------------------------------------------------------------

insert into public.diets (slug, name, excludes) values
  ('vegetarian', 'Vegetarian', '{meat,poultry,fish,shellfish,gelatin}'),
  ('vegan', 'Vegan', '{meat,poultry,fish,shellfish,gelatin,dairy,egg,honey}'),
  ('pescatarian', 'Pescatarian', '{meat,poultry,gelatin}'),
  ('gluten_free', 'Gluten-free', '{gluten}'),
  ('dairy_free', 'Dairy-free', '{dairy}'),
  ('egg_free', 'Egg-free', '{egg}'),
  ('nut_free', 'Nut-free', '{tree_nut,peanut}');

insert into public.cuisines (slug, name) values
  ('american', 'American'),
  ('southern', 'Southern'),
  ('mexican', 'Mexican'),
  ('latin_american', 'Latin American'),
  ('caribbean', 'Caribbean'),
  ('italian', 'Italian'),
  ('french', 'French'),
  ('spanish', 'Spanish'),
  ('greek', 'Greek'),
  ('mediterranean', 'Mediterranean'),
  ('middle_eastern', 'Middle Eastern'),
  ('north_african', 'North African'),
  ('ethiopian', 'Ethiopian'),
  ('west_african', 'West African'),
  ('indian', 'Indian'),
  ('chinese', 'Chinese'),
  ('japanese', 'Japanese'),
  ('korean', 'Korean'),
  ('thai', 'Thai'),
  ('vietnamese', 'Vietnamese'),
  ('filipino', 'Filipino'),
  ('indonesian', 'Indonesian'),
  ('eastern_european', 'Eastern European'),
  ('british_irish', 'British & Irish');

insert into public.store_chains (slug, name, price_source) values
  ('harris_teeter', 'Harris Teeter', 'kroger_api'),
  ('trader_joes', 'Trader Joe''s', 'manual'),
  ('aldi', 'Aldi', 'manual'),
  ('ingles', 'Ingles', 'manual'),
  ('coop', 'Co-op', 'manual'),
  ('farmers_market', 'Farmers market', 'manual'),
  ('other', 'Other', 'manual');
