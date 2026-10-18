import { useEffect, useState } from 'react'
import type { MyStore, NearbyStore } from './stores.ts'

export interface StoreApi {
  storesNear(zip: string): Promise<NearbyStore[]>
  myStore(): Promise<MyStore | null>
  chooseStore(locationId: string): Promise<void>
}

const ZIP = /^\d{5}$/

/** Where the user shops (TYL-19): their store now, and a zip code search for
 *  Kroger-family stores (Kroger, Harris Teeter, Ralphs...) to choose from. */
export function StorePicker({
  api,
  zip,
  onZip,
}: {
  api: StoreApi
  /** The user's zip code, if they've given one. */
  zip: string | null
  onZip: (zip: string) => void
}) {
  const [current, setCurrent] = useState<MyStore | null | undefined>(undefined)
  const [text, setText] = useState(zip ?? '')
  const [found, setFound] = useState<NearbyStore[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.myStore().then(
      (s) => live && setCurrent(s),
      () => live && setCurrent(null),
    )
    return () => {
      live = false
    }
  }, [api])

  // Look up stores near the typed zip code. (Not a form: Settings is one,
  // and forms can't nest.)
  async function search() {
    const z = text.trim()
    if (!ZIP.test(z)) {
      setMessage('Enter a five-digit zip code.')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const stores = await api.storesNear(z)
      setFound(stores)
      onZip(z)
      if (!stores.length) {
        setMessage(
          'No Kroger-family stores within 15 miles. Prices will be estimates, and you can enter your own.',
        )
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // Make a found store the user's store.
  async function choose(s: NearbyStore) {
    setBusy(true)
    setMessage(null)
    try {
      await api.chooseStore(s.locationId)
      setCurrent({ name: s.name, address: s.address })
      setFound(null)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="store-picker">
      {current ? (
        <p className="small">
          Prices from <strong>{current.name}</strong>
        </p>
      ) : (
        <p className="small muted">
          No store chosen yet, so prices are estimates. Find yours by zip code.
        </p>
      )}
      <div className="row" role="search">
        <div>
          <label htmlFor="zip">Your zip code</label>
          <input
            id="zip"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void search()
              }
            }}
          />
        </div>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void search()}
        >
          {busy ? 'Looking…' : 'Find stores'}
        </button>
      </div>
      {found && found.length > 0 && (
        <ul className="recipes" aria-label="Stores near you">
          {found.map((s) => (
            <li key={s.locationId}>
              <span>
                {s.name}
                <span className="muted small">
                  {' '}
                  · {s.address}, {s.city}
                </span>
              </span>
              <button
                type="button"
                className="chip"
                disabled={busy}
                aria-label={`Shop at ${s.name}`}
                onClick={() => void choose(s)}
              >
                Choose
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p role="status" className="muted small">
          {message}
        </p>
      )}
      <p className="muted small">
        Live prices come from Kroger-family stores (Kroger, Harris Teeter,
        Ralphs, Fred Meyer and others). Elsewhere, Sous uses estimates, and you
        can enter your own prices on the plan.
      </p>
    </div>
  )
}
