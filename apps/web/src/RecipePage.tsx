import { Fragment, useEffect, useState } from 'react'
import { DietChips } from './Library.tsx'
import { dietLabels, sourceLabel } from './library.ts'
import { navigate } from './navigation.ts'
import { Link } from './router.tsx'
import { ingredientLines, type RecipeDetail } from './sous.ts'

export interface RecipePageApi {
  recipe(id: string): Promise<RecipeDetail | null>
  remove(recipeId: string): Promise<void>
}

function minutes(m: number | null): string | null {
  if (!m) return null
  return m < 60
    ? `${m} min`
    : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}

/** One recipe: where it's from, its diet labels, its ingredients (starred
 *  when their brand decides a label) and, for recipes we may store in full,
 *  its steps. For other people's recipes the source's page is the main action. */
export function RecipePage({ id, api }: { id: string; api: RecipePageApi }) {
  const [recipe, setRecipe] = useState<RecipeDetail | null | undefined>(
    undefined,
  )
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    api.recipe(id).then(
      (r) => live && setRecipe(r),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [api, id])

  async function remove(r: RecipeDetail) {
    if (!confirm(`Remove “${r.title}” from your recipes?`)) return
    await api.remove(r.id)
    navigate('/')
  }

  if (failed) {
    return (
      <p className="card error" role="alert">
        We couldn't load this recipe.
      </p>
    )
  }
  if (recipe === undefined) return <p className="card muted">Loading…</p>
  if (recipe === null) {
    return (
      <section className="card">
        <h2>Recipe not found</h2>
        <Link to="/">Back to your recipes</Link>
      </section>
    )
  }

  const { starred } = dietLabels(recipe.diets)
  const facts = [
    sourceLabel(recipe.sourceName, recipe.sourceUrl, recipe.sourceNote),
    minutes(recipe.totalMinutes),
    recipe.servings ? `serves ${recipe.servings}` : null,
  ].filter(Boolean)
  const lines = ingredientLines(recipe.ingredients)
  const headings = lines.map((l, i) =>
    l.section && l.section !== lines[i - 1]?.section ? l.section : null,
  )

  return (
    <article className="card recipe">
      <Link to="/" className="small">
        ← Your recipes
      </Link>
      <h2>{recipe.title}</h2>
      <p className="muted small">{facts.join(' · ')}</p>
      <DietChips diets={recipe.diets} />
      {recipe.sourceUrl && (
        // The author's page is the main action: their instructions live there (policy).
        <a
          className="button"
          href={recipe.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          View full recipe on {sourceLabel(recipe.sourceName, recipe.sourceUrl)}
        </a>
      )}

      <h3>Ingredients</h3>
      <ul className="ingredients">
        {lines.map((line, i) => {
          const options = recipe.ingredients.filter(
            (o) => o.lineNo === line.lineNo,
          )
          const star = options.some((o) => o.name && starred.includes(o.name))
          const heading = headings[i]
          const item = (
            <li key={line.lineNo}>
              {line.rawText}
              {star && (
                <span className="star" aria-label="check the label">
                  {' '}
                  *
                </span>
              )}
              {line.isOptional && (
                <span className="muted small"> (optional)</span>
              )}
            </li>
          )
          return heading ? (
            <Fragment key={line.lineNo}>
              <li className="section">{heading}</li>
              {item}
            </Fragment>
          ) : (
            item
          )
        })}
      </ul>

      {recipe.instructions && recipe.instructions.length > 0 && (
        <>
          <h3>Steps</h3>
          <ol className="steps">
            {recipe.instructions.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </>
      )}

      <div className="actions">
        {recipe.handTyped && (
          <Link to={`/edit/${recipe.id}`} className="button secondary">
            Edit recipe
          </Link>
        )}
        <button
          type="button"
          className="link"
          onClick={() => void remove(recipe)}
        >
          Remove from my recipes
        </button>
      </div>
    </article>
  )
}
