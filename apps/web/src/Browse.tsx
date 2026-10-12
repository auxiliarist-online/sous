import { useEffect, useState } from 'react'
import type { Fit } from './plan.ts'
import { Link } from './router.tsx'
import type { CatalogRecipe } from './sous.ts'

export interface BrowseApi {
  searchCatalog(query: string): Promise<CatalogRecipe[]>
  recipeFits(ids: string[]): Promise<Record<string, Fit>>
}

/** Find recipes in the shared catalog (openly licensed and federal sources),
 *  leaving out any that break the user's diets or allergies. */
export function Browse({ api }: { api: BrowseApi }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CatalogRecipe[] | null>(null)
  const [fits, setFits] = useState<Record<string, Fit>>({})
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      api
        .searchCatalog(query)
        .then(async (found) => {
          const f = await api.recipeFits(found.map((r) => r.id))
          if (!live) return
          setFits(f)
          setResults(found)
          setFailed(false)
        })
        .catch(() => live && setFailed(true))
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, query])

  const shown = (results ?? []).filter((r) => fits[r.id] !== 'excluded')
  const hidden = (results?.length ?? 0) - shown.length

  return (
    <section className="card">
      <h2>Find recipes</h2>
      <p className="muted small">
        Recipes everyone can use, with their steps: the Wikibooks Cookbook and
        other open sources. Save one to plan it, or add it to this week from its
        page.
      </p>
      <label htmlFor="catalog-search" className="visually-hidden">
        Search recipes
      </label>
      <input
        id="catalog-search"
        type="search"
        placeholder="Search: dal, chili, banana bread…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {failed && (
        <p className="error" role="alert">
          We couldn't search recipes right now.
        </p>
      )}
      {results === null && !failed && <p className="muted">Loading…</p>}
      {results && (
        <ul className="recipes" aria-label="Recipes found">
          {shown.map((r) => (
            <li key={r.id}>
              <Link to={`/recipe/${r.id}`}>{r.title}</Link>
              <span className="small muted">
                {[r.sourceName, r.totalMinutes ? `${r.totalMinutes} min` : null]
                  .filter(Boolean)
                  .join(' · ')}
                {fits[r.id] === 'check_label' && (
                  <span
                    className="star"
                    aria-label="fits if you check the label"
                  >
                    {' '}
                    *
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {results && shown.length === 0 && (
        <p className="muted small">
          {query.trim() ? `Nothing matches “${query}”.` : 'No recipes yet.'}
        </p>
      )}
      {hidden > 0 && (
        <p className="muted small">
          {hidden} recipe{hidden === 1 ? '' : 's'} left out because{' '}
          {hidden === 1 ? "it doesn't" : "they don't"} fit your diets or
          allergies.
        </p>
      )}
    </section>
  )
}
