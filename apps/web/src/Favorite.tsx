import { useState } from 'react'
import { FREQUENCIES, type Frequency } from './variety.ts'

/** The heart on a recipe (TYL-66), and once it's a favorite, how often it
 *  should come back. */
export function FavoriteControl({
  title,
  favorite,
  onChange,
}: {
  title: string
  favorite: Frequency | null
  onChange: (frequency: Frequency | null) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  // Save a new rhythm (or none), with the controls disabled meanwhile.
  async function change(frequency: Frequency | null) {
    setBusy(true)
    setFailed(false)
    try {
      await onChange(frequency)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="favorite">
      <button
        type="button"
        className="chip heart"
        aria-pressed={favorite !== null}
        aria-label={
          favorite ? `Remove ${title} from favorites` : `Favorite ${title}`
        }
        disabled={busy}
        onClick={() => void change(favorite ? null : 'biweekly')}
      >
        {favorite ? '♥' : '♡'}
      </button>
      {favorite && (
        <>
          <label className="visually-hidden" htmlFor="favorite-often">
            How often {title} comes back
          </label>
          <select
            id="favorite-often"
            value={favorite}
            disabled={busy}
            onChange={(e) => void change(e.target.value as Frequency)}
          >
            {FREQUENCIES.map(([f, label]) => (
              <option key={f} value={f}>
                {label}
              </option>
            ))}
          </select>
        </>
      )}
      {failed && (
        <span role="alert" className="error small">
          {' '}
          Couldn't save. Try again.
        </span>
      )}
    </span>
  )
}
