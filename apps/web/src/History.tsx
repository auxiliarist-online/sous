import { useEffect, useState } from 'react'
import { shortDate, type HistoryItem, type Rating } from './cooked.ts'
import { Link } from './router.tsx'

export interface HistoryApi {
  /** Everything the user cooked, most recent first (TYL-68). */
  cookingHistory(): Promise<HistoryItem[]>
}

const SHOWN: Record<Rating, string> = { down: '👎', up: '👍', love: '❤️' }

/** What the user has cooked (TYL-68): each meal's day, recipe, rating and
 *  note, most recent first. */
export function History({ api }: { api: HistoryApi }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    api.cookingHistory().then(
      (h) => live && setItems(h),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [api])

  return (
    <section className="card history">
      <Link to="/settings" className="small">
        ← Settings
      </Link>
      <h2>What you've cooked</h2>
      {failed && (
        <p role="alert" className="error">
          We couldn't load your history.
        </p>
      )}
      {!failed && items === null && <p className="muted">Loading…</p>}
      {items?.length === 0 && (
        <p className="muted">
          Nothing yet. Tap “Cooked it” on a planned meal to start.
        </p>
      )}
      {items && items.length > 0 && (
        <ul className="history-list">
          {items.map((c) => (
            <li key={c.id}>
              <span className="muted small">{shortDate(c.cookedOn)} · </span>
              <Link to={`/recipe/${c.recipeId}`}>{c.title}</Link>
              {c.rating && (
                <span aria-label={`rated ${c.rating}`}> {SHOWN[c.rating]}</span>
              )}
              {c.note && <p className="small muted">{c.note}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
