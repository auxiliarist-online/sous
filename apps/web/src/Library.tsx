import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { bookmarklet } from './bookmarklet.ts'
import {
  dietLabels,
  filterRecipes,
  ImportError,
  NO_FILTER,
  recipeTitle,
  sourceLabel,
  type ImportResult,
  type PageData,
  type RecipeFilter,
  type SavedRecipe,
} from './library.ts'
import { Link } from './router.tsx'

/** What the screen needs from the API and database; tests pass fakes. */
export interface LibraryApi {
  list(): Promise<SavedRecipe[]>
  save(url: string): Promise<ImportResult>
  savePage(page: PageData): Promise<ImportResult>
  remove(recipeId: string): Promise<void>
}

type Status =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved'; result: ImportResult }
  | { state: 'error'; message: string; code: string }

export function Library({
  api,
  sharedUrl,
  sharedPage,
  myDiets = [],
  onboarded = true,
}: {
  api: LibraryApi
  sharedUrl?: string | null
  /** A page sent by the Save to Sous bookmarklet, waiting for the user's OK. */
  sharedPage?: PageData | null
  /** The user's own diets, for the "Fits my diets" filter. */
  myDiets?: string[]
  /** False until the user has set preferences; shows a prompt. */
  onboarded?: boolean
}) {
  const [filter, setFilter] = useState<RecipeFilter>(NO_FILTER)
  const [url, setUrl] = useState(sharedUrl ?? '')
  const [page, setPage] = useState(sharedPage ?? null)
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

  async function run(importing: () => Promise<ImportResult>) {
    setStatus({ state: 'saving' })
    try {
      setStatus({ state: 'saved', result: await importing() })
      refresh()
      return true
    } catch (e) {
      const code = e instanceof ImportError ? e.code : 'error'
      setStatus({ state: 'error', message: (e as Error).message, code })
      return false
    }
  }

  async function save(link: string) {
    const target = link.trim()
    if (!target) return
    const full = target.includes('://') ? target : `https://${target}`
    if (await run(() => api.save(full))) setUrl('')
  }

  async function savePage(data: PageData) {
    if (await run(() => api.savePage(data))) setPage(null)
  }

  // A link shared to Sous only fills in the form: saving always takes the
  // user's tap, so another site can't add recipes by linking to /share.
  const confirmingShare =
    !!sharedUrl && url === sharedUrl && status.state === 'idle'

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
      {!onboarded && (
        <section className="card onboarding">
          <h2>Tell Sous how you eat</h2>
          <p className="muted">
            Your diets, allergies and favorite cuisines shape what Sous shows
            you.
          </p>
          <Link to="/settings" className="button">
            Set my preferences
          </Link>
        </section>
      )}

      <form className="card" onSubmit={submit}>
        <h2>
          {confirmingShare ? 'Save the recipe you shared?' : 'Add a recipe'}
        </h2>
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
        <Link to="/new" className="small">
          Or type in a recipe of your own
        </Link>
      </form>

      {page && (
        <SharedPage
          page={page}
          saving={status.state === 'saving'}
          onSave={() => void savePage(page)}
          onDismiss={() => setPage(null)}
        />
      )}

      <div aria-live="polite">
        {status.state === 'saving' && (
          <p className="card muted">
            Reading the recipe… this can take a few seconds.
          </p>
        )}
        {status.state === 'error' && (
          <p className="card error" role="alert">
            {status.message}
            {status.code === 'blocked' &&
              ' You can still save it with Save to Sous, below.'}
          </p>
        )}
        {status.state === 'saved' && <Saved result={status.result} />}
      </div>

      <BrowserImportHelp
        open={status.state === 'error' && status.code === 'blocked'}
      />

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
            Nothing saved yet. Paste a link above, share a recipe to Sous from
            your browser, or type one in.
          </p>
        )}
        {!!recipes?.length && (
          <Filters filter={filter} onChange={setFilter} myDiets={myDiets} />
        )}
        {!!recipes?.length && (
          <RecipeList
            recipes={filterRecipes(recipes, filter)}
            onRemove={(r) => void remove(r)}
          />
        )}
        {!!recipes?.length && (
          <p className="muted small">
            Diet labels come from the ingredients Sous recognizes. For
            allergies, always check the packaging.
          </p>
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

function SharedPage({
  page,
  saving,
  onSave,
  onDismiss,
}: {
  page: PageData
  saving: boolean
  onSave: () => void
  onDismiss: () => void
}) {
  const site = sourceLabel(page.siteName, page.url)
  return (
    <section className="card">
      <h2>Save the recipe from {site}?</h2>
      <p>
        <strong>{recipeTitle(page.ld) ?? page.url}</strong>
      </p>
      <button type="button" disabled={saving} onClick={onSave}>
        {saving ? 'Saving…' : 'Save recipe'}
      </button>
      <button type="button" className="link" onClick={onDismiss}>
        Not now
      </button>
    </section>
  )
}

/** How to set up Save to Sous, for sites that block Sous's server. */
function BrowserImportHelp({ open }: { open: boolean }) {
  const code = bookmarklet(window.location.origin)
  const link = useRef<HTMLAnchorElement>(null)
  const [copied, setCopied] = useState(false)

  // React refuses javascript: URLs in JSX, so set the bookmarklet by hand.
  useEffect(() => {
    link.current?.setAttribute('href', code)
  }, [code])

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <details className="card help" open={open || undefined}>
      <summary>Recipe from a site that blocks Sous?</summary>
      <p>
        Some sites turn away Sous's server. <strong>Save to Sous</strong> is a
        bookmark that sends the recipe from the page you're looking at instead.
        Nothing is sent until you tap Save in Sous.
      </p>
      <h3>On a computer</h3>
      <p>
        Drag this to your bookmarks bar:{' '}
        <a
          ref={link}
          className="bookmarklet"
          onClick={(e) => e.preventDefault()}
        >
          Save to Sous
        </a>
      </p>
      <h3>On Android (Chrome)</h3>
      <ol>
        <li>
          <button type="button" className="link" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy the Save to Sous code'}
          </button>
        </li>
        <li>Bookmark any page (⋮ → ☆), then edit that bookmark.</li>
        <li>
          Name it <strong>Save to Sous</strong> and paste the code as its URL.
        </li>
        <li>
          On a recipe page, tap the address bar, type <em>Save to Sous</em> and
          tap the bookmark.
        </li>
      </ol>
    </details>
  )
}

export function DietChips({ diets }: { diets: SavedRecipe['diets'] }) {
  const { labels, notes } = dietLabels(diets)
  if (!labels.length) return null
  return (
    <span className="diets">
      {labels.map((d) => (
        <span key={d} className="diet">
          {d}
        </span>
      ))}
      {notes.map((n) => (
        <span key={n} className="muted small diet-note">
          * {n}
        </span>
      ))}
    </span>
  )
}

const FILTER_DIETS: [slug: string, label: string][] = [
  ['vegetarian', 'Vegetarian'],
  ['vegan', 'Vegan'],
  ['gluten_free', 'Gluten-free'],
  ['dairy_free', 'Dairy-free'],
]

function Filters({
  filter,
  onChange,
  myDiets,
}: {
  filter: RecipeFilter
  onChange: (f: RecipeFilter) => void
  myDiets: string[]
}) {
  const toggleDiet = (slug: string) =>
    onChange({
      ...filter,
      diets: filter.diets.includes(slug)
        ? filter.diets.filter((d) => d !== slug)
        : [...filter.diets, slug],
    })
  const mine =
    myDiets.length > 0 && myDiets.every((d) => filter.diets.includes(d))
  return (
    <div className="filters">
      <label htmlFor="recipe-search" className="visually-hidden">
        Search your recipes
      </label>
      <input
        id="recipe-search"
        type="search"
        placeholder="Search your recipes"
        value={filter.query}
        onChange={(e) => onChange({ ...filter, query: e.target.value })}
      />
      <div className="chips" role="group" aria-label="Filters">
        {myDiets.length > 0 && (
          <button
            type="button"
            className="chip"
            aria-pressed={mine}
            onClick={() =>
              onChange({
                ...filter,
                diets: mine
                  ? filter.diets.filter((d) => !myDiets.includes(d))
                  : [...new Set([...filter.diets, ...myDiets])],
              })
            }
          >
            Fits my diets
          </button>
        )}
        {FILTER_DIETS.map(([slug, label]) => (
          <button
            key={slug}
            type="button"
            className="chip"
            aria-pressed={filter.diets.includes(slug)}
            onClick={() => toggleDiet(slug)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="chip"
          aria-pressed={filter.maxMinutes === 30}
          onClick={() =>
            onChange({
              ...filter,
              maxMinutes: filter.maxMinutes === 30 ? null : 30,
            })
          }
        >
          Under 30 min
        </button>
      </div>
    </div>
  )
}

function RecipeList({
  recipes,
  onRemove,
}: {
  recipes: SavedRecipe[]
  onRemove: (r: SavedRecipe) => void
}) {
  if (!recipes.length) {
    return <p className="muted">No recipes match. Try fewer filters.</p>
  }
  return (
    <ul className="recipes" aria-label="Your recipes">
      {recipes.map((r) => (
        <li key={r.id}>
          <Link to={`/recipe/${r.id}`}>{r.title}</Link>
          <span className="muted small">
            {sourceLabel(r.sourceName, r.sourceUrl, r.sourceNote)}
            {r.totalMinutes ? ` · ${r.totalMinutes} min` : ''}
          </span>
          <DietChips diets={r.diets} />
          <button
            type="button"
            className="remove"
            aria-label={`Remove ${r.title}`}
            onClick={() => onRemove(r)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  )
}
