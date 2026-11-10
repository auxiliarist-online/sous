import { useEffect, useMemo, useState } from 'react'
import {
  dayName,
  dollars,
  weekDays,
  monthDay,
  unreviewed,
  weekOf,
  type PlanCost,
  type PlanEntry,
} from './plan.ts'
import { plannedItems } from './list.ts'
import { CookedButton } from './Cooked.tsx'
import { SeasonCard, type SeasonApi } from './SeasonCard.tsx'
import type { Cooked, CookedApi } from './cooked.ts'
import { cookPath } from './navigation.ts'
import { Link } from './router.tsx'
import { SlidersHorizontal } from 'lucide-react'
import { CarryOver } from './CarryOver.tsx'
import { PendingNotice, ReviewSheet, type ReviewApi } from './Review.tsx'

export interface HomeApi extends CookedApi, SeasonApi, ReviewApi {
  /** The week's planned recipes. */
  plan(weekStart: string): Promise<PlanEntry[]>
  /** The week's buy list and cost against the budget. */
  planCost(weekStart: string): Promise<PlanCost>
  /** Move a planned meal to another week (last week's, uncooked: TYL-147). */
  moveEntry(id: string, weekStart: string): Promise<void>
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
  // Bumped to load the week again (after last week's meals move in).
  const [version, setVersion] = useState(0)
  const [reviewing, setReviewing] = useState(false)
  // Not on the list yet; the same array while the plan doesn't change, so an
  // open review keeps its answers.
  const pending = useMemo(() => unreviewed(entries), [entries])

  useEffect(() => {
    let live = true
    api.plan(week).then(
      (e) => {
        if (!live) return
        setFailed(false)
        setEntries(e)
        api.cookedEntries(e.map((x) => x.id)).then(
          (c) => live && setCooked(c),
          () => live && setCooked({}),
        )
        setCostFailed(false) // a new request: an earlier failure no longer holds
        // The cost comes from the API; home works without it.
        if (e.length)
          // The list's own cost: the meals reviewed for it (TYL-150).
          api.listCost(week).then(
            (c) => live && setCost(c),
            () => live && setCostFailed(true),
          )
      },
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [api, week, version])

  if (failed) {
    return (
      <p className="card error" role="alert">
        We couldn't load this week.{' '}
        <button
          type="button"
          className="link"
          onClick={() => setVersion((v) => v + 1)}
        >
          Try again
        </button>
      </p>
    )
  }
  if (!entries) return <p className="card muted">Loading…</p>

  const day = today(opened)
  const days = weekDays(week)
  const tonight = entries.filter((e) => e.day === day)
  const anyDay = entries.filter((e) => e.day === null)
  // What the list holds: the reviewed meals' items (unmatched ones aren't on it).
  const toBuy = cost ? plannedItems(cost) : []
  const n = entries.length

  return (
    <section className="home" aria-label="This week">
      <header className="week-head">
        <span className="wordmark">Sous</span>
        <span className="small muted">Week of {monthDay(week)}</span>
        <Link to="/settings" className="icon-button" label="Preferences">
          <SlidersHorizontal size={20} strokeWidth={2.75} aria-hidden="true" />
        </Link>
      </header>
      <h2 className="ledger-title">
        This week,
        <br />
        {n === 0 ? 'nothing planned' : `${n} dinner${n === 1 ? '' : 's'}`}.
      </h2>
      <CarryOver
        key={week}
        api={api}
        week={week}
        onMoved={() => setVersion((v) => v + 1)}
      />

      {/* The ledger (TYL-149): a row per day, today first in dark green. */}
      <ol className="ledger" aria-label="Dinners this week">
        {days.map((d) => {
          const planned = entries.filter((e) => e.day === d)
          const isToday = d === day
          const label = dayName(d).slice(0, 3)
          if (!planned.length)
            return (
              <li
                key={d}
                className={isToday ? 'ledger-row today' : 'ledger-row open'}
              >
                <span className="ledger-day">{label}</span>
                <span className="ledger-title-text">Open</span>
                <Link
                  to="/browse"
                  className="ledger-tag"
                  label={`Add a recipe for ${dayName(d)}`}
                >
                  + Add
                </Link>
              </li>
            )
          return planned.map((e, k) => (
            <li
              key={e.id}
              className={isToday ? 'ledger-row today' : 'ledger-row'}
            >
              <span className="ledger-day">{k === 0 ? label : ''}</span>
              <Link to={`/recipe/${e.recipeId}`} className="ledger-title-text">
                {e.title}
              </Link>
              {isToday && k === 0 && (
                <span className="ledger-tag">Tonight</span>
              )}
            </li>
          ))
        })}
        {anyDay.map((e, k) => (
          <li key={e.id} className="ledger-row">
            <span className="ledger-day">{k === 0 ? 'Any' : ''}</span>
            <Link to={`/recipe/${e.recipeId}`} className="ledger-title-text">
              {e.title}
            </Link>
          </li>
        ))}
      </ol>

      {tonight.length > 0 && (
        <div className="tonight-actions" aria-label="Tonight">
          {tonight.map((e) => (
            <p key={e.id} className="small">
              <span className="muted">{e.title}: </span>
              <Link
                to={cookPath(e.recipeId, e.scale, e.id)}
                label={`Cook ${e.title}`}
              >
                Cook
              </Link>{' '}
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
            </p>
          ))}
        </div>
      )}

      <Link to="/plan" className="display-link">
        See and change the plan
      </Link>

      {n > 0 && (
        <section className="shopping-card" aria-labelledby="shopping">
          <div className="shopping-head">
            <h3 id="shopping">Shopping</h3>
            <span className="small muted">{toBuy.length} to buy</span>
          </div>
          {cost ? (
            <>
              <p className="shopping-total">
                <strong>
                  {cost.estimated ? '~' : ''}
                  {dollars(cost.totalCents)}
                </strong>
                {cost.budgetCents !== null && (
                  <span className="muted">
                    {' '}
                    of your {dollars(cost.budgetCents)} budget
                  </span>
                )}
              </p>
              {cost.budgetCents ? (
                <div className="meter" aria-hidden="true">
                  <span
                    style={{
                      width: `${Math.min(100, (cost.totalCents / cost.budgetCents) * 100)}%`,
                    }}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <p className="muted small">
              {costFailed
                ? "We couldn't work out the cost just now; the list still works."
                : 'Working out what to buy…'}
            </p>
          )}
          <PendingNotice
            entries={pending}
            onReview={() => setReviewing(true)}
          />
          <Link to="/list" className="button">
            Open the list
          </Link>
        </section>
      )}
      {reviewing && (
        <ReviewSheet
          api={api}
          week={week}
          entries={pending}
          onClose={() => setReviewing(false)}
        />
      )}

      <SeasonCard api={api} now={opened} />
    </section>
  )
}
