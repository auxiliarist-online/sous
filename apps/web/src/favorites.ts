/**
 * Favorite recipes (TYL-66) and what the user planned or cooked lately, for
 * the plan's suggestions. Both read and write under row-level security.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { addDays } from './plan.ts'
import { weeksAgo, type Frequency, type Recent } from './variety.ts'

/** Make a recipe a favorite with how often it should come back, or (null)
 *  stop. */
export async function setFavorite(
  db: SupabaseClient,
  recipeId: string,
  frequency: Frequency | null,
): Promise<void> {
  const { error } =
    frequency === null
      ? await db
          .from('user_favorite_recipes')
          .delete()
          .eq('recipe_id', recipeId)
      : await db
          .from('user_favorite_recipes')
          .upsert(
            { recipe_id: recipeId, frequency },
            { onConflict: 'user_id,recipe_id' },
          )
  if (error) throw error
}

/** Make a recipe a favorite unless it already is (keeping its rhythm): what
 *  a ❤️ after "Cooked it" offers. */
export async function addFavorite(
  db: SupabaseClient,
  recipeId: string,
): Promise<void> {
  const { error } = await db
    .from('user_favorite_recipes')
    .upsert(
      { recipe_id: recipeId },
      { onConflict: 'user_id,recipe_id', ignoreDuplicates: true },
    )
  if (error) throw error
}

/** Recipes planned or cooked in the weeks before `weekStart` (and in it),
 *  each with how many weeks ago it last was. */
export async function recentRecipes(
  db: SupabaseClient,
  weekStart: string,
  weeks: number,
): Promise<Recent> {
  const since = addDays(weekStart, -7 * weeks)
  const [planned, cooked] = await Promise.all([
    db
      .from('meal_plan_entries')
      .select('recipe_id, plan:meal_plans!inner(week_start)')
      .gte('plan.week_start', since)
      .lte('plan.week_start', weekStart),
    db
      .from('cooked_meals')
      .select('recipe_id, cooked_on')
      .gte('cooked_on', since)
      .lt('cooked_on', addDays(weekStart, 7)),
  ])
  if (planned.error) throw planned.error
  if (cooked.error) throw cooked.error
  const out: Recent = {}
  const note = (id: string, iso: string) => {
    const ago = weeksAgo(iso, weekStart)
    out[id] = Math.min(out[id] ?? ago, ago)
  }
  for (const r of planned.data as unknown as {
    recipe_id: string
    plan: { week_start: string }
  }[]) {
    note(r.recipe_id, r.plan.week_start)
  }
  for (const r of cooked.data as { recipe_id: string; cooked_on: string }[]) {
    note(r.recipe_id, r.cooked_on)
  }
  return out
}
