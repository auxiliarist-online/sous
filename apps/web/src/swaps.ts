// Substitutions (TYL-77): swaps for an ingredient you're out of or your diet
// rules out, the ones the user chose for a recipe, and how a recipe fits
// with swaps.
import type { SupabaseClient } from '@supabase/supabase-js'
import { amountText } from './plan.ts'
import type { IngredientLine } from './sous.ts'

export interface Swap {
  id: string
  fromId: string
  toId: string
  toName: string
  /** The recipe's amount times this: in toUnit per one perUnit of the
   *  recipe's ingredient when set, else in the recipe's own unit. */
  factor: number
  toUnit: string | null
  perUnit: string | null
  /** What else it takes, in small amounts ("lemon juice"), and their ids. */
  extras: string[]
  extraIds: string[]
  uses: 'any' | 'baking' | 'cooking'
  quality: 'good' | 'pinch'
  note: string
}

/** How a recipe fits the user with swaps: how many lines need one, the
 *  swaps that fix each (by the ingredient swapped out), and whether it fits
 *  with the swaps the user chose, every line checked as it will be cooked. */
export interface SwapFit {
  count: number
  fixes: Record<string, string[]>
  chosen: boolean
}

/** The swaps for these ingredients, best first. */
export async function loadSwaps(
  db: SupabaseClient,
  ingredientIds: string[],
): Promise<Swap[]> {
  if (!ingredientIds.length) return []
  const { data, error } = await db
    .from('substitutions')
    .select(
      'id, from_ingredient_id, to_ingredient_id, factor, to_unit, per_unit, extras, uses, quality, note, to:ingredients!substitutions_to_ingredient_id_fkey(name)',
    )
    .in('from_ingredient_id', ingredientIds)
    .order('quality')
    .order('key')
  if (error) throw error
  const rows = data as unknown as {
    id: string
    from_ingredient_id: string
    to_ingredient_id: string
    factor: number | string
    to_unit: string | null
    per_unit: string | null
    extras: string[]
    uses: Swap['uses']
    quality: Swap['quality']
    note: string
    to: { name: string } | null
  }[]
  // The extras' names.
  const extraIds = [...new Set(rows.flatMap((r) => r.extras))]
  const names = new Map<string, string>()
  if (extraIds.length) {
    const { data: found, error: e } = await db
      .from('ingredients')
      .select('id, name')
      .in('id', extraIds)
    if (e) throw e
    for (const i of found as { id: string; name: string }[])
      names.set(i.id, i.name)
  }
  return rows.map((r) => ({
    id: r.id,
    fromId: r.from_ingredient_id,
    toId: r.to_ingredient_id,
    toName: r.to?.name ?? '',
    factor: Number(r.factor),
    toUnit: r.to_unit,
    perUnit: r.per_unit,
    extras: r.extras.flatMap((x) => (names.has(x) ? [names.get(x)!] : [])),
    extraIds: r.extras,
    uses: r.uses,
    quality: r.quality,
    note: r.note,
  }))
}

/** The swaps the user chose for a recipe: swap id by the ingredient
 *  swapped out. */
export async function loadRecipeSwaps(
  db: SupabaseClient,
  recipeId: string,
): Promise<Record<string, string>> {
  const { data, error } = await db
    .from('user_recipe_swaps')
    .select('from_ingredient_id, substitution_id')
    .eq('recipe_id', recipeId)
  if (error) throw error
  return Object.fromEntries(
    (data as { from_ingredient_id: string; substitution_id: string }[]).map(
      (r) => [r.from_ingredient_id, r.substitution_id],
    ),
  )
}

/** Choose a swap for an ingredient in a recipe, or (null) go back to the
 *  recipe's own. */
export async function setRecipeSwap(
  db: SupabaseClient,
  userId: string,
  recipeId: string,
  fromId: string,
  swapId: string | null,
): Promise<void> {
  const { error } = swapId
    ? await db.from('user_recipe_swaps').upsert({
        user_id: userId,
        recipe_id: recipeId,
        from_ingredient_id: fromId,
        substitution_id: swapId,
      })
    : await db
        .from('user_recipe_swaps')
        .delete()
        .eq('user_id', userId)
        .eq('recipe_id', recipeId)
        .eq('from_ingredient_id', fromId)
  if (error) throw error
}

/** How the recipe fits the signed-in user with swaps, or null. */
export async function loadSwapFit(
  db: SupabaseClient,
  recipeId: string,
): Promise<SwapFit | null> {
  const { data, error } = await db.rpc('my_recipe_swap_fit', {
    p_recipe_id: recipeId,
  })
  if (error) throw error
  return (data as SwapFit | null) ?? null
}

// The recipe's way of saying a unit, as the swap data says it.
const UNIT: Record<string, string> = {
  tablespoon: 'tbsp',
  tablespoons: 'tbsp',
  teaspoon: 'tsp',
  teaspoons: 'tsp',
  cups: 'cup',
  cloves: 'clove',
}

/** What a line becomes with a swap: "1 cup whole milk + lemon juice". The
 *  amount is worked out where the units allow (2 eggs at 1 tbsp flaxseed
 *  each is 2 tbsp); otherwise just what to use, and the note says how. */
export function swapText(line: IngredientLine, swap: Swap): string {
  const extras = swap.extras.length ? ` + ${swap.extras.join(' + ')}` : ''
  const q = line.quantity
  const unit = line.unit ? (UNIT[line.unit] ?? line.unit) : null
  let amount: string | null = null
  if (q != null && swap.toUnit) {
    if ((unit ?? 'each') === swap.perUnit)
      amount = amountText(q * swap.factor, swap.toUnit)
  } else if (q != null) amount = amountText(q * swap.factor, line.unit ?? '')
  return `${amount ? `${amount} ` : ''}${swap.toName}${extras}`
}
