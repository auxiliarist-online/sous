import { useCallback, useEffect, useState } from 'react'
import { dollars, formatQuantity, type WeekDraft } from './plan.ts'

export interface DraftApi {
  /** Draft the week's open dinners (TYL-65); nothing is saved. */
  draftWeek(
    weekStart: string,
    options: { dinners: number; locked: string[]; exclude: string[] },
  ): Promise<WeekDraft>
  addToPlan(
    weekStart: string,
    recipeId: string,
    scale?: 1,
    day?: string | null,
  ): Promise<void>
}

/** "Plan my week" (TYL-65): a draft of the open dinners from the user's saved
 *  recipes, each with why it was picked. Swap one for the next best, lock the
 *  ones to keep when drafting again, then add them to the week. */
export function DraftWeek({
  api,
  week,
  planned,
  onDone,
  onCancel,
}: {
  api: DraftApi
  week: string
  /** How many dinners are planned already; they count toward the total. */
  planned: number
  onDone: () => void
  onCancel: () => void
}) {
  const [dinners, setDinners] = useState(Math.max(5, planned + 1))
  const [draft, setDraft] = useState<WeekDraft | null>(null)
  const [locked, setLocked] = useState<string[]>([])
  const [excluded, setExcluded] = useState<string[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'adding' | 'error'>(
    'loading',
  )

  // Ask for a draft keeping `keep` and never picking `skip`.
  const run = useCallback(
    async (count: number, keep: string[], skip: string[]) => {
      setState('loading')
      try {
        setDraft(
          await api.draftWeek(week, {
            dinners: count,
            locked: keep,
            exclude: skip,
          }),
        )
        setState('ready')
      } catch {
        setState('error')
      }
    },
    [api, week],
  )

  // Draft as soon as it opens, and again when the number of dinners changes.
  useEffect(() => {
    void run(dinners, locked, excluded)
    // Locks and swaps redraft on their own; only the count does here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, dinners])

  // Swap one pick for the next best, keeping every other pick as it is.
  function swap(recipeId: string) {
    const skip = [...excluded, recipeId]
    setExcluded(skip)
    const keep = draft!.picks
      .map((p) => p.recipeId)
      .filter((r) => r !== recipeId)
    void run(dinners, keep, skip)
  }

  // Keep a pick (or stop keeping it) when drafting again.
  function toggleLock(recipeId: string) {
    setLocked((l) =>
      l.includes(recipeId) ? l.filter((r) => r !== recipeId) : [...l, recipeId],
    )
  }

  // Add the drafted dinners to the week, as ordinary plan entries.
  async function accept() {
    setState('adding')
    try {
      for (const p of draft!.picks)
        await api.addToPlan(week, p.recipeId, 1, null)
      onDone()
    } catch {
      setState('error')
    }
  }

  const busy = state === 'loading' || state === 'adding'
  return (
    <section className="card draft" aria-labelledby="draft-title">
      <h3 id="draft-title">Plan my week</h3>
      <label htmlFor="draft-dinners">Dinners this week</label>
      <select
        id="draft-dinners"
        value={dinners}
        disabled={busy}
        onChange={(e) => setDinners(Number(e.target.value))}
      >
        {[3, 4, 5, 6, 7]
          .filter((n) => n > planned)
          .map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
      </select>
      {planned > 0 && (
        <p className="small muted">
          Counting the {planned} already planned; those stay as they are.
        </p>
      )}
      {state === 'loading' && <p className="muted">Drafting your week…</p>}
      {state === 'error' && (
        <p role="alert" className="error">
          We couldn't draft your week.{' '}
          <button
            type="button"
            className="link"
            onClick={() => void run(dinners, locked, excluded)}
          >
            Try again
          </button>
        </p>
      )}
      {draft && state !== 'loading' && (
        <>
          {draft.picks.length === 0 ? (
            <p className="muted">
              No saved recipes fit this week yet. Save a few, then try again.
            </p>
          ) : (
            <ul className="draft-picks">
              {draft.picks.map((p) => (
                <li key={p.recipeId}>
                  <span>
                    <strong>{p.title}</strong>
                    <span className="small muted"> · {p.reason}</span>
                  </span>
                  <span className="chips">
                    <button
                      type="button"
                      className="chip"
                      aria-pressed={locked.includes(p.recipeId)}
                      aria-label={`Keep ${p.title}`}
                      disabled={busy}
                      onClick={() => toggleLock(p.recipeId)}
                    >
                      {locked.includes(p.recipeId) ? 'Kept' : 'Keep'}
                    </button>
                    <button
                      type="button"
                      className="chip"
                      aria-label={`Swap ${p.title}`}
                      disabled={busy}
                      onClick={() => swap(p.recipeId)}
                    >
                      Swap
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="small">
            About {dollars(draft.totalCents)} for the week
            {draft.budgetCents !== null &&
              ` of your ${dollars(draft.budgetCents)} budget`}
            .
          </p>
          {draft.notes.map((n) => (
            <p key={n} className="small warning">
              {n}
            </p>
          ))}
          {draft.leftovers.length > 0 && (
            <p className="small muted">
              Left over:{' '}
              {draft.leftovers
                .map((l) => `${formatQuantity(l.quantity)} ${l.unit} ${l.name}`)
                .join(', ')}
              .
            </p>
          )}
        </>
      )}
      <div className="draft-actions">
        <button
          type="button"
          disabled={busy || !draft?.picks.length}
          onClick={() => void accept()}
        >
          {state === 'adding'
            ? 'Adding…'
            : `Add ${draft?.picks.length ?? ''} to my week`}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void run(dinners, locked, excluded)}
        >
          Draft again
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  )
}
