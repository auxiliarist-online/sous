-- "4½ cups fresh corn kernels" couldn't be priced: sweet corn kernels had no
-- cup weight to turn cups into pounds. USDA FDC 169998 ("Corn, sweet, yellow,
-- raw"): 145 g a cup, as corn on the cob already uses. Also in
-- apps/api/data/fdc_map.csv, so a rebuild of the weights keeps it.
update public.ingredients set grams_per_cup = 145
where lower(name) = 'sweet corn kernels' and grams_per_cup is null;
