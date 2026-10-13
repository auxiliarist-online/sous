-- Which Harris Teeter (Kroger API) product Sous buys for each ingredient
-- (TYL-80). Only our matching decision is stored: the Kroger product id.
-- Kroger's terms (§5e.1) don't allow keeping their content (names, sizes,
-- prices), so prices are fetched live when a plan is priced, and used for
-- that request only. Written by scripts/match_kroger.py; read by the API.

-- Tyler's store: Harris Teeter, Village at Chestnut Street, Asheville.
insert into public.stores (chain_slug, name, address, zip, latitude, longitude, external_location_id)
values ('harris_teeter', 'Harris Teeter – Village at Chestnut Street',
        '136 Merrimon Ave, Asheville, NC', '28801', 35.6042089, -82.5539601, '09700348')
on conflict (chain_slug, external_location_id) do nothing;

create table public.kroger_product_matches (
  ingredient_id uuid not null references public.ingredients on delete cascade,
  store_id uuid not null references public.stores on delete cascade,
  product_id text not null check (product_id ~ '^[0-9]{6,20}$'),
  -- auto = picked by the matcher; manual = set in data/kroger_overrides.csv.
  source text not null default 'auto' check (source in ('auto', 'manual')),
  matched_at timestamptz not null default now(),
  primary key (ingredient_id, store_id)
);

-- Catalog data written by the API only: RLS with no policies.
alter table public.kroger_product_matches enable row level security;
