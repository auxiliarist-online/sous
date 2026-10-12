-- Openly licensed recipe sources (TYL-45), starting with the Wikibooks
-- Cookbook (CC BY-SA 4.0). Their content_rights is 'licensed', so steps are
-- stored and shown; the license is recorded so every page can credit it.

alter table public.recipe_sources
  add column license_name text,
  add column license_url text,
  -- Credit line shown with each recipe ("by Wikibooks contributors").
  add column attribution text;

insert into public.recipe_sources (
  name, domain, homepage_url, content_rights, crawl_enabled,
  license_name, license_url, attribution, crawl_notes
)
values (
  'Wikibooks Cookbook',
  'en.wikibooks.org',
  'https://en.wikibooks.org/wiki/Cookbook:Table_of_Contents',
  'licensed',
  -- Imported through the MediaWiki API by scripts/import_wikibooks.py, not
  -- by the sitemap crawler.
  false,
  'CC BY-SA 4.0',
  'https://creativecommons.org/licenses/by-sa/4.0/',
  'Wikibooks contributors',
  'CC BY-SA 4.0 (siteinfo rightsinfo, checked 2026-10-11). Imported via the '
  'MediaWiki API (serial requests, maxlag, SousBot user agent), not crawled.'
)
on conflict (domain) do update set
  name = excluded.name,
  homepage_url = excluded.homepage_url,
  content_rights = excluded.content_rights,
  license_name = excluded.license_name,
  license_url = excluded.license_url,
  attribution = excluded.attribution,
  crawl_notes = excluded.crawl_notes;

-- Make a licensed source's imported recipes public: those waiting for review
-- that have ingredients and steps. Only for sources whose license is recorded
-- and that haven't opted out. Returns how many were published.
create function public.publish_licensed_recipes(p_source uuid) returns integer
language plpgsql as $$
declare
  v_source public.recipe_sources;
  v_count integer;
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'publish_licensed_recipes is only callable by the API' using errcode = '42501';
  end if;
  select * into v_source from public.recipe_sources where id = p_source;
  if v_source.id is null
     or v_source.content_rights not in ('public_domain', 'licensed')
     or (v_source.content_rights = 'licensed' and v_source.license_name is null)
     or v_source.opted_out_at is not null then
    raise exception 'that source can''t be published' using errcode = '22023';
  end if;

  update public.recipes r set visibility = 'public', status = 'active'
  where r.source_id = p_source
    and r.status = 'needs_review'
    and r.origin = 'fetched'
    and r.added_by is null
    and jsonb_array_length(coalesce(r.instructions, '[]')) > 0
    and exists (select 1 from public.recipe_ingredients ri where ri.recipe_id = r.id);
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke execute on function public.publish_licensed_recipes(uuid) from public, anon, authenticated;
grant execute on function public.publish_licensed_recipes(uuid) to service_role;
