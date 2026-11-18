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

/** A few recipes for each ingredient in season (TYL-90): by ingredient id,
 *  the user's saved ones first. */
export async function loadSeasonalRecipes(
  db: SupabaseClient,
  ingredientIds: string[],
  per = 4,
): Promise<
  Map<
    string,
    { id: string; title: string; saved: boolean; source: string | null }[]
  >
> {
  const out = new Map<
    string,
    { id: string; title: string; saved: boolean; source: string | null }[]
  >()
  if (!ingredientIds.length) return out
  const { data, error } = await db.rpc('seasonal_recipes', {
    p_ingredients: ingredientIds,
    p_per: per,
  })
  if (error) throw error
  for (const r of data as {
    ingredient_id: string
    recipe_id: string
    title: string
    saved: boolean
    source_name: string | null
  }[])
    out.set(r.ingredient_id, [
      ...(out.get(r.ingredient_id) ?? []),
      {
        id: r.recipe_id,
        title: r.title,
        saved: r.saved,
        source: r.source_name,
      },
    ])
  return out
}

/** What arrives next month and isn't in season now: by name. */
export function comingNext(
  seasons: Seasons,
  month: number,
): { ingredientId: string; name: string }[] {
  const next = (month % 12) + 1
  return [...seasons]
    .filter(
      ([id]) =>
        seasonOf(seasons, id, next) === 'in' &&
        seasonOf(seasons, id, month) === 'out',
    )
    .map(([ingredientId, s]) => ({ ingredientId, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** A season in words: [6,7,8,9] -> "Jun–Sep", [11,12,1,2] -> "Nov–Feb",
 *  [4,5,9,10] -> "Apr–May, Sep–Oct". */
export function monthsText(months: number[]): string {
  const set = new Set(months)
  if (set.size >= 12) return 'all year'
  // Start each run at a month whose month before isn't in season.
  const runs: [number, number][] = []
  for (let m = 1; m <= 12; m++) {
    const before = m === 1 ? 12 : m - 1
    if (!set.has(m) || set.has(before)) continue
    let end = m
    while (set.has((end % 12) + 1) && (end % 12) + 1 !== m) end = (end % 12) + 1
    runs.push([m, end])
  }
  return runs
    .map(([a, b]) =>
      a === b
        ? MONTH_NAMES[a - 1]
        : `${MONTH_NAMES[a - 1]}–${MONTH_NAMES[b - 1]}`,
    )
    .join(', ')
}
