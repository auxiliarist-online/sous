-- NHLBI's healthy eating recipes (TYL-42): federal works, public domain
-- unless noted (https://www.nhlbi.nih.gov/about/contact/trademark-branding-and-logo).
-- USDA's own recipe sites turn automated readers away or need a login, so
-- NIH's are the federal recipes Sous imports. Steps are stored and shown,
-- credited to NHLBI; images are never copied.
insert into public.recipe_sources (
  name, domain, homepage_url, content_rights, crawl_enabled,
  license_name, license_url, attribution, crawl_notes
)
values (
  'NHLBI Healthy Eating Recipes',
  'www.nhlbi.nih.gov',
  'https://www.nhlbi.nih.gov/health/heart-healthy-living/healthy-foods/healthy-eating-recipes',
  'public_domain',
  -- Imported by scripts/import_nhlbi.py, not by the sitemap crawler.
  false,
  'Public domain',
  'https://www.nhlbi.nih.gov/about/contact/trademark-branding-and-logo',
  'National Heart, Lung, and Blood Institute (NIH)',
  'Public domain (NHLBI site policy, checked 2026-11-18). Only recipes credited '
  'to NHLBI or NIH cookbooks are imported, one request at a time as SousBot, '
  'within robots.txt.'
)
on conflict (domain) do update set
  name = excluded.name,
  homepage_url = excluded.homepage_url,
  content_rights = excluded.content_rights,
  license_name = excluded.license_name,
  license_url = excluded.license_url,
  attribution = excluded.attribution,
  crawl_notes = excluded.crawl_notes;
