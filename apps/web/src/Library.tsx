import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { ImportResult, SavedRecipe } from './library.ts'

/** What the screen needs from the API and database; tests pass fakes. */
export interface LibraryApi {
  list(): Promise<SavedRecipe[]>
  save(url: string): Promise<ImportResult>
  remove(recipeId: string): Promise<void>
}

type Status =
  | { state: 'idle' }
  | { state: 'saving'; url: string }
  | { state: 'saved'; result: ImportResult }
  | { state: 'error'; message: string }

function sourceLabel(name: string | null, url: string): string {
  return name || new URL(url).hostname.replace(/^www\./, '')
}

export function Library({
  api,
  sharedUrl,
}: {
  api: LibraryApi
  sharedUrl?: string | null
}) {
  const [url, setUrl] = useState(sharedUrl ?? '')
  const [status, setStatus] = useState<Status>({ state: 'idle' })
  const [recipes, setRecipes] = useState<SavedRecipe[] | null>(null)
  const [listError, setListError] = useState(false)

  const refresh = useCallback(() => {
    api.list().then(
      (list) => {
        setRecipes(list)
        setListError(false)
      },
      () => setListError(true),
    )
  }, [api])

  useEffect(refresh, [refresh])

  const save = useCallback(
    async (link: string) => {
      const target = link.trim()
      if (!target) return
      setStatus({ state: 'saving', url: target })
      try {
        const result = await api.save(
          target.includes('://') ? target : `https://${target}`,
        )
        setStatus({ state: 'saved', result })
        setUrl('')
        refresh()
      } catch (e) {
        setStatus({ state: 'error', message: (e as Error).message })
      }
    },
    [api, refresh],
  )

  // A recipe shared to Sous from another app is saved straight away, once.
  const handledShare = useRef(false)
  useEffect(() => {
    if (sharedUrl && !handledShare.current) {
      handledShare.current = true
      void save(sharedUrl)
    }
  }, [sharedUrl, save])

  function submit(e: FormEvent) {
    e.preventDefault()
    void save(url)
  }

  async function remove(recipe: SavedRecipe) {
    if (!confirm(`Remove “${recipe.title}” from your recipes?`)) return
    await api.remove(recipe.id)
    refresh()
  }

  return (
    <>
      <form className="card" onSubmit={submit}>
        <h2>Add a recipe</h2>
        <label htmlFor="recipe-url">Recipe link</label>
        <input
          id="recipe-url"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="https://"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          type="submit"
          disabled={status.state === 'saving' || !url.trim()}
        >
          {status.state === 'saving' ? 'Saving…' : 'Save recipe'}
        </button>
        <p className="muted small">
          Tip: install Sous on your phone, then share recipes to it from your
          browser.
        </p>
      </form>

      <div aria-live="polite">
        {status.state === 'saving' && (
          <p className="card muted">
            Reading the recipe… this can take a few seconds.
          </p>
        )}
        {status.state === 'error' && (
          <p className="card error" role="alert">
            {status.message}
          </p>
        )}
        {status.state === 'saved' && <Saved result={status.result} />}
      </div>

      <section className="card">
        <h2>Your recipes</h2>
        {listError && (
          <p className="error" role="alert">
            We couldn't load your recipes.
          </p>
        )}
        {recipes === null && !listError && <p className="muted">Loading…</p>}
        {recipes?.length === 0 && (
          <p className="muted">
            Nothing saved yet. Paste a link above, or share a recipe to Sous
            from your browser.
          </p>
        )}
        {!!recipes?.length && (
          <ul className="recipes">
            {recipes.map((r) => (
              <li key={r.id}>
                <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {r.title}
                </a>
                <span className="muted small">
                  {sourceLabel(r.sourceName, r.sourceUrl)}
                  {r.totalMinutes ? ` · ${r.totalMinutes} min` : ''}
                </span>
                <button
                  type="button"
                  className="remove"
                  aria-label={`Remove ${r.title}`}
                  onClick={() => void remove(r)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function Saved({ result }: { result: ImportResult }) {
  const source = sourceLabel(result.source_name, result.source_url)
  return (
    <section className="card saved">
      <p className="muted small">Saved to your recipes</p>
      <h3>{result.title}</h3>
      {/* The source's page is the main action: instructions live there (policy). */}
      <a
        className="button"
        href={result.source_url}
        target="_blank"
        rel="noopener noreferrer"
      >
        View full recipe on {source}
      </a>
      {result.visibility === 'private' && (
        <p className="muted small">Only you can see this recipe.</p>
      )}
    </section>
  )
}
