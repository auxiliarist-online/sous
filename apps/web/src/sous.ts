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
  isOptional: boolean
}

export interface RecipeDetail {
  id: string
  title: string
  sourceUrl: string | null
  sourceName: string | null
  sourceNote: string | null
  servings: number | null
  prepMinutes: number | null
  cookMinutes: number | null
  totalMinutes: number | null
  instructions: string[] | null
  /** True for a recipe the user typed in themselves (they can edit it). */
  handTyped: boolean
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
  source: { name: string } | null
  ingredients: {
    line_no: number
    option_no: number
    raw_text: string
    section: string | null
    name: string | null
    is_optional: boolean
  }[]
  diets: {
    diet_slug: string
    source: string
    checks: DietLabel['checks'] | null
  }[]
  cuisines: { cuisine_slug: string }[]
}

export async function recipeDetail(
  db: SupabaseClient,
  userId: string,
  id: string,
): Promise<RecipeDetail | null> {
  const { data, error } = await db
    .from('recipes')
    .select(
      `id, title, source_url, source_note, servings, prep_minutes, cook_minutes, total_minutes,
       instructions, added_by, source:recipe_sources(name),
       ingredients:recipe_ingredients(line_no, option_no, raw_text, section, name, is_optional),
       diets:recipe_diets(diet_slug, source, checks), cuisines:recipe_cuisines(cuisine_slug)`,
    )
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const r = data as unknown as RecipeRow
  return {
    id: r.id,
    title: r.title,
    sourceUrl: r.source_url,
    sourceName: r.source?.name ?? null,
    sourceNote: r.source_note,
    servings: r.servings,
    prepMinutes: r.prep_minutes,
    cookMinutes: r.cook_minutes,
    totalMinutes: r.total_minutes,
    instructions: r.instructions,
    handTyped: !r.source_url && r.added_by === userId,
    ingredients: [...r.ingredients]
      .sort((a, b) => a.line_no - b.line_no || a.option_no - b.option_no)
      .map((i) => ({
        lineNo: i.line_no,
        optionNo: i.option_no,
        rawText: i.raw_text,
        section: i.section,
        name: i.name,
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

export async function loadPreferences(
  db: SupabaseClient,
  userId: string,
): Promise<Preferences> {
  const [profile, diets, cuisines, favorites, dislikes] = await Promise.all([
    db
      .from('profiles')
      .select(
        'allergens, avoid_categories, strict_may_contain, household_size, weekly_budget_cents',
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
  } | null
  return {
    saved: !!p,
    diets: (diets.data ?? []).map((d: { diet_slug: string }) => d.diet_slug),
    allergens: p?.allergens ?? [],
    avoid: p?.avoid_categories ?? [],
    strictMayContain: p?.strict_may_contain ?? false,
    householdSize: p?.household_size ?? 1,
    weeklyBudgetCents: p?.weekly_budget_cents ?? null,
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
