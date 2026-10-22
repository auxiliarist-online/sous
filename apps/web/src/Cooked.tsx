import { useState, type FormEvent } from 'react'
import type { Cooked, CookedApi, Rating } from './cooked.ts'

const RATINGS: [Rating, string, string][] = [
  ['down', '👎', 'Not again'],
  ['up', '👍', 'Good'],
  ['love', '❤️', 'Would make again'],
]

/** "Cooked it" (TYL-68): one tap records the meal; then an optional rating
 *  and a private note. Once cooked, it says so, with the rating, and the
 *  tap can be undone. */
export function CookedButton({
  api,
  recipeId,
  title,
  planEntryId = null,
  cookedOn,
  scale = 1,
  cooked: initial = null,
  onChange,
}: {
  api: CookedApi
  recipeId: string
  /** The recipe's name, for screen readers. */
  title: string
  planEntryId?: string | null
  cookedOn: string
  scale?: number
  cooked?: Cooked | null
  /** Told whenever the record changes (cooked, rated, undone). */
  onChange?: (cooked: Cooked | null) => void
}) {
  const [cooked, setCooked] = useState<Cooked | null>(initial)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [noting, setNoting] = useState(false)
  const [note, setNote] = useState(initial?.note ?? '')
  const [favorited, setFavorited] = useState(false)
  // On-hand items the recipe used, to ask about once it's cooked (TYL-137).
  const [used, setUsed] = useState<{ ingredientId: string; name: string }[]>([])

  function update(next: Cooked | null) {
    setCooked(next)
    onChange?.(next)
  }

  // Do one save, with the controls disabled meanwhile and a message if it fails.
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setFailed(false)
    try {
      await action()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  // Record the meal as cooked, then ask about what was on hand.
  const mark = () =>
    run(async () => {
      update(await api.markCooked({ recipeId, planEntryId, cookedOn, scale }))
      // Only a question: if it can't load, nothing is asked.
      api.onHandIn(recipeId).then(setUsed, () => {})
    })

  // "Used up the spinach?": one tap takes it out of the pantry.
  const markUsedUp = (item: { ingredientId: string; name: string }) =>
    run(async () => {
      await api.setPantry(item.ingredientId, null)
      setUsed((u) => u.filter((x) => x.ingredientId !== item.ingredientId))
    })

  // Set a rating, or clear it by tapping the same one again.
  const rate = (rating: Rating) =>
    run(async () => {
      const next = cooked!.rating === rating ? null : rating
      await api.rateCooked(cooked!.id, { rating: next })
      update({ ...cooked!, rating: next })
    })

  // Save the note (an empty one clears it) and close the field.
  const saveNote = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      await api.rateCooked(cooked!.id, { note })
      update({ ...cooked!, note: note.trim() || null })
      setNoting(false)
    })
  }

  // Make the recipe a favorite, after a ❤️ (TYL-66).
  const favorite = () =>
    run(async () => {
      await api.addFavorite(recipeId)
      setFavorited(true)
    })

  // Take the "cooked" back, rating and note with it.
  const undo = () =>
    run(async () => {
      await api.undoCooked(cooked!.id)
      update(null)
      setNote('')
      setUsed([])
    })

  if (!cooked) {
    return (
      <span className="cooked">
        <button
          type="button"
          className="chip"
          disabled={busy}
          aria-label={`Cooked ${title}`}
          onClick={() => void mark()}
        >
          Cooked it
        </button>
        {failed && (
          <span role="alert" className="error small">
            {' '}
            Couldn't save. Try again.
          </span>
        )}
      </span>
    )
  }

  return (
    <span className="cooked">
      <span className="small">Cooked ✓</span>
      <span className="chips" role="group" aria-label={`Rate ${title}`}>
        {RATINGS.map(([rating, emoji, label]) => (
          <button
            key={rating}
            type="button"
            className="chip"
            aria-label={label}
            aria-pressed={cooked.rating === rating}
            disabled={busy}
            onClick={() => void rate(rating)}
          >
            {emoji}
          </button>
        ))}
      </span>
      {cooked.rating === 'love' &&
        (favorited ? (
          <span className="small muted">In your favorites</span>
        ) : (
          <button
            type="button"
            className="link small"
            disabled={busy}
            onClick={() => void favorite()}
          >
            Add to favorites
          </button>
        ))}
      {!noting && (
        <button
          type="button"
          className="link small"
          disabled={busy}
          onClick={() => setNoting(true)}
        >
          {cooked.note ? 'Edit note' : 'Add a note'}
        </button>
      )}
      <button
        type="button"
        className="link small"
        disabled={busy}
        onClick={() => void undo()}
      >
        Undo
      </button>
      {used.length > 0 && (
        <span className="used-up">
          {used.map((u) => (
            <button
              key={u.ingredientId}
              type="button"
              className="chip"
              disabled={busy}
              onClick={() => void markUsedUp(u)}
            >
              Used up the {u.name}?
            </button>
          ))}
          <button
            type="button"
            className="link small"
            onClick={() => setUsed([])}
          >
            Still have {used.length === 1 ? 'it' : 'them'}
          </button>
        </span>
      )}
      {noting && (
        <form className="cooked-note" onSubmit={saveNote}>
          <label className="visually-hidden" htmlFor={`note-${cooked.id}`}>
            Note for next time
          </label>
          <input
            id={`note-${cooked.id}`}
            maxLength={500}
            placeholder="Less salt, kids loved it…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="submit" className="chip" disabled={busy}>
            Save note
          </button>
        </form>
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
