-- Cuisines for recipes whose source doesn't say, and the user's own
-- corrections (TYL-56).
--
-- * A recipe's cuisines come from its publisher (recipeCuisine) as before.
--   When there are none, one is derived from signature words in the title
--   ("bibimbap", "tikka", "Nigerian") and ingredients (gochujang, garam
--   masala), scored by cuisine_signals: the best cuisine with 3 points or more
--   from at least one strong signal, and no tie. Only
--   the title and matched ingredient names are used, never stored text sent
--   anywhere (policy: AI use; this is plain rules).
-- * Derived rows sit in recipe_cuisines with source = 'derived'. The import
--   functions delete and rewrite a recipe's cuisines, so a deferred trigger on
--   recipe_ingredients derives them again at the end of the transaction, after
--   any import, manual save or re-parse.
-- * A user's correction (user_recipe_cuisines) replaces the recipe's cuisines
--   for that user only, wherever they're shown to them.

alter table public.recipe_cuisines
  add column source text not null default 'publisher'
  check (source in ('publisher', 'derived'));

create table public.cuisine_signals (
  cuisine_slug text not null references public.cuisines on update cascade,
  kind text not null check (kind in ('title', 'ingredient')),
  -- title: a regular expression of whole words; ingredient: a canonical name.
  term text not null,
  weight smallint not null check (weight > 0),
  primary key (cuisine_slug, kind, term)
);

alter table public.cuisine_signals enable row level security;
create policy "Readable by everyone" on public.cuisine_signals for select to anon, authenticated
  using (true);
grant select on public.cuisine_signals to anon;
grant select, insert, update, delete on public.cuisine_signals to authenticated, service_role;

-- Weights: a dish name in the title 3; where it's from ("Nigerian") 6;
-- a signature ingredient 2; a supporting one 1.
insert into public.cuisine_signals (cuisine_slug, kind, term, weight) values
  ('indian', 'title', 'indian|nepalese|nepali|bangladeshi|pakistani|sri lankan|punjabi|goan|keralan?|tamil|bengali|gujarati|hyderabadi|kashmiri', 6),
  ('mexican', 'title', 'mexican|oaxacan|yucatan|tex-mex', 6),
  ('italian', 'title', 'italian|tuscan|sicilian|roman|neapolitan|venetian|ligurian|calabrian', 6),
  ('chinese', 'title', 'chinese|cantonese|szechuan|sichuan|hunan|shanghai|taiwanese|hong kong', 6),
  ('japanese', 'title', 'japanese|okinawan', 6),
  ('korean', 'title', 'korean', 6),
  ('thai', 'title', 'thai', 6),
  ('vietnamese', 'title', 'vietnamese', 6),
  ('greek', 'title', 'greek|cypriot', 6),
  ('middle_eastern', 'title', 'lebanese|persian|iranian|turkish|israeli|syrian|palestinian|jordanian|iraqi|yemeni|armenian|arabic|egyptian', 6),
  ('french', 'title', 'french|provençal|provencal|alsatian|breton|parisian', 6),
  ('spanish', 'title', 'spanish|catalan|basque|andalusian', 6),
  ('southern', 'title', 'southern|cajun|creole|louisiana|lowcountry', 6),
  ('caribbean', 'title', 'caribbean|jamaican|trinidadian|cuban|puerto rican|haitian|dominican|barbadian|bahamian', 6),
  ('ethiopian', 'title', 'ethiopian|eritrean', 6),
  ('filipino', 'title', 'filipino|pinoy', 6),
  ('north_african', 'title', 'moroccan|tunisian|algerian|libyan', 6),
  ('west_african', 'title', 'nigerian|ghanaian|senegalese|liberian|sierra leonean|ivorian|cameroonian|togolese|beninese|gambian|malian|west african', 6),
  ('latin_american', 'title', 'peruvian|brazilian|argentin\w*|colombian|venezuelan|salvadoran|chilean|ecuadorian|guatemalan|honduran|nicaraguan|bolivian|uruguayan|paraguayan', 6),
  ('eastern_european', 'title', 'polish|hungarian|ukrainian|russian|czech|slovak|romanian|bulgarian|serbian|croatian|georgian|lithuanian|latvian', 6),
  ('british_irish', 'title', 'english|british|irish|scottish|welsh|cornish', 6),
  ('indonesian', 'title', 'indonesian|balinese|javanese|malaysian', 6),
  ('indian', 'title', 'tikka|masala|dal|dhal|daal|biryani|korma|vindaloo|paneer|chana|saag|aloo|naan|samosa|pakora|raita|tandoori|indian|chaat|dosa|rogan josh|jalfrezi|bhaji|pulao', 3),
  ('indian', 'ingredient', 'garam masala', 2),
  ('indian', 'ingredient', 'ghee', 2),
  ('indian', 'ingredient', 'paneer', 2),
  ('indian', 'ingredient', 'curry leaves', 2),
  ('indian', 'ingredient', 'asafoetida', 2),
  ('indian', 'ingredient', 'fenugreek', 2),
  ('indian', 'ingredient', 'fenugreek seeds', 2),
  ('indian', 'ingredient', 'chana dal', 2),
  ('indian', 'ingredient', 'urad dal', 2),
  ('indian', 'ingredient', 'basmati rice', 2),
  ('indian', 'ingredient', 'cumin seeds', 1),
  ('indian', 'ingredient', 'mustard seeds', 1),
  ('indian', 'ingredient', 'cardamom', 1),
  ('indian', 'ingredient', 'turmeric', 1),
  ('indian', 'ingredient', 'ground turmeric', 1),
  ('indian', 'ingredient', 'ground coriander', 1),
  ('mexican', 'title', 'taco|tacos|enchiladas?|burritos?|quesadillas?|tamales?|salsa|guacamole|pozole|mole|fajitas?|carnitas|chilaquiles|elote|tostadas?|mexican|barbacoa|al pastor|tinga|huevos rancheros|migas|sopes', 3),
  ('mexican', 'ingredient', 'corn tortillas', 2),
  ('mexican', 'ingredient', 'flour tortillas', 2),
  ('mexican', 'ingredient', 'tortillas', 2),
  ('mexican', 'ingredient', 'chipotle peppers in adobo', 2),
  ('mexican', 'ingredient', 'chipotle', 2),
  ('mexican', 'ingredient', 'cotija', 2),
  ('mexican', 'ingredient', 'queso fresco', 2),
  ('mexican', 'ingredient', 'masa harina', 2),
  ('mexican', 'ingredient', 'poblano peppers', 2),
  ('mexican', 'ingredient', 'poblano', 2),
  ('mexican', 'ingredient', 'tomatillos', 2),
  ('mexican', 'ingredient', 'ancho chiles', 2),
  ('mexican', 'ingredient', 'guajillo chiles', 2),
  ('mexican', 'ingredient', 'jalapeño', 1),
  ('mexican', 'ingredient', 'jalapeños', 1),
  ('mexican', 'ingredient', 'cilantro', 1),
  ('mexican', 'ingredient', 'lime', 1),
  ('mexican', 'ingredient', 'limes', 1),
  ('mexican', 'ingredient', 'black beans', 1),
  ('mexican', 'ingredient', 'pinto beans', 1),
  ('italian', 'title', 'lasagna|lasagne|risotto|gnocchi|carbonara|bolognese|pesto|parmigiana|bruschetta|focaccia|minestrone|osso buco|cacciatore|piccata|marsala|tiramisu|panna cotta|arancini|ravioli|frittata|caprese|puttanesca|italian|cacio e pepe|amatriciana|saltimbocca|polenta|ribollita|panzanella|calzone|biscotti|tortellini|orecchiette|ragu|ragù', 3),
  ('italian', 'ingredient', 'arborio rice', 2),
  ('italian', 'ingredient', 'pancetta', 2),
  ('italian', 'ingredient', 'prosciutto', 2),
  ('italian', 'ingredient', 'mascarpone', 2),
  ('italian', 'ingredient', 'pecorino romano', 2),
  ('italian', 'ingredient', 'pecorino', 2),
  ('italian', 'ingredient', 'parmigiano-reggiano', 2),
  ('italian', 'ingredient', 'parmesan', 1),
  ('italian', 'ingredient', 'parmesan cheese', 1),
  ('italian', 'ingredient', 'ricotta', 1),
  ('italian', 'ingredient', 'mozzarella', 1),
  ('italian', 'ingredient', 'fresh basil', 1),
  ('italian', 'ingredient', 'basil', 1),
  ('italian', 'ingredient', 'balsamic vinegar', 1),
  ('chinese', 'title', 'lo mein|chow mein|kung pao|wontons?|mapo|char siu|bao|general tso|sweet and sour|chinese|szechuan|sichuan|dan dan|egg foo young|moo shu|congee|potstickers|hot and sour', 3),
  ('chinese', 'ingredient', 'oyster sauce', 2),
  ('chinese', 'ingredient', 'hoisin sauce', 2),
  ('chinese', 'ingredient', 'shaoxing wine', 2),
  ('chinese', 'ingredient', 'five-spice powder', 2),
  ('chinese', 'ingredient', 'sichuan peppercorns', 2),
  ('chinese', 'ingredient', 'bok choy', 2),
  ('chinese', 'ingredient', 'doubanjiang', 2),
  ('chinese', 'ingredient', 'chinese five spice', 2),
  ('chinese', 'ingredient', 'soy sauce', 1),
  ('chinese', 'ingredient', 'sesame oil', 1),
  ('chinese', 'ingredient', 'rice vinegar', 1),
  ('chinese', 'ingredient', 'ginger', 1),
  ('chinese', 'ingredient', 'fresh ginger', 1),
  ('chinese', 'ingredient', 'scallions', 1),
  ('chinese', 'ingredient', 'green onions', 1),
  ('japanese', 'title', 'teriyaki|ramen|sushi|miso|tempura|katsu|udon|soba|yakitori|donburi|onigiri|gyoza|japanese|okonomiyaki|tonkatsu|sukiyaki|karaage|matcha', 3),
  ('japanese', 'ingredient', 'mirin', 2),
  ('japanese', 'ingredient', 'miso', 2),
  ('japanese', 'ingredient', 'white miso', 2),
  ('japanese', 'ingredient', 'dashi', 2),
  ('japanese', 'ingredient', 'nori', 2),
  ('japanese', 'ingredient', 'sake', 2),
  ('japanese', 'ingredient', 'katsuobushi', 2),
  ('japanese', 'ingredient', 'wasabi', 2),
  ('japanese', 'ingredient', 'kombu', 2),
  ('japanese', 'ingredient', 'sushi rice', 2),
  ('japanese', 'ingredient', 'panko', 1),
  ('japanese', 'ingredient', 'soy sauce', 1),
  ('japanese', 'ingredient', 'rice vinegar', 1),
  ('korean', 'title', 'bibimbap|bulgogi|kimchi|japchae|tteokbokki|galbi|korean|gochujang', 3),
  ('korean', 'ingredient', 'gochujang', 2),
  ('korean', 'ingredient', 'gochugaru', 2),
  ('korean', 'ingredient', 'kimchi', 2),
  ('korean', 'ingredient', 'doenjang', 2),
  ('korean', 'ingredient', 'sesame oil', 1),
  ('korean', 'ingredient', 'soy sauce', 1),
  ('thai', 'title', 'pad thai|tom yum|tom kha|larb|thai|green curry|red curry|massaman|panang|pad see ew|khao soi', 3),
  ('thai', 'ingredient', 'thai basil', 2),
  ('thai', 'ingredient', 'galangal', 2),
  ('thai', 'ingredient', 'kaffir lime leaves', 2),
  ('thai', 'ingredient', 'red curry paste', 2),
  ('thai', 'ingredient', 'green curry paste', 2),
  ('thai', 'ingredient', 'thai red curry paste', 2),
  ('thai', 'ingredient', 'thai green curry paste', 2),
  ('thai', 'ingredient', 'fish sauce', 1),
  ('thai', 'ingredient', 'lemongrass', 1),
  ('thai', 'ingredient', 'coconut milk', 1),
  ('vietnamese', 'title', 'pho|banh mi|bún|vietnamese|nuoc cham|goi cuon', 3),
  ('vietnamese', 'ingredient', 'rice paper', 2),
  ('vietnamese', 'ingredient', 'fish sauce', 1),
  ('vietnamese', 'ingredient', 'rice noodles', 1),
  ('vietnamese', 'ingredient', 'lemongrass', 1),
  ('greek', 'title', 'greek|souvlaki|moussaka|spanakopita|tzatziki|gyros?|pastitsio|avgolemono|horiatiki|keftedes|dolmades', 3),
  ('greek', 'ingredient', 'kalamata olives', 2),
  ('greek', 'ingredient', 'phyllo dough', 2),
  ('greek', 'ingredient', 'phyllo', 2),
  ('greek', 'ingredient', 'feta', 1),
  ('greek', 'ingredient', 'feta cheese', 1),
  ('greek', 'ingredient', 'dried oregano', 1),
  ('greek', 'ingredient', 'oregano', 1),
  ('middle_eastern', 'title', 'hummus|falafel|shawarma|tabbouleh|fattoush|shakshuka|baba ganoush|kofta|labneh|mujadara|kibbeh|manakish|musakhan|lebanese|persian|turkish|israeli', 3),
  ('middle_eastern', 'ingredient', 'tahini', 2),
  ('middle_eastern', 'ingredient', 'sumac', 2),
  ('middle_eastern', 'ingredient', 'za''atar', 2),
  ('middle_eastern', 'ingredient', 'zaatar', 2),
  ('middle_eastern', 'ingredient', 'pomegranate molasses', 2),
  ('middle_eastern', 'ingredient', 'bulgur', 1),
  ('middle_eastern', 'ingredient', 'chickpeas', 1),
  ('french', 'title', 'french|coq au vin|ratatouille|quiche|gratin|bourguignon|crêpes?|crepes?|soufflé|souffle|niçoise|nicoise|cassoulet|bouillabaisse|croque|tarte|vichyssoise|clafoutis|beurre blanc|madeleines|confit|provençal|provencal', 3),
  ('french', 'ingredient', 'gruyère', 2),
  ('french', 'ingredient', 'gruyere', 2),
  ('french', 'ingredient', 'herbes de provence', 2),
  ('french', 'ingredient', 'crème fraîche', 2),
  ('french', 'ingredient', 'creme fraiche', 2),
  ('french', 'ingredient', 'dijon mustard', 1),
  ('french', 'ingredient', 'shallots', 1),
  ('french', 'ingredient', 'shallot', 1),
  ('spanish', 'title', 'paella|gazpacho|tortilla española|patatas bravas|tapas|romesco|churros|spanish|salmorejo|albondigas', 3),
  ('spanish', 'ingredient', 'manchego', 2),
  ('spanish', 'ingredient', 'sherry vinegar', 2),
  ('spanish', 'ingredient', 'saffron', 1),
  ('spanish', 'ingredient', 'smoked paprika', 1),
  ('spanish', 'ingredient', 'chorizo', 1),
  ('southern', 'title', 'gumbo|jambalaya|grits|biscuits|cornbread|collards?|fried chicken|hush puppies|etouffee|étouffée|pimento cheese|cobbler|southern|cajun|creole|hoppin|po boy|po''boy|chess pie|red beans and rice|chicken and dumplings', 3),
  ('southern', 'ingredient', 'grits', 2),
  ('southern', 'ingredient', 'collard greens', 2),
  ('southern', 'ingredient', 'andouille sausage', 2),
  ('southern', 'ingredient', 'andouille', 2),
  ('southern', 'ingredient', 'okra', 1),
  ('southern', 'ingredient', 'buttermilk', 1),
  ('caribbean', 'title', 'jerk|jamaican|caribbean|plantains?|curry goat|cuban|puerto rican|mofongo|ropa vieja|sofrito|trinidad', 3),
  ('caribbean', 'ingredient', 'scotch bonnet peppers', 1),
  ('caribbean', 'ingredient', 'scotch bonnet', 1),
  ('caribbean', 'ingredient', 'plantains', 1),
  ('caribbean', 'ingredient', 'allspice', 1),
  ('ethiopian', 'title', 'injera|doro wat|misir wat|ethiopian|tibs|kitfo|shiro', 3),
  ('ethiopian', 'ingredient', 'berbere', 2),
  ('ethiopian', 'ingredient', 'teff', 2),
  ('ethiopian', 'ingredient', 'niter kibbeh', 2),
  ('filipino', 'title', 'pancit|lumpia|sinigang|filipino|adobo|kare-kare|sisig|lechon|arroz caldo', 3),
  ('filipino', 'ingredient', 'calamansi', 2),
  ('north_african', 'title', 'tagine|moroccan|chermoula|harira|shakshouka|tunisian|algerian|couscous', 3),
  ('north_african', 'ingredient', 'harissa', 2),
  ('north_african', 'ingredient', 'preserved lemons', 2),
  ('north_african', 'ingredient', 'ras el hanout', 2),
  ('west_african', 'title', 'jollof|egusi|suya|fufu|groundnut stew|nigerian|ghanaian|senegalese|mafe|yassa', 3),
  ('latin_american', 'title', 'arepas?|empanadas?|ceviche|chimichurri|pupusas?|feijoada|peruvian|brazilian|argentin\w*|colombian|venezuelan|salvadoran|lomo saltado|tres leches|pastel de choclo|alfajores', 3),
  ('latin_american', 'ingredient', 'aji amarillo', 2),
  ('eastern_european', 'title', 'pierogi|pierogies|borscht|goulash|stroganoff|paprikash|blini|kielbasa|polish|hungarian|ukrainian|russian|halushki|cabbage rolls|golabki|varenyky', 3),
  ('eastern_european', 'ingredient', 'kielbasa', 2),
  ('eastern_european', 'ingredient', 'sauerkraut', 1),
  ('eastern_european', 'ingredient', 'sweet paprika', 1),
  ('british_irish', 'title', 'shepherd''?s pie|cottage pie|fish and chips|scones?|bangers|toad in the hole|irish|colcannon|soda bread|trifle|yorkshire pudding|english|british|scottish|welsh|sticky toffee|bubble and squeak|ploughman|crumpets|bakewell', 3),
  ('indonesian', 'title', 'rendang|nasi goreng|gado-gado|gado gado|sambal|indonesian|balinese|mie goreng|soto ayam|satay|sate', 3),
  ('indonesian', 'ingredient', 'kecap manis', 2),
  ('indonesian', 'ingredient', 'sambal oelek', 1);

-- The cuisine a recipe's title and ingredients point to, or null.
create function public.derive_cuisine(p_recipe uuid) returns text
language sql stable set search_path = public as $$
  with scores as (
    select s.cuisine_slug, sum(s.weight) as score, max(s.weight) as strongest
    from public.cuisine_signals s
    join public.recipes r on r.id = p_recipe
    where (s.kind = 'title' and lower(r.title) ~ ('\m(' || s.term || ')\M'))
       or (s.kind = 'ingredient' and exists (
             select 1 from public.recipe_ingredients ri
             join public.ingredients i on i.id = ri.ingredient_id
             where ri.recipe_id = p_recipe and lower(i.name) = s.term))
    group by s.cuisine_slug
  ), ranked as (
    select cuisine_slug, score, rank() over (order by score desc) as rk from scores
    -- Supporting ingredients alone (coconut milk, fish sauce) don't decide it.
    where strongest >= 2
  )
  select cuisine_slug from ranked
  where rk = 1 and score >= 3 and (select count(*) from ranked where rk = 1) = 1
$$;

-- Bring a recipe's derived cuisine up to date: none when the publisher gave
-- cuisines, else the derived one (if any).
create function public.refresh_derived_cuisine(p_recipe uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_slug text;
begin
  delete from public.recipe_cuisines where recipe_id = p_recipe and source = 'derived';
  if exists (select 1 from public.recipe_cuisines where recipe_id = p_recipe) then
    return;
  end if;
  v_slug := public.derive_cuisine(p_recipe);
  if v_slug is not null then
    insert into public.recipe_cuisines (recipe_id, cuisine_slug, source)
    values (p_recipe, v_slug, 'derived')
    on conflict do nothing;
  end if;
end
$$;

revoke execute on function public.refresh_derived_cuisine(uuid) from public, anon, authenticated;
grant execute on function public.refresh_derived_cuisine(uuid) to service_role;

create function public.recipe_ingredients_derive_cuisine() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.recipes where id = coalesce(new.recipe_id, old.recipe_id)) then
    perform public.refresh_derived_cuisine(coalesce(new.recipe_id, old.recipe_id));
  end if;
  return null;
end
$$;

-- Deferred, so it runs after the import functions rewrite recipe_cuisines.
create constraint trigger recipe_ingredients_derive_cuisine
  after insert or update or delete on public.recipe_ingredients
  deferrable initially deferred
  for each row execute function public.recipe_ingredients_derive_cuisine();

-- A publisher's cuisine replaces derived ones, whenever it's written.
create function public.recipe_cuisines_publisher_wins() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'publisher' then
    delete from public.recipe_cuisines
    where recipe_id = new.recipe_id and source = 'derived';
  end if;
  return new;
end
$$;

create trigger recipe_cuisines_publisher_wins
  before insert on public.recipe_cuisines
  for each row execute function public.recipe_cuisines_publisher_wins();

-- A user's own cuisines for a recipe, in place of its shared ones.
create table public.user_recipe_cuisines (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  recipe_id uuid not null references public.recipes on delete cascade,
  cuisine_slug text not null references public.cuisines on update cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, recipe_id, cuisine_slug)
);

create index user_recipe_cuisines_recipe on public.user_recipe_cuisines (recipe_id);

alter table public.user_recipe_cuisines enable row level security;
create policy "Own rows" on public.user_recipe_cuisines for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select on public.user_recipe_cuisines to anon;
grant select, insert, update, delete on public.user_recipe_cuisines to authenticated, service_role;

-- Replace the user's cuisines for a recipe; none goes back to the shared ones.
create function public.set_my_recipe_cuisines(p_recipe uuid, p_cuisines text[]) returns void
language plpgsql security invoker set search_path = public as $$
begin
  delete from public.user_recipe_cuisines where user_id = auth.uid() and recipe_id = p_recipe;
  insert into public.user_recipe_cuisines (user_id, recipe_id, cuisine_slug)
  select distinct auth.uid(), p_recipe, c.slug
  from unnest(coalesce(p_cuisines, '{}')) as s(slug)
  join public.cuisines c on c.slug = s.slug;
end
$$;

revoke execute on function public.set_my_recipe_cuisines(uuid, text[]) from public, anon;
grant execute on function public.set_my_recipe_cuisines(uuid, text[]) to authenticated;

-- A recipe's cuisine names as a user sees them: their correction, or the
-- shared ones.
create function public.recipe_cuisine_names(p_recipe uuid, p_user uuid) returns jsonb
language sql stable set search_path = public as $$
  select coalesce(
    (select jsonb_agg(cu.name order by cu.name)
       from public.user_recipe_cuisines u join public.cuisines cu on cu.slug = u.cuisine_slug
      where u.recipe_id = p_recipe and u.user_id = p_user),
    (select jsonb_agg(cu.name order by cu.name)
       from public.recipe_cuisines rc join public.cuisines cu on cu.slug = rc.cuisine_slug
      where rc.recipe_id = p_recipe),
    '[]')
$$;

-- Plan my week reads cuisines as the user sees them. Otherwise as before.
create or replace function public.plan_draft_pool(p_user uuid, p_week date) returns jsonb
language plpgsql stable as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'plan_draft_pool is only callable by the API' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'cook_with_seasons', coalesce(
      (select p.cook_with_seasons from public.profiles p where p.user_id = p_user), false
    ),
    -- How much variety the user wants (TYL-66); the defaults with no profile.
    'variety', coalesce((
      select jsonb_build_object(
        'proteins', p.mix_proteins, 'cuisines', p.mix_cuisines,
        'styles', p.mix_styles, 'repeat_weeks', p.repeat_weeks)
      from public.profiles p where p.user_id = p_user
    ), jsonb_build_object('proteins', true, 'cuisines', true, 'styles', true, 'repeat_weeks', 3)),
    'candidates', coalesce((
    select jsonb_agg(jsonb_build_object(
      'recipe_id', r.id,
      'title', r.title,
      -- The user's own tags, which can name a cooking style ("soup").
      'tags', to_jsonb(coalesce(s.tags, '{}')),
      'fit', public.recipe_fit_for_user(r.id, p_user),
      'favorite', (select f.frequency from public.user_favorite_recipes f
                   where f.user_id = p_user and f.recipe_id = r.id),
      -- 0 is this week; null is not in the last 8 weeks.
      'weeks_ago', (
        select min(greatest(0, ceil((p_week - d)::numeric / 7)))::int
        from (
          select mp.week_start as d
          from public.meal_plan_entries e
          join public.meal_plans mp on mp.id = e.meal_plan_id
          where mp.user_id = p_user and e.recipe_id = r.id
            and mp.week_start between p_week - 56 and p_week - 7
          union all
          select c.cooked_on from public.cooked_meals c
          where c.user_id = p_user and c.recipe_id = r.id
            and c.cooked_on between p_week - 56 and p_week - 1
        ) had
      ),
      -- The user's own correction wins (TYL-56).
      'cuisines', public.recipe_cuisine_names(r.id, p_user),
      -- Its seasonal produce (in season 8 months a year or fewer) that's in
      -- season the week planned, and how much isn't (TYL-70).
      'in_season', coalesce((
        select jsonb_agg(distinct s2.name)
        from public.recipe_seasonal(r.id, p_user, p_week) s2 where s2.in_season
      ), '[]'),
      'out_of_season', (
        select count(*) from public.recipe_seasonal(r.id, p_user, p_week) s2
        where not s2.in_season
      )
    ) order by s.created_at desc)
    from public.user_saved_recipes s
    join public.recipes r on r.id = s.recipe_id
    where s.user_id = p_user
      and ((r.visibility = 'public' and r.status = 'active') or r.added_by = p_user)
  ), '[]'));
end
$$;

-- The export includes cuisine corrections. Otherwise as before.
create or replace function public.export_my_data() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.user_id = auth.uid()),
    'diets', coalesce((select jsonb_agg(d.diet_slug) from public.user_diets d
                       where d.user_id = auth.uid()), '[]'),
    'diet_goals', coalesce((select jsonb_agg(to_jsonb(g)) from public.user_diet_goals g
                            where g.user_id = auth.uid()), '[]'),
    'category_weights', coalesce((select jsonb_agg(to_jsonb(w)) from public.user_category_weights w
                                  where w.user_id = auth.uid()), '[]'),
    'favorite_cuisines', coalesce((select jsonb_agg(c.cuisine_slug) from public.user_favorite_cuisines c
                                   where c.user_id = auth.uid()), '[]'),
    'cuisine_corrections', coalesce((select jsonb_agg(jsonb_build_object(
                                       'recipe', r.title, 'cuisine', c.cuisine_slug))
                                     from public.user_recipe_cuisines c
                                     join public.recipes r on r.id = c.recipe_id
                                     where c.user_id = auth.uid()), '[]'),
    'favorite_ingredients', coalesce((select jsonb_agg(i.name)
                                      from public.user_favorite_ingredients f
                                      join public.ingredients i on i.id = f.ingredient_id
                                      where f.user_id = auth.uid()), '[]'),
    'disliked_ingredients', coalesce((select jsonb_agg(i.name)
                                      from public.user_disliked_ingredients d
                                      join public.ingredients i on i.id = d.ingredient_id
                                      where d.user_id = auth.uid()), '[]'),
    'saved_recipes', coalesce((select jsonb_agg(jsonb_build_object(
                                 'title', r.title, 'source_url', r.source_url,
                                 'tags', s.tags, 'saved_at', s.created_at)
                               order by s.created_at)
                               from public.user_saved_recipes s
                               join public.recipes r on r.id = s.recipe_id
                               where s.user_id = auth.uid()), '[]'),
    'your_recipes', coalesce((select jsonb_agg(jsonb_build_object(
                                'title', r.title, 'servings', r.servings,
                                'ingredients', (select jsonb_agg(ri.raw_text order by ri.line_no)
                                                from public.recipe_ingredients ri
                                                where ri.recipe_id = r.id and ri.option_no = 1),
                                'instructions', r.instructions, 'note', r.source_note))
                              from public.recipes r
                              where r.added_by = auth.uid() and r.source_url is null), '[]'),
    'meal_plans', coalesce((select jsonb_agg(jsonb_build_object(
                              'week_start', mp.week_start, 'budget_cents', mp.budget_cents,
                              'meals', (select jsonb_agg(jsonb_build_object(
                                          'recipe', r.title, 'scale', e.scale,
                                          'day', e.planned_for, 'meal', e.meal)
                                        order by e.position)
                                        from public.meal_plan_entries e
                                        join public.recipes r on r.id = e.recipe_id
                                        where e.meal_plan_id = mp.id))
                            order by mp.week_start)
                            from public.meal_plans mp where mp.user_id = auth.uid()), '[]'),
    'pantry', coalesce((select jsonb_agg(jsonb_build_object('ingredient', i.name, 'kind', up.kind, 'status', up.status))
                        from public.user_pantry up join public.ingredients i on i.id = up.ingredient_id
                        where up.user_id = auth.uid()), '[]'),
    'your_prices', coalesce((select jsonb_agg(jsonb_build_object(
                               'ingredient', i.name, 'price_cents', pr.price_cents,
                               'quantity', pr.quantity, 'unit', pr.unit, 'store', st.name))
                             from public.prices pr
                             join public.ingredients i on i.id = pr.ingredient_id
                             left join public.stores st on st.id = pr.store_id
                             where pr.source = 'user' and pr.user_id = auth.uid()), '[]'),
    'stores', coalesce((select jsonb_agg(jsonb_build_object(
                          'name', st.name, 'address', st.address, 'primary', us.is_primary)
                        order by us.is_primary desc, st.name)
                        from public.user_stores us join public.stores st on st.id = us.store_id
                        where us.user_id = auth.uid()), '[]'),
    'shopping_lists', coalesce((select jsonb_agg(jsonb_build_object(
                                  'week_start', sl.week_start,
                                  'items', (select jsonb_agg(jsonb_build_object(
                                              'name', it.name, 'amount', it.amount,
                                              'checked', it.checked_at is not null,
                                              'removed', it.removed)
                                            order by it.position)
                                            from public.shopping_list_items it
                                            where it.shopping_list_id = sl.id))
                                order by sl.week_start)
                                from public.shopping_lists sl where sl.user_id = auth.uid()), '[]'),
    'feedback', coalesce((select jsonb_agg(jsonb_build_object(
                            'message', f.message, 'page', f.page, 'sent_at', f.created_at)
                          order by f.created_at)
                          from public.feedback f where f.user_id = auth.uid()), '[]'),
    'cooked', coalesce((select jsonb_agg(jsonb_build_object(
                          'recipe', r.title, 'cooked_on', c.cooked_on, 'scale', c.scale,
                          'rating', c.rating, 'note', c.note)
                        order by c.cooked_on, c.created_at)
                        from public.cooked_meals c join public.recipes r on r.id = c.recipe_id
                        where c.user_id = auth.uid()), '[]'),
    'favorite_recipes', coalesce((select jsonb_agg(jsonb_build_object(
                                    'recipe', r.title, 'how_often', f.frequency)
                                  order by r.title)
                                  from public.user_favorite_recipes f
                                  join public.recipes r on r.id = f.recipe_id
                                  where f.user_id = auth.uid()), '[]'),
    'pantry_suggestions_declined', coalesce((select jsonb_agg(i.name order by i.name)
                                             from public.user_pantry_dismissed d
                                             join public.ingredients i on i.id = d.ingredient_id
                                             where d.user_id = auth.uid()), '[]')
  )
$$;

-- Derive cuisines for the recipes saved so far.
select public.refresh_derived_cuisine(id) from public.recipes;
