// Recipe pages, hand-typed recipes and preferences (TYL-12, TYL-35, TYL-14,
// TYL-24). Reads and writes go to Supabase as the signed-in user, so
// row-level security keeps everything to their own rows; saving a typed-in
// recipe goes through the API, which parses its ingredients.
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { apiFetch } from './auth.ts'
import type { DietLabel } from './library.ts'

export interface IngredientLine {
  lineNo: number
  optionNo: number
  rawText: string
  section: string | null
  name: string | null
  quantity: number | null
  quantityMax: number | null
  unit: string | null
  preparation: string | null
  isOptional: boolean
}

export interface RecipeDetail {
  id: string
  title: string
  sourceUrl: string | null
  sourceName: string | null
  sourceNote: string | null
  /** For openly licensed sources (Wikibooks): the license and credit line. */
  license: {
    name: string
    url: string | null
    attribution: string | null
  } | null
  servings: number | null
  prepMinutes: number | null
  cookMinutes: number | null
  totalMinutes: number | null
  instructions: string[] | null
  /** True for a recipe the user typed in themselves (they can edit it). */
  handTyped: boolean
  /** In the user's own recipes. */
  saved: boolean
  /** The user's own tags, when saved (TYL-81). */
  tags: string[]
  ingredients: IngredientLine[]
  diets: DietLabel[]
  cuisines: string[]
}

interface RecipeRow {
  id: string
  title: string
  source_url: string | null
  source_note: string | null
  servings: number | null
  prep_minutes: number | null
  cook_minutes: number | null
  total_minutes: number | null
  instructions: string[] | null
  added_by: string | null
  source: {
    name: string
    license_name: string | null
    license_url: string | null
    attribution: string | null
  } | null
  ingredients: {
    line_no: number
    option_no: number
    raw_text: string
    section: string | null
    name: string | null
    quantity: number | null
    quantity_max: number | null
    unit: string | null
    preparation: string | null
    is_optional: boolean
  }[]
  diets: {
    diet_slug: string
    source: string
    checks: DietLabel['checks'] | null
  }[]
  cuisines: { cuisine_slug: string }[]
}

/** One recipe with its ingredients, labels and cuisines, plus whether the
 *  user saved it and their tags on it; null when they can't see it. */
export async function recipeDetail(
  db: SupabaseClient,
  userId: string,
  id: string,
): Promise<RecipeDetail | null> {
  const savedQuery = db
    .from('user_saved_recipes')
    .select('recipe_id, tags')
    .eq('user_id', userId)
    .eq('recipe_id', id)
    .maybeSingle()
  const { data, error } = await db
    .from('recipes')
    .select(
      `id, title, source_url, source_note, servings, prep_minutes, cook_minutes, total_minutes,
       instructions, added_by, source:recipe_sources(name, license_name, license_url, attribution),
       ingredients:recipe_ingredients(line_no, option_no, raw_text, section, name, quantity, quantity_max, unit, preparation, is_optional),
       diets:recipe_diets(diet_slug, source, checks), cuisines:recipe_cuisines(cuisine_slug)`,
    )
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const saved = await savedQuery
  const r = data as unknown as RecipeRow
  return {
    id: r.id,
    title: r.title,
    sourceUrl: r.source_url,
    sourceName: r.source?.name ?? null,
    sourceNote: r.source_note,
    license: r.source?.license_name
      ? {
          name: r.source.license_name,
          url: r.source.license_url,
          attribution: r.source.attribution,
        }
      : null,
    servings: r.servings,
    prepMinutes: r.prep_minutes,
    cookMinutes: r.cook_minutes,
    totalMinutes: r.total_minutes,
    instructions: r.instructions,
    handTyped: !r.source_url && r.added_by === userId,
    saved: !!saved.data,
    tags: (saved.data as { tags: string[] | null } | null)?.tags ?? [],
    ingredients: [...r.ingredients]
      .sort((a, b) => a.line_no - b.line_no || a.option_no - b.option_no)
      .map((i) => ({
        lineNo: i.line_no,
        optionNo: i.option_no,
        rawText: i.raw_text,
        section: i.section,
        name: i.name,
        quantity: i.quantity == null ? null : Number(i.quantity),
        quantityMax: i.quantity_max == null ? null : Number(i.quantity_max),
        unit: i.unit ?? null,
        preparation: i.preparation ?? null,
        isOptional: i.is_optional,
      })),
    // The publisher's own tags are only hints; show what the ingredients prove.
    diets: r.diets
      .filter((d) => d.source !== 'publisher')
      .map((d) => ({ slug: d.diet_slug, checks: d.checks ?? [] })),
    cuisines: r.cuisines.map((c) => c.cuisine_slug),
  }
}

/** One row per ingredient line: alternatives share a line and its text. */
export function ingredientLines(lines: IngredientLine[]): IngredientLine[] {
  return lines.filter((l) => l.optionNo === 1)
}

export interface ManualRecipeInput {
  title: string
  ingredients: string
  instructions: string
  servings: number | null
  totalMinutes: number | null
  sourceNote: string
}

/** The form's text for an existing hand-typed recipe. */
export function manualInput(r: RecipeDetail): ManualRecipeInput {
  let section: string | null = null
  const lines: string[] = []
  for (const l of ingredientLines(r.ingredients)) {
    if (l.section !== section && l.section) lines.push(`${l.section}:`)
    section = l.section
    lines.push(l.rawText)
  }
  return {
    title: r.title,
    ingredients: lines.join('\n'),
    instructions: (r.instructions ?? []).join('\n'),
    servings: r.servings,
    totalMinutes: r.totalMinutes,
    sourceNote: r.sourceNote ?? '',
  }
}

// Supabase returns at most 1,000 rows a request.
const SOURCE_NOTES_PAGE = 1000

/** Where the user's own recipes say they're from ("Salt Fat Acid Heat",
 *  "Grandma"), most used first, so the form can suggest them (TYL-100). */
export async function sourceNotes(
  db: SupabaseClient,
  userId: string,
): Promise<string[]> {
  // Every note counts toward the ranking, so read them a page at a time.
  const rows: { source_note: string }[] = []
  for (let from = 0; ; from += SOURCE_NOTES_PAGE) {
    const { data, error } = await db
      .from('recipes')
      .select('source_note')
      .eq('added_by', userId)
      .not('source_note', 'is', null)
      .order('id')
      .range(from, from + SOURCE_NOTES_PAGE - 1)
    if (error) throw error
    rows.push(...(data as { source_note: string }[]))
    if (data.length < SOURCE_NOTES_PAGE) break
  }
  const counts = new Map<string, { note: string; n: number }>()
  for (const { source_note } of rows) {
    const note = source_note.trim()
    const key = note.toLowerCase()
    if (!note) continue
    const seen = counts.get(key)
    if (seen) seen.n++
    else counts.set(key, { note, n: 1 })
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.note.localeCompare(b.note))
    .map((c) => c.note)
}

export async function saveManual(
  session: Session,
  input: ManualRecipeInput,
  recipeId?: string,
  send: typeof apiFetch = apiFetch,
): Promise<string> {
  const path = recipeId ? `/recipes/manual/${recipeId}` : '/recipes/manual'
  const resp = await send(session, path, {
    method: recipeId ? 'PUT' : 'POST',
    body: JSON.stringify({
      title: input.title,
      ingredients: input.ingredients,
      instructions: input.instructions,
      servings: input.servings,
      total_minutes: input.totalMinutes,
      source_note: input.sourceNote || null,
    }),
  })
  if (!resp.ok) {
    throw new Error(
      resp.status === 401
        ? 'Your session has expired. Sign in again.'
        : resp.status === 422
          ? 'Check the title, servings and time, then try again.'
          : "We couldn't save the recipe. Try again.",
    )
  }
  return ((await resp.json()) as { recipe_id: string }).recipe_id
}

/** A recipe read from photos of cookbook pages (TYL-52), for the form. */
export interface PhotoDraft {
  title: string
  servings: number | null
  /** Total, or prep plus cook when the page gives those. */
  totalMinutes: number | null
  /** One per line; a line ending in ":" starts a section. */
  ingredients: string[]
  instructions: string[]
  /** Lines read with low confidence, or hard to place: worth a check. */
  unsure: string[]
  /** Text left out: the author's introduction, notes. */
  skipped: string[]
}

/** Read photos of one recipe's pages (base64 JPEG, in order) into a draft.
 *  Nothing is saved, and the photos aren't kept. */
export async function readPhotos(
  session: Session,
  images: string[],
  send: typeof apiFetch = apiFetch,
): Promise<PhotoDraft> {
  const resp = await send(session, '/recipes/read-photos', {
    method: 'POST',
    body: JSON.stringify({ images }),
  })
  if (!resp.ok) {
    const detail = (
      (await resp.json().catch(() => null)) as { detail?: unknown } | null
    )?.detail
    throw new Error(
      typeof detail === 'string' && resp.status === 429
        ? detail
        : resp.status === 401
          ? 'Your session has expired. Sign in again.'
          : resp.status === 413
            ? 'A photo is too large. Try again with fewer or smaller pages.'
            : "We couldn't read the photos. Try again, or type the recipe in.",
    )
  }
  const d = (await resp.json()) as {
    title: string
    servings: number | null
    prep_minutes: number | null
    cook_minutes: number | null
    total_minutes: number | null
    ingredients: string[]
    instructions: string[]
    unsure: string[]
    skipped: string[]
  }
  const parts = (d.prep_minutes ?? 0) + (d.cook_minutes ?? 0)
  return {
    title: d.title,
    servings: d.servings,
    totalMinutes: d.total_minutes ?? (parts > 0 ? parts : null),
    ingredients: d.ingredients,
    instructions: d.instructions,
    unsure: d.unsure,
    skipped: d.skipped,
  }
}

// ---------- preferences ----------

export interface Option {
  slug: string
  name: string
}

export interface IngredientRef {
  id: string
  name: string
}

export interface Preferences {
  /** False until the user has saved preferences once (onboarding). */
  saved: boolean
  diets: string[]
  allergens: string[]
  avoid: string[]
  strictMayContain: boolean
  householdSize: number
  weeklyBudgetCents: number | null
  /** Five digits, for finding nearby stores (TYL-14); kept coarse on purpose. */
  homeZip: string | null
  favoriteCuisines: string[]
  favoriteIngredients: IngredientRef[]
  dislikedIngredients: IngredientRef[]
}

export const NO_PREFERENCES: Preferences = {
  saved: false,
  diets: [],
  allergens: [],
  avoid: [],
  strictMayContain: false,
  householdSize: 1,
  weeklyBudgetCents: null,
  homeZip: null,
  favoriteCuisines: [],
  favoriteIngredients: [],
  dislikedIngredients: [],
}

/** Diet categories a user can mark as allergies or things to avoid. */
export const CATEGORIES: Option[] = [
  { slug: 'peanut', name: 'Peanuts' },
  { slug: 'tree_nut', name: 'Tree nuts' },
  { slug: 'dairy', name: 'Dairy' },
  { slug: 'egg', name: 'Eggs' },
  { slug: 'gluten', name: 'Gluten' },
  { slug: 'soy', name: 'Soy' },
  { slug: 'sesame', name: 'Sesame' },
  { slug: 'fish', name: 'Fish' },
  { slug: 'shellfish', name: 'Shellfish' },
  { slug: 'pork', name: 'Pork' },
  { slug: 'alcohol', name: 'Alcohol' },
  { slug: 'gelatin', name: 'Gelatin' },
  { slug: 'animal_rennet', name: 'Animal rennet' },
  { slug: 'honey', name: 'Honey' },
]

function ingredientRefs(rows: { ingredient: IngredientRef | null }[] | null) {
  return (rows ?? []).flatMap((r) => (r.ingredient ? [r.ingredient] : []))
}

/** The user's preferences: profile (with home zip), diets, cuisines and
 *  ingredients. `saved` is false until they've saved once. */
export async function loadPreferences(
  db: SupabaseClient,
  userId: string,
): Promise<Preferences> {
  const [profile, diets, cuisines, favorites, dislikes] = await Promise.all([
    db
      .from('profiles')
      .select(
        'allergens, avoid_categories, strict_may_contain, household_size, weekly_budget_cents, home_zip',
      )
      .eq('user_id', userId)
      .maybeSingle(),
    db.from('user_diets').select('diet_slug'),
    db.from('user_favorite_cuisines').select('cuisine_slug'),
    db
      .from('user_favorite_ingredients')
      .select('ingredient:ingredients(id, name)'),
    db
      .from('user_disliked_ingredients')
      .select('ingredient:ingredients(id, name)'),
  ])
  for (const r of [profile, diets, cuisines, favorites, dislikes])
    if (r.error) throw r.error
  const p = profile.data as {
    allergens: string[]
    avoid_categories: string[]
    strict_may_contain: boolean
    household_size: number
    weekly_budget_cents: number | null
    home_zip?: string | null
  } | null
  return {
    saved: !!p,
    diets: (diets.data ?? []).map((d: { diet_slug: string }) => d.diet_slug),
    allergens: p?.allergens ?? [],
    avoid: p?.avoid_categories ?? [],
    strictMayContain: p?.strict_may_contain ?? false,
    householdSize: p?.household_size ?? 1,
    weeklyBudgetCents: p?.weekly_budget_cents ?? null,
    homeZip: p?.home_zip ?? null,
    favoriteCuisines: (cuisines.data ?? []).map(
      (c: { cuisine_slug: string }) => c.cuisine_slug,
    ),
    favoriteIngredients: ingredientRefs(
      favorites.data as unknown as { ingredient: IngredientRef | null }[],
    ),
    dislikedIngredients: ingredientRefs(
      dislikes.data as unknown as { ingredient: IngredientRef | null }[],
    ),
  }
}

/** Replace the user's rows in a "one row per choice" table. */
async function replaceRows(
  db: SupabaseClient,
  table: string,
  userId: string,
  column: string,
  values: string[],
): Promise<void> {
  const del = await db.from(table).delete().eq('user_id', userId)
  if (del.error) throw del.error
  if (!values.length) return
  const ins = await db
    .from(table)
    .insert(values.map((v) => ({ user_id: userId, [column]: v })))
  if (ins.error) throw ins.error
}

/** Save the user's preferences, replacing their diet, cuisine and
 *  ingredient rows with these. */
export async function savePreferences(
  db: SupabaseClient,
  userId: string,
  p: Preferences,
): Promise<void> {
  const profile = await db.from('profiles').upsert({
    user_id: userId,
    allergens: p.allergens,
    avoid_categories: p.avoid,
    strict_may_contain: p.strictMayContain,
    household_size: p.householdSize,
    weekly_budget_cents: p.weeklyBudgetCents,
    home_zip: p.homeZip,
  })
  if (profile.error) throw profile.error
  await replaceRows(db, 'user_diets', userId, 'diet_slug', p.diets)
  await replaceRows(
    db,
    'user_favorite_cuisines',
    userId,
    'cuisine_slug',
    p.favoriteCuisines,
  )
  await replaceRows(
    db,
    'user_favorite_ingredients',
    userId,
    'ingredient_id',
    p.favoriteIngredients.map((i) => i.id),
  )
  await replaceRows(
    db,
    'user_disliked_ingredients',
    userId,
    'ingredient_id',
    p.dislikedIngredients.map((i) => i.id),
  )
}

export async function referenceOptions(
  db: SupabaseClient,
): Promise<{ diets: Option[]; cuisines: Option[] }> {
  const [diets, cuisines] = await Promise.all([
    db.from('diets').select('slug, name').order('name'),
    db.from('cuisines').select('slug, name').order('name'),
  ])
  if (diets.error) throw diets.error
  if (cuisines.error) throw cuisines.error
  return { diets: diets.data as Option[], cuisines: cuisines.data as Option[] }
}

export async function searchIngredients(
  db: SupabaseClient,
  query: string,
): Promise<IngredientRef[]> {
  const q = query.trim().replace(/[%_,()]/g, '')
  if (q.length < 2) return []
  const { data, error } = await db
    .from('ingredients')
    .select('id, name')
    .ilike('name', `%${q}%`)
    .order('name')
    .limit(8)
  if (error) throw error
  return data as IngredientRef[]
}

// ---------- the shared catalog ----------

export interface CatalogRecipe {
  id: string
  title: string
  sourceName: string | null
  totalMinutes: number | null
  /** How it fits the user's rules: fits, check_label or unknown. */
  fit: 'fits' | 'check_label' | 'unknown'
  /** Why it ranks where it does ("a main ingredient", "a favorite cuisine"). */
  why: string[]
}

export const PAGE_SIZE = 30

/** The shared catalog, searched by what the query means and ranked for the
 *  signed-in user (search_recipes in the database). */
export async function searchCatalog(
  db: SupabaseClient,
  query: string,
  offset = 0,
): Promise<CatalogRecipe[]> {
  const { data, error } = await db.rpc('search_recipes', {
    p_query: query.trim().slice(0, 200),
    p_limit: PAGE_SIZE,
    p_offset: offset,
  })
  if (error) throw error
  return (
    data as {
      id: string
      title: string
      source_name: string | null
      total_minutes: number | null
      fit: CatalogRecipe['fit']
      why: string[] | null
    }[]
  ).map((r) => ({
    id: r.id,
    title: r.title,
    sourceName: r.source_name,
    totalMinutes: r.total_minutes,
    fit: r.fit,
    why: r.why ?? [],
  }))
}

export async function saveToLibrary(
  db: SupabaseClient,
  userId: string,
  recipeId: string,
): Promise<void> {
  const { error } = await db
    .from('user_saved_recipes')
    .upsert(
      { user_id: userId, recipe_id: recipeId },
      { ignoreDuplicates: true },
    )
  if (error) throw error
}
