-- Local food directory (TYL-69): farmers markets, co-ops, bakeries, butchers
-- and fish markets, starting with Buncombe County, NC. Kept apart from
-- `stores`, which are price sources (one primary store per user drives
-- Kroger pricing); a local place has opening hours and what it sells instead.
-- The places come from apps/api/data/local_places.csv, via
-- apps/api/scripts/build_local_places.py.

create table public.local_places (
  id uuid primary key default gen_random_uuid(),
  -- Stable key for the data file's upserts.
  slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name text not null,
  kind text not null check (kind in (
    'farmers_market', 'co_op', 'grocer', 'bakery', 'butcher', 'fish_market', 'farm_store'
  )),
  address text not null,
  town text not null,
  zip text not null check (zip ~ '^[0-9]{5}$'),
  latitude numeric not null check (latitude between -90 and 90),
  longitude numeric not null check (longitude between -180 and 180),
  -- What it sells, in terms the shopping list can match: ingredient aisles
  -- (produce, bread...) plus "groceries" for a full grocery.
  sells text[] not null default '{}' check (sells <@ array[
    'produce', 'eggs', 'dairy', 'meat', 'seafood', 'bread', 'honey', 'grains', 'groceries'
  ]::text[]),
  -- When it's open: [{"days": [6], "opens": "09:00", "closes": "12:00",
  -- "from": "04-04", "to": "11-28"}], days 0 (Sunday) to 6, local time, and
  -- an optional season by month-day (a winter season wraps the new year).
  hours jsonb not null default '[]' check (jsonb_typeof(hours) = 'array'),
  website text,
  -- Where the facts came from, and when they were checked.
  source_url text not null,
  checked_on date not null,
  created_at timestamptz not null default now()
);

alter table public.local_places enable row level security;
create policy "Anyone reads" on public.local_places for select to anon, authenticated
  using (true);
grant select on public.local_places to anon;
grant select, insert, update, delete on public.local_places to authenticated, service_role;

-- A user's favorite local places.
create table public.user_local_places (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  place_id uuid not null references public.local_places on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, place_id)
);

alter table public.user_local_places enable row level security;
create policy "Own rows" on public.user_local_places for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
grant select on public.user_local_places to anon;
grant select, insert, update, delete on public.user_local_places to authenticated, service_role;
