import { useEffect, useState } from 'react'
import { Leaf } from 'lucide-react'
import { openingText, type LocalPlace } from './local.ts'
import { Link } from './router.tsx'
import { comingNext, inSeasonNow, monthsText, type Seasons } from './seasons.ts'

export interface SeasonalApi {
  /** What's in season where the user lives (TYL-70). */
  seasons(): Promise<Seasons>
  /** A few recipes for each of these ingredients, saved ones first. */
  seasonalRecipes(
    ingredientIds: string[],
  ): Promise<
    Map<
      string,
      { id: string; title: string; saved: boolean; source: string | null }[]
    >
  >
  /** The local food directory and the user's favorites (TYL-69). */
  localPlaces(): Promise<LocalPlace[]>
  favoritePlaces(): Promise<string[]>
}

/** The Seasonal page (TYL-90): what's in season now, each with recipes that
 *  use it, what's coming next month, and the user's markets that sell
 *  produce. `now` is for tests. */
export function SeasonalPage({ api, now }: { api: SeasonalApi; now?: Date }) {
  // The time, for the month and "open now": kept current while the page is
  // open (tests fix it).
  const [clock, setClock] = useState(() => now ?? new Date())
  useEffect(() => {
    if (now) return
    const tick = setInterval(() => setClock(new Date()), 60_000)
    return () => clearInterval(tick)
  }, [now])
  const month = clock.getMonth() + 1
  const [seasons, setSeasons] = useState<Seasons | null>(null)
  // The api whose load failed: a new one starts without the error.
  const [failedFor, setFailedFor] = useState<SeasonalApi | null>(null)
  const failed = failedFor === api
  // Loads so far (Try again adds one), and the one whose recipes failed.
  const [attempt, setAttempt] = useState(0)
  const [recipesFailedAt, setRecipesFailedAt] = useState<number | null>(null)
  const recipesFailed = recipesFailedAt === attempt
  const [recipes, setRecipes] = useState<
    Map<
      string,
      { id: string; title: string; saved: boolean; source: string | null }[]
    >
  >(new Map())
  const [markets, setMarkets] = useState<LocalPlace[] | null>(null)

  // What's in season, then the recipes for it.
  useEffect(() => {
    let live = true
    api.seasons().then(
      (s) => {
        if (!live) return
        setSeasons(s)
        const ids = inSeasonNow(s, month).map((i) => i.ingredientId)
        api.seasonalRecipes(ids).then(
          (r) => live && setRecipes(r),
          () => live && setRecipesFailedAt(attempt),
        )
      },
      () => live && setFailedFor(api),
    )
    // The user's places that sell produce; the page works without them.
    Promise.all([api.localPlaces(), api.favoritePlaces()]).then(
      ([places, favorites]) =>
        live &&
        setMarkets(
          places.filter(
            (p) =>
              favorites.includes(p.id) &&
              (p.sells.includes('produce') || p.sells.includes('groceries')),
          ),
        ),
      () => live && setMarkets([]),
    )
    return () => {
      live = false
    }
  }, [api, month, attempt])

  const now_ = seasons ? inSeasonNow(seasons, month) : []
  const next = seasons ? comingNext(seasons, month) : []
  const monthName = clock.toLocaleDateString('en-US', { month: 'long' })

  return (
    <section className="screen seasonal" aria-labelledby="seasonal-title">
      <h2 id="seasonal-title" className="screen-title">
        In season <small>{monthName}</small>
      </h2>
      {markets && markets.length > 0 ? (
        <p className="panel seasonal-markets small">
          <strong>Find it at your markets:</strong>{' '}
          {markets.map((m, n) => (
            <span key={m.id}>
              {n > 0 && ' · '}
              {m.name} ({openingText(m, clock)})
            </span>
          ))}
        </p>
      ) : (
        markets && (
          <p className="small">
            <Link to="/local">Find markets near you</Link> that sell what's in
            season.
          </p>
        )
      )}
      {failed && (
        <p role="alert" className="error">
          We couldn't load what's in season.
        </p>
      )}
      {!failed && !seasons && <p className="muted">Loading…</p>}
      {seasons && now_.length === 0 && (
        <p className="muted">Nothing seasonal this month.</p>
      )}
      {recipesFailed && (
        <p role="alert" className="error small">
          We couldn't load the recipes for these.{' '}
          <button
            type="button"
            className="link"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Try again
          </button>
        </p>
      )}
      <ul className="seasonal-list">
        {now_.map((item) => {
          const list = recipes.get(item.ingredientId) ?? []
          return (
            <li key={item.ingredientId} className="panel">
              <h3>
                <Leaf size={18} strokeWidth={2.75} aria-hidden="true" />{' '}
                {item.name}
              </h3>
              <p className="small muted">
                In season {monthsText(seasons!.get(item.ingredientId)!.months)}
              </p>
              {list.length > 0 && (
                <ul
                  className="seasonal-recipes"
                  aria-label={`Recipes with ${item.name}`}
                >
                  {list.map((r) => (
                    <li key={r.id}>
                      <Link to={`/recipe/${r.id}`}>{r.title}</Link>
                      {r.source && (
                        <span className="small muted">{r.source}</span>
                      )}
                      {r.saved && <span className="tag">Yours</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      {next.length > 0 && (
        <>
          <h3 className="kicker">Coming next month</h3>
          <p className="seasonal-next">{next.map((i) => i.name).join(', ')}</p>
        </>
      )}
    </section>
  )
}
