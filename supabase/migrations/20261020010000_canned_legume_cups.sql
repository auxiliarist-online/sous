-- TYL-102. Cooked beans in a recipe are bought canned, and a 15 oz can drains
-- to about 1.5 cups. Measured against the can's weight (425 g), that's about
-- 283 g a cup, so "3 cups cooked beans" buys 2 cans and "4 cups" buys 3. The
-- density of the beans themselves (about 170 g a cup) undercounted cans.
update public.ingredients
set grams_per_cup = 283
where name in (
  'canned black beans', 'canned butter beans', 'canned chickpeas', 'canned kidney beans',
  'canned lentils', 'canned pinto beans', 'canned white beans'
)
  and package_quantity = 15 and package_unit = 'oz';

-- "3 cups cooked beans" with no kind named: canned white beans, the usual
-- default in a recipe that doesn't say.
insert into public.ingredient_aliases (alias, ingredient_id)
select v.alias, i.id
from (values
  ('canned beans', 'canned white beans'),
  ('canned cannellini beans', 'canned white beans'),
  ('canned garbanzo beans', 'canned chickpeas')
) as v(alias, canonical)
join public.ingredients i on lower(i.name) = v.canonical
on conflict (alias) do nothing;
