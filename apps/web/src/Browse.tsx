import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from './router.tsx'
import { browseCache as cache, type BrowseResults } from './browseCache.ts'
import { PAGE_SIZE, type CatalogRecipe } from './sous.ts'
import { QuickAdd, type QuickAddApi } from './QuickAdd.tsx'

export interface BrowseApi extends QuickAddApi {
  searchCatalog(query: string, offset?: number): Promise<CatalogRecipe[]>
}

type Results = BrowseResults

// Where the user had scrolled to in a list, for Back from a recipe.
const SCROLL_KEY = 'sous:browse-scroll'

function queryFromAddress(): string {
  return new URLSearchParams(window.location.search).get('q') ?? ''
}

function savedScroll(query: string): number | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? 'null') as {
      q: string
      y: number
    } | null
    return saved && saved.q === query ? saved.y : null
  } catch {
    return null
  }
}

function saveScroll(query: string) {
  try {
    sessionStorage.setItem(
      SCROLL_KEY,
      JSON.stringify({ q: query, y: window.scrollY }),
    )
  } catch {
    // Storage off: Back still shows the same results, just from the top.
  }
}

/** Find recipes in the shared catalog. The search reads what the user means
 *  ("eggs" finds dishes built on eggs, "quick vegetarian dinner") and ranks
 *  results for them; recipes that break their rules never show. */
export function Browse({ api }: { api: BrowseApi }) {
  const [query, setQuery] = useState(queryFromAddress)
  // Results live in the cache; this only makes the page re-render.
  const [, setVersion] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const restored = useRef(false)
  const key = query.trim()
  const results: Results | null = cache.get(key) ?? null

  // Keep the search in the address, so Back and reload return to it.
  useEffect(() => {
    const url = key ? `/browse?q=${encodeURIComponent(key)}` : '/browse'
    if (url !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', url)
    }
  }, [key])

  useEffect(() => {
    if (cache.has(key)) return
    let live = true
    const timer = setTimeout(() => {
      api.searchCatalog(key, 0).then(
        (items) => {
          cache.set(key, { items, more: items.length === PAGE_SIZE })
          if (!live) return
          setVersion((v) => v + 1)
          setFailed(false)
        },
        () => live && setFailed(true),
      )
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, key])

  // Back from a recipe: return to where the user was in the list.
  useLayoutEffect(() => {
    if (restored.current || !results) return
    restored.current = true
    const y = savedScroll(key)
    if (y !== null) window.scrollTo?.(0, y)
  }, [results, key])

  async function showMore() {
    if (!results) return
    setLoadingMore(true)
    try {
      const next = await api.searchCatalog(key, results.items.length)
      const r = {
        items: [...results.items, ...next],
        more: next.length === PAGE_SIZE,
      }
      cache.set(key, r)
      setVersion((v) => v + 1)
    } catch {
      setFailed(true)
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section className="card">
      <h2>Find recipes</h2>
      <p className="muted small">
        Search by ingredient, dish, cuisine or time: “eggs”, “quick vegetarian
        dinner”, “thai soup”, “dessert”. Recipes that don't fit your diets or
        allergies are left out.
      </p>
      <label htmlFor="catalog-search" className="visually-hidden">
        Search recipes
      </label>
      <input
        id="catalog-search"
        type="search"
        placeholder="What do you feel like?"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {failed && (
        <p className="error" role="alert">
          We couldn't search recipes right now.
        </p>
      )}
      {results === null && !failed && <p className="muted">Loading…</p>}
      {results && results.items.length > 0 && (
        <ul className="recipes found" aria-label="Recipes found">
          {results.items.map((r) => (
            <li key={r.id}>
              <Link to={`/recipe/${r.id}`} onNavigate={() => saveScroll(key)}>
                {r.title}
              </Link>
              <span className="small muted">
                {[
                  r.sourceName,
                  r.totalMinutes ? `${r.totalMinutes} min` : null,
                  ...r.why,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <QuickAdd api={api} recipeId={r.id} title={r.title} />
            </li>
          ))}
        </ul>
      )}
      {results && results.items.length === 0 && (
        <p className="muted small">
          {key
            ? `Nothing that fits your preferences matches “${key}”. Try another ingredient or dish.`
            : 'No recipes yet.'}
        </p>
      )}
      {results?.more && (
        <button
          type="button"
          className="secondary"
          disabled={loadingMore}
          onClick={() => void showMore()}
        >
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </section>
  )
}
