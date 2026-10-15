// The weekly meal plan (TYL-15). Plans are read and edited straight against
// Supabase as the signed-in user (row-level security keeps them private, and
// only recipes the user can see can be planned); the API prices the week.
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { apiFetch } from './auth.ts'
import type { IngredientLine } from './sous.ts'

// ---------- weeks ----------

/** A local calendar date as YYYY-MM-DD (not UTC, so late evenings stay put). */
export function isoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function parseDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(iso: string, days: number): string {
  const d = parseDate(iso)
  d.setDate(d.getDate() + days)
  return isoDate(d)
}

/** The Monday starting the week that contains `d`. */
export function weekOf(d: Date = new Date()): string {
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  return isoDate(monday)
}

export function isMonday(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && parseDate(iso).getDay() === 1
}

/** "Oct 12 – 18", or "Sep 28 – Oct 4" across months. */
export function weekLabel(weekStart: string): string {
  const start = parseDate(weekStart)
  const end = parseDate(addDays(weekStart, 6))
  const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'short' })
  return start.getMonth() === end.getMonth()
    ? `${month(start)} ${start.getDate()} – ${end.getDate()}`
    : `${month(start)} ${start.getDate()} – ${month(end)} ${end.getDate()}`
}

export function dayName(iso: string): string {
  return parseDate(iso).toLocaleDateString('en-US', { weekday: 'long' })
}

/** The seven days of a week, Monday first. */
export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
}

// ---------- plans ----------

/** Recipes are planned at half, full or double size. */
export type Scale = 0.5 | 1 | 2

export const SCALES: [Scale, string][] = [
  [0.5, 'Half'],
  [1, 'Full'],
  [2, 'Double'],
]

export interface PlanEntry {
  id: string
  recipeId: string
  title: string
  scale: Scale
  /** What the recipe makes as written; null when the page didn't say. */
  recipeServings: number | null
  /** The day it's planned for, or null for "some day this week". */
  day: string | null
  position: number
}

interface EntryRow {
  id: string
  scale: number
  planned_for: string | null
  position: number
  recipe: { id: string; title: string; servings: number | null } | null
}

export async function loadPlan(
  db: SupabaseClient,
  weekStart: string,
): Promise<PlanEntry[]> {
  const { data, error } = await db
    .from('meal_plans')
    .select(
      'entries:meal_plan_entries(id, scale, planned_for, position, recipe:recipes(id, title, servings))',
    )
    .eq('week_start', weekStart)
    .maybeSingle()
  if (error) throw error
  const rows = ((data as { entries: EntryRow[] } | null)?.entries ?? [])
    // A recipe that's gone from view (removed) drops out of the plan.
    .filter((e) => e.recipe)
  return rows
    .map((e) => ({
      id: e.id,
      recipeId: e.recipe!.id,
      title: e.recipe!.title,
      scale: Number(e.scale) as Scale,
      recipeServings: e.recipe!.servings,
      day: e.planned_for,
      position: e.position,
    }))
    .sort((a, b) => a.position - b.position)
}

export async function addToPlan(
  db: SupabaseClient,
  weekStart: string,
  recipeId: string,
  scale: Scale = 1,
  day: string | null = null,
): Promise<void> {
  const { error } = await db.rpc('add_to_meal_plan', {
    p_week: weekStart,
    p_recipe: recipeId,
    p_scale: scale,
    p_day: day,
  })
  if (error) throw error
}

export async function updateEntry(
  db: SupabaseClient,
  id: string,
  patch: { scale?: Scale; day?: string | null },
): Promise<void> {
  const row: Record<string, unknown> = {}
  if (patch.scale !== undefined) row.scale = patch.scale
  if (patch.day !== undefined) row.planned_for = patch.day
  const { error } = await db.from('meal_plan_entries').update(row).eq('id', id)
  if (error) throw error
}

export async function removeEntry(
  db: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await db.from('meal_plan_entries').delete().eq('id', id)
  if (error) throw error
}

/** Copy one week's plan into another; returns how many recipes were copied. */
export async function copyPlan(
  db: SupabaseClient,
  from: string,
  to: string,
): Promise<number> {
  const { data, error } = await db.rpc('copy_meal_plan', {
    p_from: from,
    p_to: to,
  })
  if (error) throw error
  return data as number
}

/** How a recipe fits the user's diets, allergies and exclusions. */
export type Fit = 'fits' | 'check_label' | 'unknown' | 'excluded'

export async function recipeFits(
  db: SupabaseClient,
  ids: string[],
): Promise<Record<string, Fit>> {
  if (!ids.length) return {}
  const { data, error } = await db.rpc('my_recipe_fits', { p_recipe_ids: ids })
  if (error) throw error
  return Object.fromEntries(
    (data as { recipe_id: string; fit: Fit }[]).map((r) => [
      r.recipe_id,
      r.fit,
    ]),
  )
}

// ---------- the pantry (start of TYL-49) ----------

/** What the user has marked on hand or out, with names. */
export async function loadPantry(
  db: SupabaseClient,
): Promise<{ ingredientId: string; name: string; status: PantryStatus }[]> {
  const { data, error } = await db
    .from('user_pantry')
    .select('status, ingredient:ingredients(id, name)')
  if (error) throw error
  return (
    data as unknown as {
      status: PantryStatus
      ingredient: { id: string; name: string } | null
    }[]
  ).flatMap((r) =>
    r.ingredient
      ? [
          {
            ingredientId: r.ingredient.id,
            name: r.ingredient.name,
            status: r.status,
          },
        ]
      : [],
  )
}

export type PantryStatus = 'have' | 'out'

/** Record what the user has on hand; null forgets it (back to the default:
 *  staples on hand, everything else bought). */
export async function setPantry(
  db: SupabaseClient,
  userId: string,
  ingredientId: string,
  status: PantryStatus | null,
): Promise<void> {
  const { error } = status
    ? await db
        .from('user_pantry')
        .upsert({ user_id: userId, ingredient_id: ingredientId, status })
    : await db
        .from('user_pantry')
        .delete()
        .eq('user_id', userId)
        .eq('ingredient_id', ingredientId)
  if (error) throw error
}

// ---------- cost ----------

/** One thing the week needs, bought the way it's sold. */
export interface BuyItem {
  ingredientId: string | null
  name: string
  aisle: string | null
  /** What the recipes need, added up, when it could be. */
  quantity: number | null
  unit: string | null
  amountUnknown: boolean
  soldBy: 'package' | 'loose' | null
  packageQuantity: number | null
  packageUnit: string | null
  packages: number | null
  leftover: number | null
  staple: boolean
  pantry: PantryStatus | null
  /** False when it's on hand, so it isn't bought. */
  buy: boolean
  cents: number | null
  /** A rough baseline price rather than the store's. */
  estimated: boolean
  /** Where the price came from (TYL-61): the user's own, the store's, or a
   *  rough estimate. */
  priceSource: 'user' | 'store' | 'estimate' | null
  /** The store's sale price. */
  onSale: boolean
  /** The sale's last day (YYYY-MM-DD), and the cost after it. */
  saleEnds: string | null
  regularCents: number | null
}

export interface PlanCost {
  budgetCents: number | null
  totalCents: number
  /** True when some prices are rough baseline estimates. */
  estimated: boolean
  /** Things to buy that have no price yet. */
  unpriced: number
  items: BuyItem[]
  /** The store whose prices these are, when they're live from it. */
  storeName: string | null
  /** Its id, where the user's own prices are saved (null: anywhere). */
  storeId: string | null
  /** Each planned recipe's share of the total, by plan entry id (TYL-30). */
  entryCents: Record<string, number>
}

interface ItemBody {
  ingredient_id: string | null
  name: string
  aisle: string | null
  quantity: number | null
  unit: string | null
  amount_unknown: boolean
  sold_by: 'package' | 'loose' | null
  package_quantity: number | null
  package_unit: string | null
  packages: number | null
  leftover: number | null
  staple: boolean
  pantry: PantryStatus | null
  buy: boolean
  cents: number | null
  estimated?: boolean
  price_source?: BuyItem['priceSource']
  on_sale?: boolean
  sale_ends?: string | null
  regular_cents?: number | null
}

/** The week's buy list and cost from the API: each item's price and where
 *  it's from, the store, and each planned recipe's share. */
export async function planCost(
  session: Session,
  weekStart: string,
  send: typeof apiFetch = apiFetch,
): Promise<PlanCost> {
  const resp = await send(session, `/plans/${weekStart}/cost`)
  if (!resp.ok) throw new Error(`plan cost: ${resp.status}`)
  const body = (await resp.json()) as {
    budget_cents: number | null
    total_cents: number
    estimated: boolean
    unpriced: number
    items: ItemBody[]
    store_name?: string | null
    store_id?: string | null
    entries?: { entry_id: string; cents: number }[]
  }
  return {
    budgetCents: body.budget_cents,
    totalCents: body.total_cents,
    estimated: body.estimated,
    unpriced: body.unpriced,
    items: body.items.map((i) => ({
      ingredientId: i.ingredient_id,
      name: i.name,
      aisle: i.aisle,
      quantity: i.quantity,
      unit: i.unit,
      amountUnknown: i.amount_unknown,
      soldBy: i.sold_by,
      packageQuantity: i.package_quantity,
      packageUnit: i.package_unit,
      packages: i.packages,
      leftover: i.leftover,
      staple: i.staple,
      pantry: i.pantry,
      buy: i.buy,
      cents: i.cents,
      estimated: i.estimated ?? false,
      priceSource: i.price_source ?? null,
      onSale: i.on_sale ?? false,
      saleEnds: i.sale_ends ?? null,
      regularCents: i.regular_cents ?? null,
    })),
    storeName: body.store_name ?? null,
    storeId: body.store_id ?? null,
    entryCents: Object.fromEntries(
      (body.entries ?? []).map((e) => [e.entry_id, e.cents]),
    ),
  }
}

/** What adding a recipe at full size would add to the week (TYL-30). */
export interface AddedCost {
  cents: number
  /** It brings items with no price yet, so it would add more than this. */
  unpriced: boolean
  estimated: boolean
}

export interface AddedCosts {
  budgetCents: number | null
  totalCents: number
  /** By recipe id; recipes the user can't see are left out. */
  recipes: Record<string, AddedCost>
}

/** What adding each of these recipes would add to the week's cost. The API
 *  takes 100 at a time, so more are asked for in batches. */
export async function addedCosts(
  session: Session,
  weekStart: string,
  recipeIds: string[],
  send: typeof apiFetch = apiFetch,
): Promise<AddedCosts> {
  const batches: string[][] = []
  for (let i = 0; i < recipeIds.length; i += ADDED_BATCH) {
    batches.push(recipeIds.slice(i, i + ADDED_BATCH))
  }
  const bodies = await Promise.all(
    batches.map(async (ids) => {
      const resp = await send(session, `/plans/${weekStart}/added`, {
        method: 'POST',
        body: JSON.stringify({ recipe_ids: ids }),
      })
      if (!resp.ok) throw new Error(`added costs: ${resp.status}`)
      return (await resp.json()) as {
        budget_cents: number | null
        total_cents: number
        recipes: {
          recipe_id: string
          cents: number
          unpriced: boolean
          estimated: boolean
        }[]
      }
    }),
  )
  return {
    budgetCents: bodies[0]?.budget_cents ?? null,
    totalCents: bodies[0]?.total_cents ?? 0,
    recipes: Object.fromEntries(
      bodies.flatMap((b) =>
        b.recipes.map((r) => [
          r.recipe_id,
          { cents: r.cents, unpriced: r.unpriced, estimated: r.estimated },
        ]),
      ),
    ),
  }
}

// The most recipe ids POST /plans/{week}/added takes at once.
const ADDED_BATCH = 100

/** How much the user's own price is for (TYL-34): one package as the list
 *  buys it ("14 oz", "1 bunch", "pack of 12"), or a pound of what's loose. */
export function priceBasis(i: BuyItem): {
  quantity: number
  unit: string
  label: string
} {
  if (i.soldBy === 'package' && i.packageQuantity && i.packageUnit) {
    const label =
      i.packageUnit === 'each'
        ? i.packageQuantity > 1
          ? `a pack of ${formatQuantity(i.packageQuantity)}`
          : 'one'
        : amountText(i.packageQuantity, i.packageUnit)
    return { quantity: i.packageQuantity, unit: i.packageUnit, label }
  }
  if (i.unit === 'each') return { quantity: 1, unit: 'each', label: 'one' }
  return { quantity: 1, unit: 'lb', label: '1 lb' }
}

/** Save the user's own price for an ingredient at a store (null: anywhere).
 *  It replaces their earlier price there and wins over the store's. */
export async function setMyPrice(
  db: SupabaseClient,
  ingredientId: string,
  storeId: string | null,
  cents: number,
  basis: { quantity: number; unit: string },
): Promise<void> {
  const { error } = await db.rpc('set_my_price', {
    p_ingredient: ingredientId,
    p_store: storeId,
    p_price_cents: cents,
    p_quantity: basis.quantity,
    p_unit: basis.unit,
  })
  if (error) throw error
}

/** Back to the usual price for an ingredient at a store: forgets the user's
 *  price there and their price for anywhere, which applies there too. */
export async function clearMyPrice(
  db: SupabaseClient,
  ingredientId: string,
  storeId: string | null,
): Promise<void> {
  const { error } = await db.rpc('clear_my_price', {
    p_ingredient: ingredientId,
    p_store: storeId,
  })
  if (error) throw error
}

/** Dollars as typed ("2.49", "$2", "2,49") to cents; null when it isn't a
 *  price. */
export function parseDollars(text: string): number | null {
  const t = text.trim().replace(/^\$/, '').replace(',', '.')
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(t)) return null
  const cents = Math.round(parseFloat(t) * 100)
  return cents <= 100_000 ? cents : null
}

/** "2 × 15 oz", "pack of 12", "1.2 lb", or null when the amount isn't known. */
export function buyText(i: BuyItem): string | null {
  if (i.packages && i.packageQuantity && i.packageUnit) {
    const size =
      i.packageUnit === 'each'
        ? i.packageQuantity > 1
          ? `pack of ${formatQuantity(i.packageQuantity)}`
          : null
        : amountText(i.packageQuantity, i.packageUnit)
    if (!size) return String(i.packages)
    return i.packages > 1 ? `${i.packages} × ${size}` : size
  }
  if (i.quantity !== null && i.unit) return amountText(i.quantity, i.unit)
  return null
}

/** "until Tue, Oct 13" for a sale's last day (a local date, not UTC). */
export function saleText(i: BuyItem): string | null {
  if (!i.onSale) return null
  let text = 'Sale'
  if (i.saleEnds) {
    const [y, m, d] = i.saleEnds.split('-').map(Number)
    const day = new Date(y, m - 1, d).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
    text += ` until ${day}`
  }
  if (i.regularCents !== null && i.cents !== null && i.regularCents > i.cents) {
    text += ` · was ${dollars(i.regularCents)}`
  }
  return text
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

// ---------- scaling ----------

const FRACTIONS: [number, string][] = [
  [0, ''],
  [1 / 8, '⅛'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [1 / 2, '½'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
  [1, ''],
]

/** 1.5 → "1½", 0.333 → "⅓", 2.4 → "2.4". */
export function formatQuantity(n: number): string {
  let whole = Math.floor(n)
  const rest = n - whole
  const [value, glyph] = FRACTIONS.reduce((best, f) =>
    Math.abs(f[0] - rest) < Math.abs(best[0] - rest) ? f : best,
  )
  if (Math.abs(value - rest) > 0.04) return String(Math.round(n * 10) / 10)
  if (value === 1) whole += 1
  if (!whole) return glyph || '0'
  return `${whole}${glyph}`
}

const ABBREVIATIONS = new Set(['g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp'])

export function amountText(quantity: number, unit: string): string {
  return [formatQuantity(quantity), unitText(unit, quantity)]
    .filter(Boolean)
    .join(' ')
}

function unitText(unit: string | null, quantity: number): string {
  if (!unit || unit === 'each') return ''
  if (unit === 'fl_oz') return 'fl oz'
  if (ABBREVIATIONS.has(unit) || quantity <= 1 || unit.endsWith('s'))
    return unit
  return /(ch|sh)$/.test(unit) ? `${unit}es` : `${unit}s`
}

/** An ingredient line for `factor` times the recipe ("2 cups rice" × 1.5 →
 *  "3 cups rice"). Lines without an amount ("salt to taste") stay as written. */
export function scaledLine(line: IngredientLine, factor: number): string {
  if (factor === 1 || line.quantity == null || !line.name) return line.rawText
  const qty = line.quantity * factor
  const max = line.quantityMax != null ? line.quantityMax * factor : null
  const amount =
    max !== null
      ? `${formatQuantity(qty)}–${formatQuantity(max)}`
      : formatQuantity(qty)
  const unit = unitText(line.unit, max ?? qty)
  const prep = line.preparation ? `, ${line.preparation}` : ''
  return [amount, unit, line.name].filter(Boolean).join(' ') + prep
}
