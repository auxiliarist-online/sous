-- The store product a user picked as the size of an item they typed on the
-- list (TYL-142): "eggs" bought as the 18 ct. Only Kroger's product id is
-- kept, never its name, size or price (their terms, §5e.1); the API prices it
-- live. Null is Sous's default package.
alter table public.shopping_list_items
  add column product_id text check (product_id ~ '^\d{1,20}$');
