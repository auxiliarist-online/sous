/**
 * "Cooked it" (TYL-68): what the user cooked, when, at what size, with a quick
 * rating and a private note. Kept in `cooked_meals` under row-level security
 * (their own rows only).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PantryKind } from './pantry.ts'
import type { PantryStatus } from './plan.ts'

export type Rating = 'down' | 'up' | 'love'

export interface Cooked {
  id: string
  recipeId: string
  /** The plan entry it was cooked from, if any. */
  planEntryId: string | null
  /** YYYY-MM-DD */
  cookedOn: string
  scale: number
  rating: Rating | null
  note: string | null
}

/** What the recipe page shows: how often, when last, and the latest note. */
export interface CookedSummary {
  times: number
  lastOn: string | null
  /** The most recent note, and the day it was written for. */
  note: { text: string; on: string } | null
}

/** One line of the user's history. */
export interface HistoryItem extends Cooked {
  title: string
}

/** What a page needs to mark meals cooked and rate them. */
export interface CookedApi {
  /** The cooked records for these plan entries, by entry id. */
  cookedEntries(entryIds: string[]): Promise<Record<string, Cooked>>
  /** Record a meal as cooked; a plan entry already cooked returns its record. */
  markCooked(meal: {
    recipeId: string
    planEntryId?: string | null
    cookedOn: string
    scale?: number
  }): Promise<Cooked>
  /** Set or change a cooked meal's rating and note. */
  rateCooked(
    id: string,
    patch: { rating?: Rating | null; note?: string | null },
  ): Promise<void>
  /** Take back a "cooked" tapped by mistake. */
  undoCooked(id: string): Promise<void>
  /** Make it a favorite unless it already is: what a ❤️ offers (TYL-66). */
  addFavorite(recipeId: string): Promise<void>
  /** What's on hand that the recipe uses, to ask if it's used up (TYL-137). */
  onHandIn(recipeId: string): Promise<{ ingredientId: string; name: string }[]>
  /** Mark an ingredient in the pantry; null takes it out (it's used up). */
  setPantry(
    ingredientId: string,
    status: PantryStatus | null,
    kind?: PantryKind,
  ): Promise<void>
}

interface Row {
  id: string
  recipe_id: string
  plan_entry_id: string | null
  cooked_on: string
  scale: number | string
  rating: Rating | null
  note: string | null
}

const COLUMNS = 'id, recipe_id, plan_entry_id, cooked_on, scale, rating, note'

/** A row as the app reads it. */
function fromRow(r: Row): Cooked {
  return {
    id: r.id,
    recipeId: r.recipe_id,
    planEntryId: r.plan_entry_id,
    cookedOn: r.cooked_on,
    scale: Number(r.scale),
    rating: r.rating,
    note: r.note,
  }
}

/** The cooked records for some plan entries, by entry id. */
export async function cookedEntries(
  db: SupabaseClient,
  entryIds: string[],
): Promise<Record<string, Cooked>> {
  if (entryIds.length === 0) return {}
  const { data, error } = await db
    .from('cooked_meals')
    .select(COLUMNS)
    .in('plan_entry_id', entryIds)
  if (error) throw error
  return Object.fromEntries(
    (data as Row[]).map((r) => [r.plan_entry_id!, fromRow(r)]),
  )
}

/** Record a meal as cooked. A plan entry counts once: tapping it again (on
 *  another phone, say) returns the record already there. */
export async function markCooked(
  db: SupabaseClient,
  meal: {
    recipeId: string
    planEntryId?: string | null
    cookedOn: string
    scale?: number
  },
): Promise<Cooked> {
  const { data, error } = await db
    .from('cooked_meals')
    .insert({
      recipe_id: meal.recipeId,
      plan_entry_id: meal.planEntryId ?? null,
      cooked_on: meal.cookedOn,
      scale: meal.scale ?? 1,
    })
    .select(COLUMNS)
    .single()
  if (!error) return fromRow(data as Row)
  if (error.code === '23505' && meal.planEntryId) {
    const found = await cookedEntries(db, [meal.planEntryId])
    if (found[meal.planEntryId]) return found[meal.planEntryId]
  }
  throw error
}

/** Set or change the rating and note on a cooked meal. */
export async function rateCooked(
  db: SupabaseClient,
  id: string,
  patch: { rating?: Rating | null; note?: string | null },
): Promise<void> {
  const row: { rating?: Rating | null; note?: string | null } = {}
  if (patch.rating !== undefined) row.rating = patch.rating
  if (patch.note !== undefined) row.note = patch.note?.trim() || null
  const { error } = await db.from('cooked_meals').update(row).eq('id', id)
  if (error) throw error
}

/** Delete a cooked record (an "undo"). */
export async function undoCooked(
  db: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await db.from('cooked_meals').delete().eq('id', id)
  if (error) throw error
}

/** How often the user cooked a recipe, when last, and their latest note. */
export async function cookedSummary(
  db: SupabaseClient,
  recipeId: string,
): Promise<CookedSummary> {
  const { data, error } = await db
    .from('cooked_meals')
    .select(COLUMNS)
    .eq('recipe_id', recipeId)
    .order('cooked_on', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  const rows = (data as Row[]).map(fromRow)
  const noted = rows.find((r) => r.note)
  return {
    times: rows.length,
    lastOn: rows[0]?.cookedOn ?? null,
    note: noted ? { text: noted.note!, on: noted.cookedOn } : null,
  }
}

/** Everything the user cooked, most recent first. */
export async function cookingHistory(
  db: SupabaseClient,
): Promise<HistoryItem[]> {
  const { data, error } = await db
    .from('cooked_meals')
    .select(`${COLUMNS}, recipe:recipes(title)`)
    .order('cooked_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw error
  return (
    data as unknown as (Row & { recipe: { title: string } | null })[]
  ).map((r) => ({ ...fromRow(r), title: r.recipe?.title ?? 'A recipe' }))
}

/** "Oct 12" for a YYYY-MM-DD date. */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}
