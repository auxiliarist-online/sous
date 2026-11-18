-- The Seasonal page (TYL-90): for each ingredient in season, a few recipes
-- that use it. The user's saved recipes come first, then those where it's a
-- main part of the dish (by weight), then by title. Runs as the user, so
-- only recipes they can see are offered (public ones and their own).
create function public.seasonal_recipes(p_ingredients uuid[], p_per integer default 4)
returns table (ingredient_id uuid, recipe_id uuid, title text, saved boolean)
language sql stable as $$
  select i.id, r.id, r.title, r.saved
  from unnest(p_ingredients) as i(id)
  cross join lateral (
    select rec.id, rec.title,
      exists (select 1 from public.user_saved_recipes s
              where s.recipe_id = rec.id and s.user_id = auth.uid()) as saved,
      -- The ingredient's share of the dish's known weight.
      coalesce(
        sum(ri.grams) filter (where ri.ingredient_id = i.id)
          / nullif(sum(ri.grams), 0),
        0) as share
    from public.recipes rec
    join public.recipe_ingredients ri on ri.recipe_id = rec.id
    where rec.id in (
        select x.recipe_id from public.recipe_ingredients x
        where x.ingredient_id = i.id and not x.is_optional and x.option_no = 1)
      and ri.option_no = 1 and not ri.is_optional
      and rec.status not in ('removed', 'hidden')
    group by rec.id, rec.title
    order by 3 desc, 4 desc, rec.title
    limit greatest(1, least(p_per, 12))
  ) r
$$;

grant execute on function public.seasonal_recipes(uuid[], integer) to anon, authenticated;
