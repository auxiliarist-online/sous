import { useEffect, useState } from 'react'
import type { PantryStatus } from './plan.ts'

export interface PantryEntry {
  ingredientId: string
  name: string
  status: PantryStatus
}

export interface PantryApi {
  /** What the user has marked on hand (older entries may say out). */
  pantry(): Promise<PantryEntry[]>
  /** Common staples, offered as quick taps. */
  pantryStaples(): Promise<{ id: string; name: string }[]>
  /** Mark an ingredient on hand; null puts it back on the list. */
  setPantry(ingredientId: string, status: PantryStatus | null): Promise<void>
}

/** What's at home, as the shopping list sees it (TYL-88): nothing is
 *  assumed, so the user taps the staples they have, and anything else marked
 *  on hand is listed. Amounts come with the kitchen inventory (TYL-49). */
export function PantryPage({ api }: { api: PantryApi }) {
  const [marked, setMarked] = useState<PantryEntry[] | null>(null)
  const [staples, setStaples] = useState<{ id: string; name: string }[]>([])
  const [failed, setFailed] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  // Ingredients being saved: their buttons wait, so saves can't cross.
  const [saving, setSaving] = useState<string[]>([])

  useEffect(() => {
    let live = true
    Promise.all([api.pantry(), api.pantryStaples()]).then(
      ([m, s]) => {
        if (!live) return
        setMarked(m)
        setStaples(s)
      },
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [api])

  if (failed) {
    return (
      <p className="card error" role="alert">
        We couldn't load your pantry.
      </p>
    )
  }
  if (!marked) return <p className="card muted">Loading…</p>

  const status = new Map(marked.map((m) => [m.ingredientId, m.status]))
  const staple = new Set(staples.map((s) => s.id))
  const onHand = marked.filter(
    (m) => m.status === 'have' && !staple.has(m.ingredientId),
  )

  // Mark an ingredient on hand, or null to put it back on the list.
  async function mark(id: string, name: string, next: PantryStatus | null) {
    // Only this ingredient is put back if saving fails: others may have saved.
    const before = (marked ?? []).find((m) => m.ingredientId === id)
    const replace = (entry: PantryEntry | undefined) =>
      setMarked((all) => [
        ...(all ?? []).filter((m) => m.ingredientId !== id),
        ...(entry ? [entry] : []),
      ])
    replace(next ? { ingredientId: id, name, status: next } : undefined)
    setSaveFailed(false)
    setSaving((s) => [...s, id])
    try {
      await api.setPantry(id, next)
    } catch {
      replace(before)
      setSaveFailed(true)
    } finally {
      setSaving((s) => s.filter((x) => x !== id))
    }
  }

  return (
    <section className="card pantry">
      <h2>Pantry</h2>
      {saveFailed && (
        <p role="alert" className="error small">
          That didn't save. Try again.
        </p>
      )}
      <p className="muted small">
        What do you have? Tap the staples in your kitchen and they're left off
        your list. Anything a recipe needs that isn't marked here gets bought.
      </p>
      <div className="chips" aria-label="Staples">
        {staples.map((s) => {
          const have = status.get(s.id) === 'have'
          return (
            <button
              key={s.id}
              type="button"
              className="chip"
              aria-pressed={have}
              disabled={saving.includes(s.id)}
              onClick={() => void mark(s.id, s.name, have ? null : 'have')}
            >
              {have && <span aria-hidden="true">✓ </span>}
              {s.name}
            </button>
          )
        })}
      </div>
      {onHand.length > 0 && (
        <>
          <h3>Also on hand</h3>
          <ul className="recipes" aria-label="Also on hand">
            {onHand.map((m) => (
              <li key={m.ingredientId}>
                <span>{m.name}</span>
                <button
                  type="button"
                  className="chip"
                  disabled={saving.includes(m.ingredientId)}
                  aria-label={`I'm out of ${m.name}`}
                  onClick={() => void mark(m.ingredientId, m.name, null)}
                >
                  Used up
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
