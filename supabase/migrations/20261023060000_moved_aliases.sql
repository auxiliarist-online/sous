-- TYL-60, round 4. Four names that were aliases of a looser match are now
-- ingredients of their own (20261023010000_ingredients_round_4.sql): halibut
-- (was white fish), palm sugar (coconut sugar), chana dal (split peas) and
-- malt vinegar (white vinegar). A name matches its own ingredient first, so
-- the old aliases only mislead; they go. Recipes pick the new ingredients up
-- when they're parsed again (apps/api/scripts/reparse_ingredients.py).

delete from public.ingredient_aliases a
using public.ingredients i
where a.ingredient_id = i.id
  and (a.alias, lower(i.name)) in (
    ('halibut', 'white fish'),
    ('palm sugar', 'coconut sugar'),
    ('chana dal', 'split peas'),
    ('malt vinegar', 'white vinegar')
  );
