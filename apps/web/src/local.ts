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
