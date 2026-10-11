-- Recipes often write the pasta shape with "pasta" after it ("fettuccine pasta").
-- Exact aliases rather than a general "drop the first word" rule, which would
-- turn "almond butter" into butter or "oat milk" into milk.
insert into public.ingredient_aliases (alias, ingredient_id)
select v.alias, i.id
from (values
  ('fettuccine pasta'), ('spaghetti pasta'), ('penne pasta'), ('rigatoni pasta'),
  ('fusilli pasta'), ('linguine pasta'), ('macaroni pasta'), ('farfalle pasta'),
  ('rotini pasta'), ('orzo pasta'), ('dried pasta'), ('short pasta'), ('long pasta')
) as v(alias)
join public.ingredients i on lower(i.name) = 'pasta'
on conflict (alias) do nothing;
