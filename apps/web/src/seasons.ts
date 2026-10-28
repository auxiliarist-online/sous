/**
 * Seasonal produce (TYL-70): what's in season where the user lives. Their
 * home zip's state chart where Sous has one (North Carolina so far), else the
 * USDA SNAP-Ed national guide; the database picks (my_seasons()).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** By ingredient id: its name and the months (1–12) it's in season. */
export type Seasons = Map<string, { name: string; months: number[] }>

/** In season 8 months a year or fewer: herbs and onions in season all year
 *  aren't news, so they're never called "in season". */
export const SEASONAL_MONTHS = 8

/** The user's seasons, by ingredient. */
export async function loadSeasons(db: SupabaseClient): Promise<Seasons> {
  const { data, error } = await db.rpc('my_seasons')
  if (error) throw error
  return new Map(
    (data as { ingredient_id: string; name: string; months: number[] }[]).map(
      (s) => [s.ingredient_id, { name: s.name, months: s.months }],
    ),
  )
}

/** Whether an ingredient is seasonal (not all year) and in season in `month`
 *  (1–12), or out of it. Null when it isn't seasonal or isn't known. */
export function seasonOf(
  seasons: Seasons,
  ingredientId: string | null | undefined,
  month: number,
): 'in' | 'out' | null {
  const s = ingredientId ? seasons.get(ingredientId) : undefined
  if (!s || s.months.length > SEASONAL_MONTHS) return null
  return s.months.includes(month) ? 'in' : 'out'
}

/** What a recipe has in season this month: the names, when its seasonal
 *  produce is mostly in season (a recipe heavy in out-of-season produce isn't
 *  promoted); else none. */
export function recipeInSeason(
  seasons: Seasons,
  ingredientIds: (string | null | undefined)[],
  month: number,
): string[] {
  const inSeason = new Set<string>()
  let out = 0
  for (const id of new Set(ingredientIds)) {
    const s = seasonOf(seasons, id, month)
    if (s === 'in') inSeason.add(seasons.get(id!)!.name)
    if (s === 'out') out++
  }
  return inSeason.size > 0 && inSeason.size >= out ? [...inSeason] : []
}

/** The seasonal produce in season this month, by name. */
export function inSeasonNow(
  seasons: Seasons,
  month: number,
): { ingredientId: string; name: string }[] {
  return [...seasons]
    .filter(([id]) => seasonOf(seasons, id, month) === 'in')
    .map(([ingredientId, s]) => ({ ingredientId, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Which seasons chart a zip gets, in words (TYL-145): a missing zip quietly
 *  meant national seasons. Keep in step with season_region() in
 *  supabase/migrations/20261022010000_seasons.sql. */
export function seasonsFrom(zip: string | null): string {
  if (!zip)
    return "No home zip yet, so the USDA's national guide. Find your store below to set it."
  return /^(27|28)\d{3}$/.test(zip)
    ? `North Carolina's chart, from your zip ${zip}.`
    : `The USDA's national guide (no state chart for ${zip} yet).`
}
