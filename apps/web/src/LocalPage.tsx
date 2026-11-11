import { useEffect, useRef, useState } from 'react'
import { Heart, MapPin } from 'lucide-react'
import {
  KIND_NAMES,
  milesBetween,
  nextOpen,
  openingText,
  openThisWeekend,
  type LocalPlace,
} from './local.ts'

export interface LocalApi {
  /** The local food directory (TYL-69). */
  localPlaces(): Promise<LocalPlace[]>
  /** The ids of the user's favorite places. */
  favoritePlaces(): Promise<string[]>
  /** Make a place a favorite, or not. */
  setFavoritePlace(placeId: string, favorite: boolean): Promise<void>
}

type Show = 'all' | 'today' | 'weekend' | 'favorites'

const SELLS: Record<string, string> = {
  produce: 'Produce',
  eggs: 'Eggs',
  dairy: 'Dairy',
  meat: 'Meat',
  seafood: 'Fish',
  bread: 'Bread',
  honey: 'Honey',
  grains: 'Grains',
  groceries: 'Groceries',
}

/** "Nov 11, 2026" for a "2026-11-11" date. */
function longDate(iso: string): string {
  return new Date(`${iso}T12:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Local food (TYL-69): the Asheville area's markets, co-ops, bakeries,
 *  butchers and fish markets, with when each is next open and what it sells.
 *  Favorites come first; "Nearest first" asks for the phone's location (used
 *  here only, never sent). `now` is for tests. */
export function LocalPage({ api, now }: { api: LocalApi; now?: Date }) {
  const [places, setPlaces] = useState<LocalPlace[] | null>(null)
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState(false)
  const [show, setShow] = useState<Show>('all')
  const [here, setHere] = useState<{
    latitude: number
    longitude: number
  } | null>(null)
  const [locating, setLocating] = useState<'idle' | 'busy' | 'failed'>('idle')
  const [saveFailed, setSaveFailed] = useState(false)
  // The time, for "open now": kept current while the page is open (tests
  // fix it).
  const [clock, setClock] = useState(() => now ?? new Date())
  // Tick once a minute.
  useEffect(() => {
    if (now) return
    const tick = setInterval(() => setClock(new Date()), 60_000)
    return () => clearInterval(tick)
  }, [now])
  // Hearts tapped here, by place (true: a favorite now), so loading the
  // saved favorites doesn't undo a tap made while they loaded.
  const tapped = useRef(new Map<string, boolean>())
  // Saves still on their way, by place: each waits for the one before.
  const writes = useRef(new Map<string, Promise<void>>())
  // What's known to be saved, by place: where a failed save goes back to.
  const confirmed = useRef(new Map<string, boolean>())
  // Places with a save that went through: newer than the first load.
  const savedHere = useRef(new Set<string>())

  // Load the directory and the user's favorites.
  useEffect(() => {
    let live = true
    api.localPlaces().then(
      (p) => live && setPlaces(p),
      () => live && setFailed(true),
    )
    // Without favorites the directory still shows.
    api.favoritePlaces().then(
      (f) => {
        if (!live) return
        const saved = new Set(f)
        // What was saved before any tap here.
        for (const id of confirmed.current.keys())
          if (!savedHere.current.has(id))
            confirmed.current.set(id, saved.has(id))
        for (const [id, on] of tapped.current)
          if (on) saved.add(id)
          else saved.delete(id)
        setFavorites(saved)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [api])

  // Favorite a place or not, at once; if saving fails, go back to what's
  // known to be saved.
  async function toggle(id: string) {
    const on = !favorites.has(id)
    // The favorites with this place in or out.
    const flip = (set: Set<string>, add: boolean) => {
      const next = new Set(set)
      if (add) next.add(id)
      else next.delete(id)
      return next
    }
    if (!confirmed.current.has(id)) confirmed.current.set(id, !on)
    setFavorites((f) => flip(f, on))
    tapped.current.set(id, on)
    setSaveFailed(false)
    const write = (writes.current.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => api.setFavoritePlace(id, on))
    writes.current.set(id, write)
    try {
      await write
      confirmed.current.set(id, on)
      savedHere.current.add(id)
    } catch {
      // Only the newest change goes back, and to what's saved.
      if (writes.current.get(id) === write) {
        const saved = confirmed.current.get(id) ?? !on
        setFavorites((f) => flip(f, saved))
        tapped.current.set(id, saved)
      }
      setSaveFailed(true)
    } finally {
      if (writes.current.get(id) === write) writes.current.delete(id)
    }
  }

  // Sort by distance from the phone, once the person asks.
  function locate() {
    if (!('geolocation' in navigator)) {
      setLocating('failed')
      return
    }
    setLocating('busy')
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setHere({ latitude: p.coords.latitude, longitude: p.coords.longitude })
        setLocating('idle')
      },
      () => setLocating('failed'),
      { maximumAge: 600_000, timeout: 15_000 },
    )
  }

  // Whether it opens (or is open) later today.
  const today = (p: LocalPlace) => {
    const next = nextOpen(p, clock)
    return !!next && next.day.toDateString() === clock.toDateString()
  }
  // When it next opens, as a number to sort by.
  const soonest = (p: LocalPlace) => {
    const next = nextOpen(p, clock)
    return next
      ? next.day.getTime() + Number(next.hours.opens.replace(':', ''))
      : Infinity
  }
  const shown = (places ?? [])
    .filter((p) =>
      show === 'today'
        ? today(p)
        : show === 'weekend'
          ? openThisWeekend(p, clock)
          : show === 'favorites'
            ? favorites.has(p.id)
            : true,
    )
    .sort(
      (a, b) =>
        Number(favorites.has(b.id)) - Number(favorites.has(a.id)) ||
        (here
          ? milesBetween(here, a) - milesBetween(here, b)
          : soonest(a) - soonest(b)) ||
        a.name.localeCompare(b.name),
    )

  // One of the "Show" chips.
  const chip = (value: Show, label: string) => (
    <button
      type="button"
      className="chip"
      aria-pressed={show === value}
      onClick={() => setShow(value)}
    >
      {label}
    </button>
  )

  return (
    <section className="screen local" aria-labelledby="local-title">
      <h2 id="local-title" className="screen-title">
        Local food <small>Asheville area</small>
      </h2>
      <p className="muted small">
        Farmers markets, bakeries, butchers and co-ops around Buncombe County.
        Tap the heart to keep a favorite. Hours change with the seasons, so
        check before you go.
      </p>
      <div className="chips scroll" role="group" aria-label="Show">
        {chip('all', 'All')}
        {chip('today', 'Open today')}
        {chip('weekend', 'This weekend')}
        {chip('favorites', 'Favorites')}
      </div>
      <button
        type="button"
        className="link small"
        disabled={locating === 'busy' || here !== null}
        onClick={locate}
      >
        <MapPin size={16} strokeWidth={2.75} aria-hidden="true" />{' '}
        {here
          ? 'Nearest first'
          : locating === 'busy'
            ? 'Finding you…'
            : 'Show nearest first'}
      </button>
      {locating === 'failed' && (
        <p role="alert" className="error small">
          We couldn't get your location. Allow it in your browser to sort by
          distance.
        </p>
      )}
      {saveFailed && (
        <p role="alert" className="error small">
          We couldn't save that favorite. Try again.
        </p>
      )}
      {failed && (
        <p role="alert" className="error">
          We couldn't load the local places.
        </p>
      )}
      {!failed && places === null && <p className="muted">Loading…</p>}
      {places && shown.length === 0 && (
        <p className="muted">
          {show === 'favorites'
            ? 'No favorites yet. Tap the heart on a place to keep it here.'
            : 'Nothing open then. Try another day.'}
        </p>
      )}
      <ul className="places">
        {shown.map((p) => {
          const fav = favorites.has(p.id)
          const open = nextOpen(p, clock)?.openNow
          return (
            <li key={p.id} className="panel place">
              <div className="place-head">
                <h3>{p.name}</h3>
                <button
                  type="button"
                  className="icon-button plain"
                  aria-pressed={fav}
                  aria-label={`Favorite ${p.name}`}
                  onClick={() => void toggle(p.id)}
                >
                  <Heart
                    size={22}
                    strokeWidth={2.75}
                    fill={fav ? 'currentColor' : 'none'}
                    aria-hidden="true"
                  />
                </button>
              </div>
              <p className="small muted">
                {KIND_NAMES[p.kind]} · {p.town}
                {here && ` · ${milesBetween(here, p).toFixed(1)} mi`}
              </p>
              <p className={open ? 'place-open on' : 'place-open'}>
                {openingText(p, clock)}
              </p>
              <ul className="tags" aria-label="Sells">
                {p.sells.map((s) => (
                  <li key={s} className="tag">
                    {SELLS[s] ?? s}
                  </li>
                ))}
              </ul>
              <p className="place-links small">
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.name}, ${p.address}, ${p.town}, NC ${p.zip}`)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {p.address}
                </a>
                {p.website && (
                  <>
                    {' · '}
                    <a href={p.website} target="_blank" rel="noreferrer">
                      Website
                    </a>
                  </>
                )}
              </p>
              <p className="small muted">
                Checked {longDate(p.checkedOn)} ·{' '}
                <a href={p.sourceUrl} target="_blank" rel="noreferrer">
                  Source
                </a>
              </p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
