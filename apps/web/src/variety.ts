/**
 * Variety (TYL-66): gentle notes when a week repeats itself, and the rhythm of
 * favorite recipes. Notes never block a choice; they say what's repeated.
 */

/** How a recipe's main protein is named in a note. */
const PROTEINS: Record<string, string> = {
  poultry: 'poultry',
  meat: 'red meat',
  pork: 'pork',
  fish: 'fish',
  shellfish: 'shellfish',
}

/** At most this many dinners with the same main protein in a week… */
export const MAX_SAME_PROTEIN = 2
/** …and the same cuisine on at most this many days in a row. */
export const MAX_CUISINE_RUN = 2

/** One required ingredient of a recipe, as variety reads it. */
export interface ProteinSource {
  aisle: string | null
  contains: string[]
}

/** A recipe's main proteins: what its required ingredients from the meat and
 *  seafood counter are. Broth or fish sauce from the pantry doesn't make a
 *  chicken or fish dinner. Pork counts as pork, not red meat. */
export function mainProteins(ingredients: ProteinSource[]): string[] {
  const found = new Set<string>()
  for (const i of ingredients) {
    if (i.aisle !== 'meat_seafood') continue
    const kind = i.contains.includes('pork')
      ? 'pork'
      : Object.keys(PROTEINS).find((p) => i.contains.includes(p))
    if (kind) found.add(kind)
  }
  return [...found]
}

/** What the week repeats, as notes: "3 dinners with poultry this week",
 *  "Italian 3 days in a row". */
export function varietyNotes(
  entries: { day: string | null; proteins: string[]; cuisines: string[] }[],
): string[] {
  const notes: string[] = []
  const counts = new Map<string, number>()
  for (const e of entries) {
    for (const p of e.proteins) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  for (const [p, n] of counts) {
    if (n > MAX_SAME_PROTEIN)
      notes.push(`${n} dinners with ${PROTEINS[p]} this week`)
  }
  // Runs of the same cuisine on days that follow each other.
  const byDay = new Map<string, Set<string>>()
  for (const e of entries) {
    if (!e.day) continue
    const set = byDay.get(e.day) ?? new Set<string>()
    e.cuisines.forEach((c) => set.add(c))
    byDay.set(e.day, set)
  }
  const days = [...byDay.keys()].sort()
  const longest = new Map<string, number>()
  const run = new Map<string, number>()
  days.forEach((day, i) => {
    const follows = i > 0 && nextDay(days[i - 1]) === day
    for (const c of byDay.get(day)!) {
      const n =
        follows && byDay.get(days[i - 1])!.has(c) ? (run.get(c) ?? 0) + 1 : 1
      run.set(c, n)
      longest.set(c, Math.max(longest.get(c) ?? 0, n))
    }
    // A cuisine not cooked today ends its run.
    for (const c of [...run.keys()]) if (!byDay.get(day)!.has(c)) run.delete(c)
  })
  for (const [c, n] of longest) {
    if (n > MAX_CUISINE_RUN) notes.push(`${c} ${n} days in a row`)
  }
  return notes
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const next = new Date(y, m - 1, d + 1)
  const mm = String(next.getMonth() + 1).padStart(2, '0')
  const dd = String(next.getDate()).padStart(2, '0')
  return `${next.getFullYear()}-${mm}-${dd}`
}

export type Frequency = 'weekly' | 'biweekly' | 'monthly'

export const FREQUENCIES: [Frequency, string][] = [
  ['weekly', 'Every week'],
  ['biweekly', 'Every couple of weeks'],
  ['monthly', 'Once a month'],
]

const WEEKS: Record<Frequency, number> = { weekly: 1, biweekly: 2, monthly: 4 }

/** Recipes planned or cooked in the last few weeks: how many weeks ago, at
 *  the latest (0 is this week). */
export type Recent = Record<string, number>

/** How many weeks ago that was: 0 for this week, 1 for last. */
export function weeksAgo(iso: string, weekStart: string): number {
  const days =
    (Date.parse(`${weekStart}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) /
    86_400_000
  return Math.max(0, Math.ceil(days / 7))
}

/** Whether a favorite is due back: never had, or as long ago as its rhythm. */
export function isDue(
  frequency: Frequency,
  weeks: number | undefined,
): boolean {
  return weeks === undefined || weeks >= WEEKS[frequency]
}

/** A recipe not suggested again so soon: planned or cooked within this many
 *  weeks, unless it's a favorite that's due. */
export const RECENT_WEEKS = 3
