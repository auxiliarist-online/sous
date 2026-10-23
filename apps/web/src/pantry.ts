/**
 * The pantry (TYL-133 to TYL-137, designed in TYL-97). Two kinds of entry:
 *
 * - a staple, something the user always keeps (salt, rice, soy sauce): "have"
 *   until marked out, and an out staple goes on the shopping list (checking it
 *   off there marks it "have" again, in the database);
 * - on hand, a one-off (half a bag of spinach): always "have", gone when used
 *   up or removed.
 *
 * Either way, "have" is left off the buy list; anything with no entry is
 * bought (TYL-88). Pantry-type ingredients come in aisle groups and starter
 * kits, from apps/api/data/pantry.csv.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PantryStatus } from './plan.ts'

export type PantryKind = 'staple' | 'on_hand'

/** The aisle groups the pantry page shows, in order. */
export const PANTRY_GROUPS = [
  ['spices', 'Spices & dried herbs'],
  ['oils_vinegars', 'Oils & vinegars'],
  ['baking', 'Baking'],
  ['sauces', 'Sauces & condiments'],
  ['grains', 'Rice, grains & pasta'],
  ['cans', 'Cans, jars & dried beans'],
  ['broths', 'Broths & stocks'],
  ['nuts', 'Nuts, seeds & dried fruit'],
] as const

export type PantryGroup = (typeof PANTRY_GROUPS)[number][0]

/** One thing in the user's pantry. */
export interface PantryEntry {
  ingredientId: string
  name: string
  status: PantryStatus
  kind: PantryKind
  /** Its aisle group, when it's a pantry-type ingredient. */
  group: PantryGroup | null
}

/** A pantry-type ingredient: one a person might keep as a staple. */
export interface PantryItem {
  id: string
  name: string
  group: PantryGroup
}

/** A starter kit: "basics", a cuisine's slug or a diet's slug. */
export interface Kit {
  kit: string
  ingredientIds: string[]
}

/** "You've used cumin in 4 recipes": a pantry item the user keeps reaching for. */
export interface Suggestion {
  ingredientId: string
  name: string
  recipes: number
}

/** What the user has in their pantry, with names and groups. */
export async function loadPantry(db: SupabaseClient): Promise<PantryEntry[]> {
  const { data, error } = await db
    .from('user_pantry')
    .select('status, kind, ingredient:ingredients(id, name, pantry_group)')
  if (error) throw error
  return (
    data as unknown as {
      status: PantryStatus
      kind: PantryKind
      ingredient: { id: string; name: string; pantry_group: string | null }
    }[]
  ).flatMap((r) =>
    r.ingredient
      ? [
          {
            ingredientId: r.ingredient.id,
            name: r.ingredient.name,
            status: r.status,
            kind: r.kind,
            group: (r.ingredient.pantry_group as PantryGroup | null) ?? null,
          },
        ]
      : [],
  )
}

/** Mark an ingredient in the pantry; a null status takes it out, so it's
 *  bought when a recipe needs it. On-hand entries are always "have". */
export async function setPantry(
  db: SupabaseClient,
  userId: string,
  ingredientId: string,
  status: PantryStatus | null,
  kind: PantryKind = 'staple',
): Promise<void> {
  const pantry = db.from('user_pantry')
  const { error } = status
    ? await pantry.upsert({
        user_id: userId,
        ingredient_id: ingredientId,
        status: kind === 'on_hand' ? 'have' : status,
        kind,
      })
    : await pantry
        .delete()
        .eq('user_id', userId)
        .eq('ingredient_id', ingredientId)
  if (error) throw error
}

/** Keep several staples at once ("Keep these 24"), all "have". */
export async function keepStaples(
  db: SupabaseClient,
  userId: string,
  ingredientIds: string[],
): Promise<void> {
  if (ingredientIds.length === 0) return
  const { error } = await db.from('user_pantry').upsert(
    ingredientIds.map((id) => ({
      user_id: userId,
      ingredient_id: id,
      status: 'have',
      kind: 'staple',
    })),
  )
  if (error) throw error
}

/** Every pantry-type ingredient, by name. */
export async function pantryCatalog(db: SupabaseClient): Promise<PantryItem[]> {
  const { data, error } = await db
    .from('ingredients')
    .select('id, name, pantry_group')
    .not('pantry_group', 'is', null)
    .order('name')
  if (error) throw error
  return (
    data as { id: string; name: string; pantry_group: PantryGroup }[]
  ).map((r) => ({ id: r.id, name: r.name, group: r.pantry_group }))
}

/** The starter kits and what's in each. */
export async function pantryKits(db: SupabaseClient): Promise<Kit[]> {
  const { data, error } = await db
    .from('pantry_kits')
    .select('kit, ingredient_id')
  if (error) throw error
  const kits = new Map<string, string[]>()
  for (const r of data as { kit: string; ingredient_id: string }[])
    kits.set(r.kit, [...(kits.get(r.kit) ?? []), r.ingredient_id])
  return [...kits].map(([kit, ingredientIds]) => ({ kit, ingredientIds }))
}

/** The kits for someone with these diets and favorite cuisines: basics first,
 *  then their cuisines', then their diets'. */
export function kitsFor(
  kits: Kit[],
  prefs: { diets: string[]; favoriteCuisines: string[] },
): Kit[] {
  const order = ['basics', ...prefs.favoriteCuisines, ...prefs.diets]
  return order.flatMap((slug) => kits.filter((k) => k.kit === slug))
}

/** The kits' items, each listed once (under the first kit that has it), and
 *  only pantry items the user doesn't already keep. Kits left empty go. */
export function kitItems(
  kits: Kit[],
  catalog: PantryItem[],
  kept: Set<string> = new Set(),
): { kit: string; items: PantryItem[] }[] {
  const byId = new Map(catalog.map((i) => [i.id, i]))
  const seen = new Set(kept)
  return kits.flatMap(({ kit, ingredientIds }) => {
    const items = ingredientIds
      .filter((id) => !seen.has(id) && byId.has(id))
      .map((id) => byId.get(id)!)
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const i of items) seen.add(i.id)
    return items.length ? [{ kit, items }] : []
  })
}

/** Pantry items the user keeps using but hasn't marked (TYL-136). */
export async function pantrySuggestions(
  db: SupabaseClient,
): Promise<Suggestion[]> {
  const { data, error } = await db.rpc('pantry_suggestions')
  if (error) throw error
  return (
    data as { ingredient_id: string; name: string; recipes: number }[]
  ).map((s) => ({
    ingredientId: s.ingredient_id,
    name: s.name,
    recipes: s.recipes,
  }))
}

/** The ingredients whose suggestions the user turned down. */
export async function dismissedSuggestions(
  db: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await db
    .from('user_pantry_dismissed')
    .select('ingredient_id')
  if (error) throw error
  return (data as { ingredient_id: string }[]).map((r) => r.ingredient_id)
}

/** "No thanks": don't suggest this one again. */
export async function dismissSuggestion(
  db: SupabaseClient,
  userId: string,
  ingredientId: string,
): Promise<void> {
  const { error } = await db
    .from('user_pantry_dismissed')
    .upsert(
      { user_id: userId, ingredient_id: ingredientId },
      { ignoreDuplicates: true },
    )
  if (error) throw error
}

/** What's on hand that a recipe uses: asked about after "Cooked it" (TYL-137). */
export async function onHandIn(
  db: SupabaseClient,
  recipeId: string,
): Promise<{ ingredientId: string; name: string }[]> {
  const { data, error } = await db.rpc('on_hand_in', { p_recipe: recipeId })
  if (error) throw error
  return (data as { ingredient_id: string; name: string }[]).map((r) => ({
    ingredientId: r.ingredient_id,
    name: r.name,
  }))
}
