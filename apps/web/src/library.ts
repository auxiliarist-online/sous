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
  sourceUrl: string
  sourceName: string | null
  totalMinutes: number | null
  savedAt: string
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
    total_minutes: number | null
    source: { name: string } | null
  } | null
}

/** Recipes the user has saved, newest first. Row-level security limits this
 *  to their own rows. */
export async function savedRecipes(db: SupabaseClient): Promise<SavedRecipe[]> {
  const { data, error } = await db
    .from('user_saved_recipes')
    .select(
      'created_at, recipe:recipes(id, title, source_url, total_minutes, source:recipe_sources(name))',
    )
    .order('created_at', { ascending: false })
  if (error) throw error
  return ((data ?? []) as unknown as SavedRow[])
    .filter((row) => row.recipe?.source_url)
    .map((row) => ({
      id: row.recipe!.id,
      title: row.recipe!.title,
      sourceUrl: row.recipe!.source_url!,
      sourceName: row.recipe!.source?.name ?? null,
      totalMinutes: row.recipe!.total_minutes,
      savedAt: row.created_at,
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
