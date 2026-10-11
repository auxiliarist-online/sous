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

export interface PlanEntry {
  id: string
  recipeId: string
  title: string
  servings: number
  /** What the recipe makes as written; null when the page didn't say. */
  recipeServings: number | null
  /** The day it's planned for, or null for "some day this week". */
  day: string | null
  position: number
}

interface EntryRow {
  id: string
  servings: number
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
      'entries:meal_plan_entries(id, servings, planned_for, position, recipe:recipes(id, title, servings))',
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
      servings: Number(e.servings),
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
  servings: number,
  day: string | null = null,
): Promise<void> {
  const { error } = await db.rpc('add_to_meal_plan', {
    p_week: weekStart,
    p_recipe: recipeId,
    p_servings: servings,
    p_day: day,
  })
  if (error) throw error
}

export async function updateEntry(
  db: SupabaseClient,
  id: string,
  patch: { servings?: number; day?: string | null },
): Promise<void> {
  const row: Record<string, unknown> = {}
  if (patch.servings !== undefined) row.servings = patch.servings
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

// ---------- cost ----------

export interface PlanCost {
  budgetCents: number | null
  totalCents: number
  /** True when some prices are rough baseline estimates. */
  estimated: boolean
  unpricedLines: number
  entries: Record<string, number>
}

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
    unpriced_lines: number
    entries: { id: string; cents: number }[]
  }
  return {
    budgetCents: body.budget_cents,
    totalCents: body.total_cents,
    estimated: body.estimated,
    unpricedLines: body.unpriced_lines,
    entries: Object.fromEntries(body.entries.map((e) => [e.id, e.cents])),
  }
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
