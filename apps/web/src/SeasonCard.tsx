import { useEffect, useState } from 'react'
import type { SavedRecipe } from './library.ts'
import { Link } from './router.tsx'
import { inSeasonNow, type Seasons } from './seasons.ts'

export interface SeasonApi {
  /** What's in season where the user lives (TYL-70). */
  seasons(): Promise<Seasons>
  /** The user's saved recipes, to say which use what's in season. */
  list(): Promise<SavedRecipe[]>
}

/** "In season now" (TYL-70): produce in season this month where the user
 *  lives, the ones their saved recipes use first, each with a recipe or two.
 *  Nothing shows if seasons can't load. */
export function SeasonCard({ api, now }: { api: SeasonApi; now: Date }) {
  const [items, setItems] = useState<
    { name: string; recipes: SavedRecipe[] }[] | null
  >(null)

  useEffect(() => {
    let live = true
    Promise.all([api.seasons(), api.list().catch(() => [])]).then(
      ([seasons, recipes]) => {
        if (!live) return
        const month = now.getMonth() + 1
        setItems(
          inSeasonNow(seasons, month)
            .map((s) => ({
              name: s.name,
              recipes: recipes.filter((r) =>
                (r.ingredientIds ?? []).includes(s.ingredientId),
              ),
            }))
            .sort((a, b) => b.recipes.length - a.recipes.length)
            .slice(0, 6),
        )
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [api, now])

  if (!items?.length) return null
  return (
    <section aria-labelledby="in-season">
      <h3 id="in-season">In season now</h3>
      <ul className="season-list">
        {items.map((i) => (
          <li key={i.name}>
            <span className="season-name">{i.name}</span>
            {i.recipes.length > 0 && (
              <span className="small">
                {' · '}
                {i.recipes.slice(0, 2).map((r, n) => (
                  <span key={r.id}>
                    {n > 0 && ', '}
                    <Link to={`/recipe/${r.id}`}>{r.title}</Link>
                  </span>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
