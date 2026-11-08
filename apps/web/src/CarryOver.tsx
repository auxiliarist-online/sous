import { useEffect, useState } from 'react'
import type { CookedApi } from './cooked.ts'
import { addDays, type PlanEntry } from './plan.ts'

export interface CarryOverApi extends Pick<CookedApi, 'cookedEntries'> {
  plan(weekStart: string): Promise<PlanEntry[]>
  moveEntry(id: string, weekStart: string): Promise<void>
}

// Where "Not now" is remembered, per week it was said for.
const dismissKey = (week: string) => `sous:carry-over-dismissed:${week}`

/** Whether "Not now" was said for this week (false when storage is off). */
function dismissed(week: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(week)) !== null
  } catch {
    return false
  }
}

/** Last week's meals that weren't cooked, offered to move into this week
 *  (TYL-147). Callers key it by the week, so a new week starts afresh. Weeks start on Monday, so a plan made over the weekend (or
 *  just not cooked yet) used to vanish from "this week" with no way on. */
export function CarryOver({
  api,
  week,
  onMoved,
}: {
  api: CarryOverApi
  /** This week (a Monday). */
  week: string
  onMoved: () => void
}) {
  const last = addDays(week, -7)
  const [left, setLeft] = useState<PlanEntry[] | null>(null)
  const [hidden, setHidden] = useState(() => dismissed(last))
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (hidden) return
    let live = true
    // Optional: nothing shows when last week can't be read.
    api
      .plan(last)
      .then(async (entries) => {
        if (!entries.length) return []
        const cooked = await api.cookedEntries(entries.map((e) => e.id))
        return entries.filter((e) => !cooked[e.id])
      })
      .then(
        (uncooked) => live && setLeft(uncooked),
        () => {},
      )
    return () => {
      live = false
    }
  }, [api, last, hidden])

  if (hidden || !left?.length) return null

  // Move each one; what moved is gone from last week even if one fails.
  async function move() {
    setBusy(true)
    setFailed(false)
    const moved: string[] = []
    try {
      for (const e of left ?? []) {
        await api.moveEntry(e.id, week)
        moved.push(e.id)
      }
      setLeft([])
    } catch {
      setLeft((l) => (l ?? []).filter((e) => !moved.includes(e.id)))
      setFailed(true)
    } finally {
      setBusy(false)
      if (moved.length) onMoved()
    }
  }

  // Don't offer last week's meals again.
  function notNow() {
    try {
      window.localStorage.setItem(dismissKey(last), '1')
    } catch {
      // Storage off: it's just hidden until the page reloads.
    }
    setHidden(true)
  }

  const n = left.length
  return (
    <section className="carry-over" aria-labelledby="carry-over-title">
      <h3 id="carry-over-title">From last week</h3>
      <p className="small">
        {n === 1 ? '1 meal' : `${n} meals`} from last week{' '}
        {n === 1 ? "wasn't" : "weren't"} cooked:{' '}
        {left.map((e) => e.title).join(', ')}.
      </p>
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void move()}>
          {n === 1 ? 'Move it to this week' : 'Move them to this week'}
        </button>
        <button type="button" className="link" disabled={busy} onClick={notNow}>
          Not now
        </button>
      </div>
      {failed && (
        <p className="error small" role="alert">
          We couldn't move them all. Try again.
        </p>
      )}
    </section>
  )
}
