// Importing recipes and reading the user's library (TYL-35, ADR 0002).
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { apiFetch } from './auth.ts'

export interface ImportResult {
  recipe_id: string
  created: boolean
  title: string
  source_name: string | null
  source_url: string
  visibility: 'public' | 'private'
  status: string
}

export interface SavedRecipe {
  id: string
  title: string
  /** Null for a recipe the user typed in themselves. */
  sourceUrl: string | null
  sourceName: string | null
  sourceNote: string | null
  totalMinutes: number | null
  savedAt: string
  /** Diet labels earned from the ingredients (or set by a reviewer). */
  diets: DietLabel[]
  /** Parsed ingredient names, for search. */
  ingredients: string[]
}

/** A diet a recipe fits. `checks` lists ingredients whose brand decides it:
 *  "refried beans may contain meat" (lard). */
export interface DietLabel {
  slug: string
  checks: { ingredient: string; may_contain: string[] }[]
}

export class ImportError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** The first web address in some shared text. Android often puts the link
 *  in `text` ("Lentil soup https://…") rather than `url`. */
export function firstUrl(
  ...parts: (string | null | undefined)[]
): string | null {
  for (const part of parts) {
    const match = part?.match(/https?:\/\/[^\s<>"']+/i)
    if (match) return match[0].replace(/[.,;:!?)\]]+$/, '')
  }
  return null
}

export function importRecipe(
  session: Session,
  url: string,
  send: typeof apiFetch = apiFetch,
): Promise<ImportResult> {
  return importVia(send, session, '/recipes/import', { url })
}

async function importVia(
  send: typeof apiFetch,
  session: Session,
  path: string,
  body: object,
): Promise<ImportResult> {
  let resp: Response
  try {
    resp = await send(session, path, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  } catch {
    throw new ImportError(
      'offline',
      "We couldn't reach Sous. Check your connection.",
    )
  }
  if (resp.ok) return (await resp.json()) as ImportResult
  if (resp.status === 401) {
    throw new ImportError(
      'signed_out',
      'Your session has expired. Sign in again.',
    )
  }
  const detail = (
    (await resp.json().catch(() => null)) as {
      detail?: { code?: string; message?: string }
    } | null
  )?.detail
  if (detail && typeof detail === 'object' && detail.message) {
    throw new ImportError(detail.code ?? 'error', detail.message)
  }
  throw new ImportError(
    'error',
    'Something went wrong saving that recipe. Try again.',
  )
}

interface SavedRow {
  created_at: string
  recipe: {
    id: string
    title: string
    source_url: string | null
    source_note: string | null
    total_minutes: number | null
    source: { name: string } | null
    diets:
      | {
          diet_slug: string
          source: string
          checks: DietLabel['checks'] | null
        }[]
      | null
    ingredients: { name: string | null }[] | null
  } | null
}

/** Recipes the user has saved, newest first. Row-level security limits this
 *  to their own rows. */
export async function savedRecipes(db: SupabaseClient): Promise<SavedRecipe[]> {
  const { data, error } = await db
    .from('user_saved_recipes')
    .select(
      'created_at, recipe:recipes(id, title, source_url, source_note, total_minutes, source:recipe_sources(name), diets:recipe_diets(diet_slug, source, checks), ingredients:recipe_ingredients(name))',
    )
    .order('created_at', { ascending: false })
  if (error) throw error
  return ((data ?? []) as unknown as SavedRow[])
    .filter((row) => row.recipe)
    .map((row) => ({
      id: row.recipe!.id,
      title: row.recipe!.title,
      sourceUrl: row.recipe!.source_url,
      sourceName: row.recipe!.source?.name ?? null,
      sourceNote: row.recipe!.source_note,
      totalMinutes: row.recipe!.total_minutes,
      savedAt: row.created_at,
      // The publisher's own tags are only hints; show what the ingredients prove.
      diets: (row.recipe!.diets ?? [])
        .filter((d) => d.source !== 'publisher')
        .map((d) => ({ slug: d.diet_slug, checks: d.checks ?? [] })),
      ingredients: (row.recipe!.ingredients ?? []).flatMap((i) =>
        i.name ? [i.name] : [],
      ),
    }))
}

export async function removeSaved(
  db: SupabaseClient,
  recipeId: string,
): Promise<void> {
  const { error } = await db
    .from('user_saved_recipes')
    .delete()
    .eq('recipe_id', recipeId)
  if (error) throw error
}

/** A recipe page's data, read by the bookmarklet in the user's own browser. */
export interface PageData {
  url: string
  siteName: string | null
  ld: string[]
}

export async function importPage(
  session: Session,
  page: PageData,
  send: typeof apiFetch = apiFetch,
): Promise<ImportResult> {
  return importVia(send, session, '/recipes/import-page', {
    url: page.url,
    site_name: page.siteName,
    ld: page.ld,
  })
}

/** A link plus ingredient lines the user copied from a page that blocks Sous
 *  (TYL-59). With no lines it's saved as a link to come back to. */
export async function importText(
  session: Session,
  recipe: { url: string; title: string; ingredients: string[] },
  send: typeof apiFetch = apiFetch,
): Promise<ImportResult> {
  return importVia(send, session, '/recipes/import-text', recipe)
}

function isRecipe(node: unknown): node is { name?: unknown } {
  if (!node || typeof node !== 'object') return false
  const type = (node as { '@type'?: unknown })['@type']
  return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))
}

/** The recipe's name from a page's JSON-LD, for the confirm screen. */
export function recipeTitle(ld: string[]): string | null {
  for (const block of ld) {
    let data: unknown
    try {
      data = JSON.parse(block)
    } catch {
      continue
    }
    const graph = (data as { '@graph'?: unknown })?.['@graph']
    const nodes = [data, graph].flat(2)
    const recipe = nodes.find(isRecipe)
    if (recipe && typeof recipe.name === 'string') return recipe.name.trim()
  }
  return null
}

const SHOWN_DIETS: [slug: string, label: string][] = [
  ['vegan', 'Vegan'],
  ['vegetarian', 'Vegetarian'],
  ['gluten_free', 'Gluten-free'],
  ['dairy_free', 'Dairy-free'],
]

const CATEGORY_NAMES: Record<string, string> = {
  animal_rennet: 'animal rennet',
  tree_nut: 'tree nuts',
  peanut: 'peanuts',
}

function list(words: string[]): string {
  return words.length < 2
    ? words.join('')
    : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`
}

/** The labels worth showing on a card (vegan already says vegetarian), each
 *  starred when it depends on brand, and one note per ingredient to check. */
export function dietLabels(diets: DietLabel[]): {
  labels: string[]
  notes: string[]
  /** Ingredient names to star: their brand decides a shown label. */
  starred: string[]
} {
  const bySlug = new Map(diets.map((d) => [d.slug, d]))
  const shown = SHOWN_DIETS.filter(
    ([slug]) =>
      bySlug.has(slug) && !(slug === 'vegetarian' && bySlug.has('vegan')),
  )
  const checks = new Map<string, Set<string>>()
  const labels = shown.map(([slug, label]) => {
    const d = bySlug.get(slug)!
    for (const c of d.checks) {
      const set = checks.get(c.ingredient) ?? new Set<string>()
      c.may_contain.forEach((m) => set.add(CATEGORY_NAMES[m] ?? m))
      checks.set(c.ingredient, set)
    }
    return d.checks.length ? `${label}*` : label
  })
  const notes = [...checks].map(
    ([ingredient, cats]) =>
      `Check the ${ingredient}: some brands contain ${list([...cats].sort())}.`,
  )
  return { labels, notes, starred: [...checks.keys()] }
}

/** Where a recipe is from, for a card: the site, or the user's own note. */
export function sourceLabel(
  name: string | null,
  url: string | null,
  note: string | null = null,
): string {
  if (url) return name || new URL(url).hostname.replace(/^www\./, '')
  return note ? `Your recipe · ${note}` : 'Your recipe'
}

export interface RecipeFilter {
  query: string
  /** Every one of these diets (a starred, check-the-label fit counts). */
  diets: string[]
  maxMinutes: number | null
}

export const NO_FILTER: RecipeFilter = {
  query: '',
  diets: [],
  maxMinutes: null,
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Recipes matching every filter. The query matches the start of words in the
 *  title, source or ingredient names ("lent" finds "Red lentil dal"). */
export function filterRecipes(
  recipes: SavedRecipe[],
  f: RecipeFilter,
): SavedRecipe[] {
  const terms = words(f.query)
  return recipes.filter((r) => {
    if (
      f.maxMinutes !== null &&
      !(r.totalMinutes && r.totalMinutes <= f.maxMinutes)
    )
      return false
    const has = new Set(r.diets.map((d) => d.slug))
    if (!f.diets.every((d) => has.has(d))) return false
    if (!terms.length) return true
    const haystack = words(
      [r.title, r.sourceName ?? '', r.sourceNote ?? '', ...r.ingredients].join(
        ' ',
      ),
    )
    return terms.every((t) => haystack.some((w) => w.startsWith(t)))
  })
}
