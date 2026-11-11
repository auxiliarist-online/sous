// The local food directory (TYL-69): farmers markets, co-ops, bakeries,
// butchers and fish markets near Asheville, when they're open, and the
// user's favorites.
import type { SupabaseClient } from '@supabase/supabase-js'

export type PlaceKind =
  | 'farmers_market'
  | 'co_op'
  | 'grocer'
  | 'bakery'
  | 'butcher'
  | 'fish_market'
  | 'farm_store'

/** One run of opening hours: days 0 (Sunday) to 6, 24-hour local times, and
 *  an optional season by month-day ("04-04" to "11-28"; a winter season
 *  wraps the new year). */
export interface Hours {
  days: number[]
  opens: string
  closes: string
  from?: string
  to?: string
}

export interface LocalPlace {
  id: string
  name: string
  kind: PlaceKind
  address: string
  town: string
  zip: string
  latitude: number
  longitude: number
  sells: string[]
  hours: Hours[]
  website: string | null
  sourceUrl: string
  checkedOn: string
}

export const KIND_NAMES: Record<PlaceKind, string> = {
  farmers_market: 'Farmers market',
  co_op: 'Co-op',
  grocer: 'Local grocer',
  bakery: 'Bakery',
  butcher: 'Butcher',
  fish_market: 'Fish market',
  farm_store: 'Farm store',
}

/** The directory covers Buncombe County so far: whether a home zip is in
 *  the Asheville area (287xx and 288xx, western North Carolina). */
export function nearAsheville(zip: string | null | undefined): boolean {
  return !!zip && /^28[78]\d\d$/.test(zip)
}

/** Every place in the directory, by name. */
export async function loadLocalPlaces(
  db: SupabaseClient,
): Promise<LocalPlace[]> {
  const { data, error } = await db
    .from('local_places')
    .select(
      'id, name, kind, address, town, zip, latitude, longitude, sells, hours, website, source_url, checked_on',
    )
    .order('name')
  if (error) throw error
  return (data as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as PlaceKind,
    address: r.address as string,
    town: r.town as string,
    zip: r.zip as string,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    sells: r.sells as string[],
    hours: r.hours as Hours[],
    website: (r.website as string | null) ?? null,
    sourceUrl: r.source_url as string,
    checkedOn: r.checked_on as string,
  }))
}

/** The ids of the user's favorite places. */
export async function loadFavoritePlaces(
  db: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await db.from('user_local_places').select('place_id')
  if (error) throw error
  return (data as { place_id: string }[]).map((r) => r.place_id)
}

/** Make a place a favorite, or not. */
export async function setFavoritePlace(
  db: SupabaseClient,
  userId: string,
  placeId: string,
  favorite: boolean,
): Promise<void> {
  const { error } = favorite
    ? await db
        .from('user_local_places')
        .upsert({ user_id: userId, place_id: placeId })
    : await db
        .from('user_local_places')
        .delete()
        .eq('user_id', userId)
        .eq('place_id', placeId)
  if (error) throw error
}

/** "MM-DD" for a date (local time). */
function monthDay(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Whether a run of hours is in season on this day. */
export function inSeason(h: Hours, day: Date): boolean {
  if (!h.from || !h.to) return true
  const md = monthDay(day)
  return h.from <= h.to
    ? md >= h.from && md <= h.to
    : md >= h.from || md <= h.to
}

/** The hours that apply on a day, if the place opens then. */
export function hoursOn(place: LocalPlace, day: Date): Hours | null {
  return (
    place.hours.find(
      (h) => h.days.includes(day.getDay()) && inSeason(h, day),
    ) ?? null
  )
}

/** Minutes since midnight for "HH:MM", or for a date's local time. */
function minutes(t: string | Date): number {
  if (typeof t !== 'string') return t.getHours() * 60 + t.getMinutes()
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

/** "9 am", "3:30 pm", "12 pm". */
export function clock(t: string): string {
  const [h, m] = t.split(':').map(Number)
  const hour = h % 12 || 12
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
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

/** The next time the place is open from `now` (now included): the day and
 *  its hours, looking up to a year ahead. Null if it never opens. */
export function nextOpen(
  place: LocalPlace,
  now: Date,
): { day: Date; hours: Hours; openNow: boolean } | null {
  for (let i = 0; i < 366; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    const h = hoursOn(place, day)
    if (!h) continue
    if (i === 0 && minutes(now) >= minutes(h.closes)) continue
    return {
      day,
      hours: h,
      openNow: i === 0 && minutes(now) >= minutes(h.opens),
    }
  }
  return null
}

/** When it's next open, said plainly: "Open now until 12 pm", "Opens today
 *  at 3 pm", "Sat 9 am – 12 pm", or "Back Apr 4" when it's out of season. */
export function openingText(place: LocalPlace, now: Date): string {
  const next = nextOpen(place, now)
  if (!next) return 'Hours not listed'
  const { day, hours, openNow } = next
  if (openNow) return `Open now until ${clock(hours.closes)}`
  const span = `${clock(hours.opens)} – ${clock(hours.closes)}`
  const days = Math.round(
    (day.getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  )
  if (days === 0) return `Opens today at ${clock(hours.opens)}`
  if (days === 1) return `Tomorrow ${span}`
  if (days < 7) return `${WEEKDAYS[day.getDay()]} ${span}`
  return `Back ${MONTHS[day.getMonth()]} ${day.getDate()}`
}

/** Whether it's open (still to come) on Friday, Saturday or Sunday between
 *  now and the coming Sunday. */
export function openThisWeekend(place: LocalPlace, now: Date): boolean {
  const toSunday = (7 - now.getDay()) % 7
  for (let i = 0; i <= toSunday; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    if (![0, 5, 6].includes(day.getDay())) continue
    const h = hoursOn(place, day)
    if (h && !(i === 0 && minutes(now) >= minutes(h.closes))) return true
  }
  return false
}

/** Miles between two points (haversine). */
export function milesBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.latitude - a.latitude)
  const dLng = rad(b.longitude - a.longitude)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(dLng / 2) ** 2
  return 3958.8 * 2 * Math.asin(Math.sqrt(s))
}

/** Where the user wants an ingredient bought (TYL-71): at a favorite local
 *  place even when it opens after the meal, or at the supermarket. */
export type LocalPrefer = 'local' | 'store'

/** What the directory calls a list item, from its aisle, its ingredient's
 *  categories (`contains`) and its name; null for what local places aren't
 *  matched on (spices, cans and the like). */
export function sellsCategory(
  item: { name: string; aisle: string | null },
  contains: string[] = [],
): string | null {
  const name = item.name.toLowerCase()
  if (/\bhoney\b/.test(name)) return 'honey'
  switch (item.aisle) {
    case 'produce':
      return 'produce'
    case 'dairy_eggs':
      return contains.includes('egg') && /\beggs?\b/.test(name)
        ? 'eggs'
        : 'dairy'
    case 'meat_seafood':
      return contains.includes('fish') || contains.includes('shellfish')
        ? 'seafood'
        : 'meat'
    case 'bakery':
      return 'bread'
  }
  if (/\b(flour|cornmeal|grits|rolled oats|oats)\b/.test(name)) return 'grains'
  return null
}

/** A list item, as far as local first needs one. */
export interface LocalItem {
  id: string
  ingredientId: string | null
  name: string
  aisle: string | null
  /** A place the user picked for it themselves: that stands. */
  storeId: string | null
}

/** What the list suggests (TYL-71): favorite places with the items to get
 *  there, in the order they next open; items left at the supermarket that a
 *  favorite sells, with a note when it's because of timing; and the count. */
export interface LocalPlan<T extends LocalItem> {
  stops: { place: LocalPlace; items: T[] }[]
  /** Items at the supermarket a favorite could take, by item id: the place,
   *  and why it isn't there ("Opens Sat; needed Wed"), if it's timing. */
  elsewhere: Map<string, { place: LocalPlace; why: string | null }>
}

/** When a planned meal needs an ingredient: its day ("YYYY-MM-DD") and
 *  meal (breakfast, lunch, dinner, snack, or null for unsaid). */
export interface Needed {
  day: string
  meal: string | null
}

// When each meal is, for whether a place opening that day is in time; an
// unsaid meal counts as dinner.
const MEAL_TIME: Record<string, string> = {
  breakfast: '08:00',
  lunch: '12:00',
  snack: '15:00',
  dinner: '17:00',
}
const mealTime = (meal: string | null) => MEAL_TIME[meal ?? 'dinner'] ?? '17:00'

/** Which of two needs comes first. */
function sooner(a: Needed, b: Needed): boolean {
  return (
    a.day < b.day || (a.day === b.day && mealTime(a.meal) < mealTime(b.meal))
  )
}

/** "YYYY-MM-DD" for a date (local time). */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Sort the items to buy between favorite local places and the supermarket.
 *  Each item goes to the favorite that sells it and opens soonest
 *  (a specialist before a full grocery when they open together), unless the
 *  user keeps it at the supermarket, or that place won't open before the
 *  first meal that needs it (unless the user asked for it there anyway). */
export function planLocal<T extends LocalItem>(
  items: T[],
  {
    places,
    favorites,
    contains,
    neededBy,
    prefer,
    now,
  }: {
    places: LocalPlace[]
    favorites: Set<string>
    /** Each ingredient's categories (egg, fish...). */
    contains: Record<string, string[]>
    /** The first planned meal that needs each ingredient. */
    neededBy: Record<string, Needed>
    prefer: Record<string, LocalPrefer>
    now: Date
  },
): LocalPlan<T> {
  const mine = places.filter((p) => favorites.has(p.id))
  const opens = new Map(mine.map((p) => [p.id, nextOpen(p, now)] as const))
  const byPlace = new Map<string, T[]>()
  const elsewhere: LocalPlan<T>['elsewhere'] = new Map()
  for (const item of items) {
    if (!item.ingredientId || item.storeId) continue
    const category = sellsCategory(item, contains[item.ingredientId])
    if (!category) continue
    const sellers = mine
      .filter(
        (p) =>
          opens.get(p.id) &&
          (p.sells.includes(category) ||
            (p.sells.includes('groceries') && category !== 'honey')),
      )
      .sort((a, b) => {
        const x = opens.get(a.id)!
        const y = opens.get(b.id)!
        return (
          x.day.getTime() - y.day.getTime() ||
          x.hours.opens.localeCompare(y.hours.opens) ||
          Number(a.sells.includes('groceries')) -
            Number(b.sells.includes('groceries'))
        )
      })
    const place = sellers[0]
    if (!place) continue
    const choice = prefer[item.ingredientId]
    if (choice === 'store') {
      elsewhere.set(item.id, { place, why: null })
      continue
    }
    const { day: next, hours } = opens.get(place.id)!
    const needed = neededBy[item.ingredientId]
    // Too late: it opens after the meal's day, or that day but not before
    // the meal. A meal day already past sets no deadline.
    const late =
      !!needed &&
      needed.day >= isoDay(now) &&
      (isoDay(next) > needed.day ||
        (isoDay(next) === needed.day && hours.opens >= mealTime(needed.meal)))
    if (late && choice !== 'local') {
      const neededDay = new Date(`${needed.day}T12:00`)
      const soon = next.getTime() - now.getTime() < 7 * 86_400_000
      elsewhere.set(item.id, {
        place,
        why: `${place.name} ${soon ? `opens ${WEEKDAYS[next.getDay()]}` : `is closed until ${MONTHS[next.getMonth()]} ${next.getDate()}`}; it's needed ${WEEKDAYS[neededDay.getDay()]}`,
      })
      continue
    }
    byPlace.set(place.id, [...(byPlace.get(place.id) ?? []), item])
  }
  const stops = mine
    .filter((p) => byPlace.has(p.id))
    .sort(
      (a, b) =>
        opens.get(a.id)!.day.getTime() - opens.get(b.id)!.day.getTime() ||
        opens
          .get(a.id)!
          .hours.opens.localeCompare(opens.get(b.id)!.hours.opens),
    )
    .map((place) => ({ place, items: byPlace.get(place.id)! }))
  return { stops, elsewhere }
}

/** Where the user wants things bought, by ingredient (TYL-71). */
export async function loadLocalPreferences(
  db: SupabaseClient,
): Promise<Record<string, LocalPrefer>> {
  const { data, error } = await db
    .from('user_local_preferences')
    .select('ingredient_id, prefer')
  if (error) throw error
  return Object.fromEntries(
    (data as { ingredient_id: string; prefer: LocalPrefer }[]).map((r) => [
      r.ingredient_id,
      r.prefer,
    ]),
  )
}

/** Remember where to buy an ingredient: local, the supermarket, or (null)
 *  let the list decide. */
export async function setLocalPreference(
  db: SupabaseClient,
  userId: string,
  ingredientId: string,
  prefer: LocalPrefer | null,
): Promise<void> {
  const { error } = prefer
    ? await db
        .from('user_local_preferences')
        .upsert({ user_id: userId, ingredient_id: ingredientId, prefer })
    : await db
        .from('user_local_preferences')
        .delete()
        .eq('user_id', userId)
        .eq('ingredient_id', ingredientId)
  if (error) throw error
}

/** What matching the list needs from the database: each ingredient's
 *  categories, and the first planned (dated) meal of the week that needs it.
 *  For an "or" line, only the option the week buys counts; one still
 *  waiting for a choice isn't on the list yet. */
export async function localInputs(
  db: SupabaseClient,
  week: string,
  ingredientIds: string[],
): Promise<{
  contains: Record<string, string[]>
  neededBy: Record<string, Needed>
}> {
  const [ingredients, plan] = await Promise.all([
    ingredientIds.length
      ? db.from('ingredients').select('id, contains').in('id', ingredientIds)
      : Promise.resolve({ data: [], error: null }),
    db
      .from('meal_plans')
      .select(
        'choices, entries:meal_plan_entries(planned_for, meal, recipe:recipes(lines:recipe_ingredients(line_no, ingredient_id, is_optional)))',
      )
      .eq('week_start', week)
      .maybeSingle(),
  ])
  if (ingredients.error) throw ingredients.error
  if (plan.error) throw plan.error
  const contains = Object.fromEntries(
    (ingredients.data as { id: string; contains: string[] }[]).map((r) => [
      r.id,
      r.contains ?? [],
    ]),
  )
  const neededBy: Record<string, Needed> = {}
  const data = plan.data as {
    choices: Record<string, string> | null
    entries: {
      planned_for: string | null
      meal: string | null
      recipe: {
        lines: {
          line_no: number
          ingredient_id: string | null
          is_optional: boolean
        }[]
      } | null
    }[]
  } | null
  const choices = data?.choices ?? {}
  for (const e of data?.entries ?? []) {
    if (!e.planned_for) continue
    const need = { day: e.planned_for, meal: e.meal ?? null }
    // The line's options, by line.
    const byLine = new Map<number, string[]>()
    for (const l of e.recipe?.lines ?? [])
      if (l.ingredient_id && !l.is_optional)
        byLine.set(l.line_no, [
          ...(byLine.get(l.line_no) ?? []),
          l.ingredient_id,
        ])
    for (const options of byLine.values()) {
      const id =
        options.length === 1
          ? options[0]
          : choices[[...new Set(options)].sort().join(',')]
      if (id && (!neededBy[id] || sooner(need, neededBy[id])))
        neededBy[id] = need
    }
  }
  return { contains, neededBy }
}
