-- The user's own tags on their saved recipes (TYL-81): "weeknight", "for
-- guests". They live on the user's saved row, so they're private to them under
-- that table's row-level security, and go when the recipe is removed.

-- At most 20 tags, each 1 to 30 characters with no outer spaces, and no two
-- the same apart from case.
create function public.valid_tags(tags text[]) returns boolean
language sql immutable as $$
  select cardinality(tags) <= 20
    and coalesce(bool_and(length(t) between 1 and 30 and t = btrim(t)), true)
    and count(distinct lower(t)) = cardinality(tags)
  from unnest(tags) as t
$$;

alter table public.user_saved_recipes
  add column tags text[] not null default '{}'
  constraint user_saved_recipes_tags_valid check (public.valid_tags(tags));
