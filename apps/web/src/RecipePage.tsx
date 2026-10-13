import { Fragment, useEffect, useState } from 'react'
import { DietChips } from './Library.tsx'
import { dietLabels, sourceLabel } from './library.ts'
import { navigate } from './navigation.ts'
import { weekOf, type Fit, type Scale } from './plan.ts'
import { Link } from './router.tsx'
import { ExternalLink } from './ExternalLink.tsx'
import { ingredientLines, type RecipeDetail } from './sous.ts'

export interface RecipePageApi {
  recipe(id: string): Promise<RecipeDetail | null>
  remove(recipeId: string): Promise<void>
  saveToLibrary(recipeId: string): Promise<void>
  addToPlan(
    weekStart: string,
    recipeId: string,
    scale?: Scale,
    day?: string | null,
  ): Promise<void>
  recipeFits(ids: string[]): Promise<Record<string, Fit>>
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
  const [fit, setFit] = useState<Fit | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const [planned, setPlanned] = useState<'idle' | 'adding' | 'added' | 'error'>(
    'idle',
  )

  useEffect(() => {
    let live = true
    api.recipe(id).then(
      (r) => live && setRecipe(r),
      () => live && setFailed(true),
    )
    // Without an answer, let the plan's own rules decide.
    api.recipeFits([id]).then(
      (f) => live && setFit(f[id] ?? null),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api, id])

  async function plan() {
    setPlanned('adding')
    try {
      await api.addToPlan(weekOf(), id, 1)
      setPlanned('added')
    } catch {
      setPlanned('error')
    }
  }

  async function remove(r: RecipeDetail) {
    if (!confirm(`Remove “${r.title}” from your recipes?`)) return
    await api.remove(r.id)
    navigate('/')
  }

  async function save(r: RecipeDetail) {
    try {
      await api.saveToLibrary(r.id)
      setRecipe({ ...r, saved: true })
    } catch {
      setSaveFailed(true)
    }
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
      {recipe.sourceUrl && !recipe.license && (
        // The author's page is the main action: their instructions live there (policy).
        <ExternalLink className="button" href={recipe.sourceUrl}>
          View full recipe on {sourceLabel(recipe.sourceName, recipe.sourceUrl)}
        </ExternalLink>
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

      {recipe.license && recipe.sourceUrl && (
        // Openly licensed: credit the source and license, as the license asks.
        <p className="muted small attribution">
          From the{' '}
          <ExternalLink href={recipe.sourceUrl}>
            {recipe.sourceName ?? sourceLabel(null, recipe.sourceUrl)}
          </ExternalLink>
          {recipe.license.attribution && `, by ${recipe.license.attribution}`},
          under{' '}
          {recipe.license.url ? (
            <ExternalLink href={recipe.license.url}>
              {recipe.license.name}
            </ExternalLink>
          ) : (
            recipe.license.name
          )}
          . Sous reformatted the ingredients and steps; this version is shared
          under the same license.
        </p>
      )}

      <div className="actions">
        {fit === 'excluded' ? (
          <p className="muted small">
            This recipe doesn't fit your diets or allergies, so it can't go in
            your plan.
          </p>
        ) : planned === 'added' ? (
          <p role="status">
            Added to this week's plan. <Link to="/plan">See the plan</Link>
          </p>
        ) : (
          <button
            type="button"
            disabled={planned === 'adding'}
            onClick={() => void plan()}
          >
            {planned === 'adding' ? 'Adding…' : "Add to this week's plan"}
          </button>
        )}
        {planned === 'error' && (
          <p role="alert" className="error">
            We couldn't add it to your plan. Try again.
          </p>
        )}
        {recipe.handTyped && (
          <Link to={`/edit/${recipe.id}`} className="button secondary">
            Edit recipe
          </Link>
        )}
        {recipe.saved ? (
          <button
            type="button"
            className="link"
            onClick={() => void remove(recipe)}
          >
            Remove from my recipes
          </button>
        ) : (
          <button
            type="button"
            className="link"
            onClick={() => void save(recipe)}
          >
            Save to my recipes
          </button>
        )}
        {saveFailed && (
          <p role="alert" className="error">
            We couldn't save it. Try again.
          </p>
        )}
      </div>
    </article>
  )
}
