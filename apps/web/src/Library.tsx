import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from 'react'
import { bookmarklet } from './bookmarklet.ts'
import {
  dietLabels,
  allTags,
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
import { ingredientsFromText, titleFromUrl } from './paste.ts'
import { recipeInSeason, type Seasons } from './seasons.ts'
import { Link } from './router.tsx'
import { ExternalLink } from './ExternalLink.tsx'
import type { Shared } from './share.ts'
import { QuickAdd, type QuickAddApi } from './QuickAdd.tsx'

/** What the screen needs from the API and database; tests pass fakes. */
export interface LibraryApi extends QuickAddApi {
  list(): Promise<SavedRecipe[]>
  save(url: string): Promise<ImportResult>
  savePage(page: PageData): Promise<ImportResult>
  saveText(recipe: {
    url: string
    title: string
    ingredients: string[]
  }): Promise<ImportResult>
  remove(recipeId: string): Promise<void>
  /** What's in season where the user lives (TYL-70). */
  seasons(): Promise<Seasons>
}

type Status =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved'; result: ImportResult }
  | { state: 'error'; message: string; code: string }

/** The user's recipes: save one by link, page or pasted text, then search
 *  and filter what they've saved. */
export function Library({
  api,
  shared,
  sharedPage,
  myDiets = [],
  onboarded = true,
}: {
  api: LibraryApi
  /** A link (and maybe copied ingredients) shared to Sous. */
  shared?: Shared | null
  /** A page sent by the Save to Sous bookmarklet, waiting for the user's OK. */
  sharedPage?: PageData | null
  /** The user's own diets, for the "Fits my diets" filter. */
  myDiets?: string[]
  /** False until the user has set preferences; shows a prompt. */
  onboarded?: boolean
}) {
  const [filter, setFilter] = useState<RecipeFilter>(NO_FILTER)
  const sharedUrl = shared && !shared.ingredients ? shared.url : null
  const [url, setUrl] = useState(sharedUrl ?? '')
  // A site that blocks Sous, or a shared text selection: the user pastes or
  // has shared the ingredients, and Sous saves them with the link.
  const [paste, setPaste] = useState<PasteState | null>(
    shared?.ingredients
      ? { url: shared.url, text: shared.ingredients, reason: 'shared' }
      : null,
  )
  const [page, setPage] = useState(sharedPage ?? null)
  const [status, setStatus] = useState<Status>({ state: 'idle' })
  const [recipes, setRecipes] = useState<SavedRecipe[] | null>(null)
  const [listError, setListError] = useState(false)
  // Saved recipes whose produce is in season this month (TYL-70); null until
  // known, or when seasons can't load (the filter just doesn't show).
  const [inSeason, setInSeason] = useState<Set<string> | null>(null)

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

  // Which saved recipes are in season this month; optional, so it fails quietly.
  useEffect(() => {
    if (!recipes?.length) return
    let live = true
    const month = new Date().getMonth() + 1
    api.seasons().then(
      (seasons) =>
        live &&
        setInSeason(
          new Set(
            recipes
              .filter(
                (r) =>
                  recipeInSeason(seasons, r.ingredientIds ?? [], month).length >
                  0,
              )
              .map((r) => r.id),
          ),
        ),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api, recipes])

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

  // Save a recipe from its link. When the site turns Sous away, or the import
  // fails on our side, offer to save it from pasted ingredients instead.
  async function save(link: string) {
    const target = link.trim()
    if (!target) return
    const full = target.includes('://') ? target : `https://${target}`
    setPaste(null)
    try {
      setStatus({ state: 'saving' })
      setStatus({ state: 'saved', result: await api.save(full) })
      setUrl('')
      refresh()
    } catch (e) {
      const code = e instanceof ImportError ? e.code : 'error'
      // A failure on our side (TYL-99) gets the same way out: only an
      // ImportError the API answered with, not a network or other error.
      const ours = e instanceof ImportError && code === 'error'
      if (code === 'blocked' || code === 'robots_disallowed' || ours) {
        // Not a dead end: offer to save it from what the user can copy.
        setStatus({ state: 'idle' })
        setPaste({
          url: full,
          text: '',
          reason:
            code === 'blocked' || code === 'robots_disallowed'
              ? code
              : 'failed',
        })
        return
      }
      setStatus({ state: 'error', message: (e as Error).message, code })
    }
  }

  async function saveText(p: PasteState, title: string, lines: string[]) {
    const ok = await run(() =>
      api.saveText({ url: p.url, title, ingredients: lines }),
    )
    if (ok) {
      setPaste(null)
      setUrl('')
    }
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
            Your diets, allergies, favorite cuisines and store shape what Sous
            shows you.
          </p>
          <Link to="/welcome" className="button">
            Set up Sous
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
          Or type in a recipe, or read one from cookbook photos
        </Link>
      </form>

      {paste && (
        <PasteRecipe
          key={paste.url}
          paste={paste}
          saving={status.state === 'saving'}
          onSave={(title, lines) => void saveText(paste, title, lines)}
          onDismiss={() => setPaste(null)}
        />
      )}

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
          </p>
        )}
        {status.state === 'saved' && <Saved result={status.result} />}
      </div>

      <BrowserImportHelp />

      <section className="card">
        <h2>Your recipes</h2>
        <Link to="/browse" className="small">
          Find more recipes
        </Link>
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
          <Filters
            filter={filter}
            onChange={setFilter}
            myDiets={myDiets}
            tags={allTags(recipes)}
            inSeason={inSeason}
          />
        )}
        {!!recipes?.length && (
          <RecipeList
            api={api}
            recipes={filterRecipes(recipes, filter, inSeason)}
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
      <ExternalLink className="button" href={result.source_url}>
        View full recipe on {source}
      </ExternalLink>
      {result.visibility === 'private' && (
        <p className="muted small">Only you can see this recipe.</p>
      )}
    </section>
  )
}

interface PasteState {
  url: string
  /** Text to start from: a shared selection, or empty. */
  text: string
  /** Why we're asking: the site blocks Sous, saving from the link failed
   *  on our side, or the user shared text. */
  reason: 'blocked' | 'robots_disallowed' | 'failed' | 'shared'
}

/** Save a recipe from what the user copied off the page. Only the
 *  ingredients are kept; the steps stay on the author's page (policy). */
function PasteRecipe({
  paste,
  saving,
  onSave,
  onDismiss,
}: {
  paste: PasteState
  saving: boolean
  onSave: (title: string, lines: string[]) => void
  onDismiss: () => void
}) {
  const site = sourceLabel(null, paste.url)
  const [title, setTitle] = useState(() => titleFromUrl(paste.url))
  const [text, setText] = useState(() =>
    ingredientsFromText(paste.text).join('\n'),
  )
  const lines = ingredientsFromText(text)
  // "For the sauce:" starts a section; it isn't an ingredient.
  const count = lines.filter((l) => !l.endsWith(':')).length
  const card = useRef<HTMLFormElement>(null)

  // On a phone the card appears below the fold: bring it into view.
  useEffect(() => {
    card.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [])

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    // Pasting a whole page into the empty box keeps just the ingredients.
    if (text.trim()) return
    const pasted = e.clipboardData.getData('text')
    if (!pasted) return
    e.preventDefault()
    setText(ingredientsFromText(pasted).join('\n'))
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (title.trim()) onSave(title.trim(), lines)
  }

  return (
    <form className="card paste" onSubmit={submit} ref={card}>
      <h2>
        {paste.reason === 'shared'
          ? 'Save the ingredients you shared?'
          : paste.reason === 'failed'
            ? `We couldn't save that recipe from ${site}`
            : `${site} doesn't let apps read its recipes`}
      </h2>
      {paste.reason === 'failed' && (
        <p>Something went wrong on our side, and it's been reported.</p>
      )}
      {paste.reason !== 'shared' && (
        <p>
          You can still save it: copy the ingredients from the page and paste
          them here. Pasting the whole page works too.
        </p>
      )}
      <ExternalLink className="small" href={paste.url}>
        Open the recipe on {site}
      </ExternalLink>
      <label htmlFor="paste-title">Name</label>
      <input
        id="paste-title"
        required
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label htmlFor="paste-ingredients">Ingredients</label>
      <textarea
        id="paste-ingredients"
        rows={8}
        placeholder="Paste the ingredient list here"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
      />
      <p className="muted small" aria-live="polite">
        {count ? `${count} ingredient${count === 1 ? '' : 's'}. ` : ''}
        Only the ingredients are saved; the steps stay on {site}. Only you can
        see this recipe.
      </p>
      <button type="submit" disabled={saving || !title.trim()}>
        {saving
          ? 'Saving…'
          : lines.length
            ? 'Save to my recipes'
            : 'Save the link for now'}
      </button>
      <button type="button" className="link" onClick={onDismiss}>
        Not now
      </button>
    </form>
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

/** On a computer, the Save to Sous bookmark sends a blocked site's recipe
 *  from the page itself. Phones use copy and paste (PasteRecipe) instead. */
function BrowserImportHelp() {
  const code = bookmarklet(window.location.origin)
  const link = useRef<HTMLAnchorElement>(null)

  // React refuses javascript: URLs in JSX, so set the bookmarklet by hand.
  useEffect(() => {
    link.current?.setAttribute('href', code)
  }, [code])

  return (
    <details className="card help">
      <summary>On a computer? Add the Save to Sous bookmark</summary>
      <p>
        For sites that turn Sous away, drag this to your bookmarks bar, then
        click it on a recipe page:{' '}
        <a
          ref={link}
          className="bookmarklet"
          onClick={(e) => e.preventDefault()}
        >
          Save to Sous
        </a>
      </p>
      <p className="muted small">
        It sends the recipe from the page you're looking at. Nothing is saved
        until you tap Save in Sous.
      </p>
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

/** Search and filter chips for the user's recipes: their diets, common
 *  diets, quick recipes, and each of their own tags. */
function Filters({
  filter,
  onChange,
  myDiets,
  tags,
  inSeason,
}: {
  filter: RecipeFilter
  onChange: (f: RecipeFilter) => void
  myDiets: string[]
  /** The user's own tags across their recipes, offered as filters. */
  tags: string[]
  /** Saved recipes in season this month; the chip shows when there are some. */
  inSeason: Set<string> | null
}) {
  // Tags compare without case, as filterRecipes does: a "weeknight" chip
  // clears a "Weeknight" filter left from a recipe since removed.
  const hasTag = (tag: string) =>
    filter.tags.some((t) => t.toLowerCase() === tag.toLowerCase())
  // Select a tag's filter, or clear it (whatever its case) when selected.
  const toggleTag = (tag: string) =>
    onChange({
      ...filter,
      tags: hasTag(tag)
        ? filter.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase())
        : [...filter.tags, tag],
    })
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
        <button
          type="button"
          className="chip"
          aria-pressed={filter.favorites}
          onClick={() => onChange({ ...filter, favorites: !filter.favorites })}
        >
          ♥ Favorites
        </button>
        {inSeason && inSeason.size > 0 && (
          <button
            type="button"
            className="chip"
            aria-pressed={!!filter.inSeason}
            onClick={() =>
              onChange({
                ...filter,
                inSeason: !filter.inSeason,
              })
            }
          >
            In season
          </button>
        )}
        {tags.map((t) => (
          <button
            key={`tag-${t}`}
            type="button"
            className="chip"
            aria-pressed={hasTag(t)}
            onClick={() => toggleTag(t)}
          >
            #{t}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The filtered recipes, each with its source, time, labels and tags, and a
 *  buttons to plan it this week or remove it. */
function RecipeList({
  api,
  recipes,
  onRemove,
}: {
  api: QuickAddApi
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
          {r.favorite && (
            <span className="heart-mark" aria-label="a favorite">
              {' '}
              ♥
            </span>
          )}
          <span className="muted small">
            {sourceLabel(r.sourceName, r.sourceUrl, r.sourceNote)}
            {r.totalMinutes ? ` · ${r.totalMinutes} min` : ''}
          </span>
          <DietChips diets={r.diets} />
          {r.tags.length > 0 && (
            <span className="diets" aria-label="Your tags">
              {r.tags.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </span>
          )}
          <QuickAdd api={api} recipeId={r.id} title={r.title} />
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
