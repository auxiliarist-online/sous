-- Scallions and cilantro are bought by the bunch, but their hand-estimated
-- prices were stored per "each", which for scallions is one 15 g stalk: a
-- bunch came to $6.67 (TYL-84). Restate them per bunch, by weight, as
-- apps/api/data/seed_prices.csv now does.
update public.prices p set quantity = v.grams, unit = 'g'
from (values ('scallions', 100), ('cilantro', 60)) as v(name, grams)
join public.ingredients i on lower(i.name) = v.name
where p.ingredient_id = i.id and p.source = 'seed' and p.unit = 'each' and p.quantity = 1;
