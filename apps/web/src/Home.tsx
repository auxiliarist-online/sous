import { useEffect, useState } from 'react'
import {
  dayName,
  dollars,
  weekOf,
  type PlanCost,
  type PlanEntry,
} from './plan.ts'
import { plannedItems } from './list.ts'
import { CookedButton } from './Cooked.tsx'
import { SeasonCard, type SeasonApi } from './SeasonCard.tsx'
import type { Cooked, CookedApi } from './cooked.ts'
import { Link } from './router.tsx'

export interface HomeApi extends CookedApi, SeasonApi {
  /** The week's planned recipes. */
  plan(weekStart: string): Promise<PlanEntry[]>
  /** The week's buy list and cost against the budget. */
  planCost(weekStart: string): Promise<PlanCost>
}

/** Today as YYYY-MM-DD, in the user's time zone. */
function today(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Home is this week (TYL-72): what's for dinner tonight, the days ahead, and
 *  what's left to buy against the budget, each leading to where you act. */
export function Home({ api, now }: { api: HomeApi; now?: Date }) {
  // The time when the page opened (tests pass one).
  const [opened] = useState(() => now ?? new Date())
  const week = weekOf(opened)
  const [entries, setEntries] = useState<PlanEntry[] | null>(null)
  const [cost, setCost] = useState<PlanCost | null>(null)
  const [costFailed, setCostFailed] = useState(false)
  const [failed, setFailed] = useState(false)
  // Tonight's meals already cooked (TYL-68), by plan entry.
  const [cooked, setCooked] = useState<Record<string, Cooked> | null>(null)

  useEffect(() => {
    let live = true
    api.plan(week).then(
      (e) => {
        if (!live) return
        setEntries(e)
        api.cookedEntries(e.map((x) => x.id)).then(
          (c) => live && setCooked(c),
          () => live && setCooked({}),
        )
        setCostFailed(false) // a new request: an earlier failure no longer holds
        // The cost comes from the API; home works without it.
        if (e.length)
          api.planCost(week).then(
            (c) => live && setCost(c),
            () => live && setCostFailed(true),
          )
      },
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [api, week])

  if (failed) {
    return (
      <p className="card error" role="alert">
        We couldn't load this week.
      </p>
    )
  }
  if (!entries) return <p className="card muted">Loading…</p>

  if (!entries.length) {
    return (
      <section className="card home">
        <h2>This week</h2>
        <p className="muted">Nothing planned yet.</p>
        <Link to="/plan" className="button">
          Plan this week
        </Link>
        <Link to="/browse" className="small">
          Find recipes
        </Link>
        <SeasonCard api={api} now={opened} />
      </section>
    )
  }

  const day = today(opened)
  const tonight = entries.filter((e) => e.day === day)
  const ahead = entries.filter((e) => e.day !== null && e.day > day)
  const anyDay = entries.filter((e) => e.day === null)
  // What the list holds from the plan (items Sous couldn't match aren't on it).
  const toBuy = cost ? plannedItems(cost) : []

  return (
    <section className="card home">
      <h2>This week</h2>

      <section aria-labelledby="tonight">
        <h3 id="tonight">Tonight</h3>
        {tonight.length ? (
          <ul className="home-meals">
            {tonight.map((e) => (
              <li key={e.id}>
                <Link to={`/recipe/${e.recipeId}`}>{e.title}</Link>
                {cooked && (
                  <CookedButton
                    api={api}
                    recipeId={e.recipeId}
                    title={e.title}
                    planEntryId={e.id}
                    cookedOn={day}
                    scale={e.scale}
                    cooked={cooked[e.id] ?? null}
                  />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">
            Nothing planned for tonight.
            {anyDay.length > 0 &&
              ` ${anyDay.length} recipe${anyDay.length === 1 ? ' is' : 's are'} planned for any day.`}
          </p>
        )}
      </section>

      {ahead.length > 0 && (
        <section aria-labelledby="ahead">
          <h3 id="ahead">Coming up</h3>
          <ul className="home-meals">
            {ahead.slice(0, 4).map((e) => (
              <li key={e.id}>
                <span className="muted small">{dayName(e.day!)} · </span>
                <Link to={`/recipe/${e.recipeId}`}>{e.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link to="/plan" className="small">
        See and change the plan
      </Link>

      <section aria-labelledby="shopping">
        <h3 id="shopping">Shopping</h3>
        {cost ? (
          <p className="small">
            {toBuy.length} item{toBuy.length === 1 ? '' : 's'} to buy ·{' '}
            {cost.estimated ? '~' : ''}
            {dollars(cost.totalCents)}
            {cost.budgetCents !== null && ` of ${dollars(cost.budgetCents)}`}
          </p>
        ) : (
          <p className="muted small">
            {costFailed
              ? "We couldn't work out the cost just now; the list still works."
              : 'Working out what to buy…'}
          </p>
        )}
        <Link to="/list" className="button">
          Open the list
        </Link>
      </section>

      <SeasonCard api={api} now={opened} />
    </section>
  )
}
