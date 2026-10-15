-- The package estimates (20261014040000) were dated the day they were made,
-- 2026-10-13, and weeks are priced as of their Monday: the week of Oct 12
-- skipped them, so sour cream, cornmeal and the like showed no price. A hand
-- estimate has no start date; clear it.
update public.prices set valid_from = null
where source = 'seed' and region = 'asheville' and valid_from = date '2026-10-13';
