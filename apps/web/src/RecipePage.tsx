import { Fragment, useEffect, useState, type FormEvent } from 'react'
import { DietChips } from './Library.tsx'
import { cleanTag, dietLabels, sourceLabel } from './library.ts'
import { cookPath, navigate } from './navigation.ts'
import { CookedButton } from './Cooked.tsx'
import { FavoriteControl } from './Favorite.tsx'
import type { Frequency } from './variety.ts'
import { recipeInSeason, type Seasons } from './seasons.ts'
import { shortDate, type CookedApi, type CookedSummary } from './cooked.ts'
import { isoDate, weekOf, type Fit, type Scale } from './plan.ts'
import { Link } from './router.tsx'
import { ExternalLink } from './ExternalLink.tsx'
import { ingredientLines, type Option, type RecipeDetail } from './sous.ts'

export interface RecipePageApi extends CookedApi {
  /** How often the user cooked it, when last, and their latest note (TYL-68). */
  cookedSummary(recipeId: string): Promise<CookedSummary>
  /** What's in season where the user lives (TYL-70). */
  seasons(): Promise<Seasons>
  /** Make it a favorite with how often it comes back, or (null) stop. */
  setFavorite(recipeId: string, frequency: Frequency | null): Promise<void>
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
  /** Replace the user's tags on a recipe they've saved (TYL-81). */
  setTags(recipeId: string, tags: string[]): Promise<void>
  /** Every cuisine, to correct a recipe's (TYL-56). */
  options(): Promise<{ cuisines: Option[] }>
  /** The user's own cuisines for a recipe; none goes back to the recipe's. */
  setMyCuisines(recipeId: string, slugs: string[]): Promise<void>
}

/** "In season: tomatoes, basil" when the recipe's seasonal produce is mostly
 *  in season this month (TYL-70). */
function InSeason({
  seasons,
  recipe,
  month,
}: {
  seasons: Seasons | null
  recipe: RecipeDetail
  month: number
}) {
  if (!seasons) return null
  const names = recipeInSeason(
    seasons,
    recipe.ingredients
      .filter((i) => i.optionNo === 1)
      .map((i) => i.ingredientId),
    month,
  )
  if (names.length === 0) return null
  return (
    <p className="small in-season">In season: {names.slice(0, 4).join(', ')}</p>
  )
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
  const [history, setHistory] = useState<CookedSummary | null>(null)
  const [seasons, setSeasons] = useState<Seasons | null>(null)
  // Today, as the page opened: what "Cooked it" dates a meal to.
  const [today] = useState(() => isoDate(new Date()))
  const [version, setVersion] = useState(0)

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

  // What's in season, for the badge; the page works without it.
  useEffect(() => {
    let live = true
    api.seasons().then(
      (s) => live && setSeasons(s),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api])

  // What the user's cooked of it; the page works without it.
  useEffect(() => {
    let live = true
    api.cookedSummary(id).then(
      (h) => live && setHistory(h),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api, id, version])

  async function plan() {
    setPlanned('adding')
    try {
      await api.addToPlan(weekOf(), id, 1)
      setPlanned('added')
    } catch {
      setPlanned('error')
    }
  }

  // Take the recipe out of the user's recipes, after asking.
  async function remove(r: RecipeDetail) {
    if (!confirm(`Remove “${r.title}” from your recipes?`)) return
    await api.remove(r.id)
    navigate('/recipes')
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
        <Link to="/recipes">Back to your recipes</Link>
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
      <Link to="/recipes" className="small">
        ← Your recipes
      </Link>
      <div className="recipe-title">
        <h2>{recipe.title}</h2>
        <FavoriteControl
          title={recipe.title}
          favorite={recipe.favorite}
          onChange={async (frequency) => {
            await api.setFavorite(recipe.id, frequency)
            setRecipe({ ...recipe, favorite: frequency })
          }}
        />
      </div>
      {history?.note && (
        <p className="small cooked-note-shown">
          Your note from {shortDate(history.note.on)}: {history.note.text}
        </p>
      )}
      <p className="muted small">{facts.join(' · ')}</p>
      <InSeason
        seasons={seasons}
        recipe={recipe}
        month={Number(today.slice(5, 7))}
      />
      <p className="small">
        {history && history.times > 0 && (
          <span className="muted">
            Cooked {history.times === 1 ? 'once' : `${history.times} times`}
            {history.lastOn && `, last on ${shortDate(history.lastOn)}`}.{' '}
          </span>
        )}
        <CookedButton
          api={api}
          recipeId={recipe.id}
          title={recipe.title}
          cookedOn={today}
          onChange={() => setVersion((v) => v + 1)}
        />
      </p>
      <DietChips diets={recipe.diets} />
      <CuisineLine
        api={api}
        recipe={recipe}
        // Load it again: going back shows the recipe's own cuisines.
        onChange={() =>
          // A failed reload keeps the picker open with its error.
          api.recipe(recipe.id).then((r) => {
            if (r) setRecipe(r)
          })
        }
      />
      {recipe.saved && (
        <TagEditor
          tags={recipe.tags}
          onChange={async (tags) => {
            await api.setTags(recipe.id, tags)
            setRecipe({ ...recipe, tags })
          }}
        />
      )}
      {recipe.sourceUrl && !recipe.license && (
        // The author's page is the main action: their instructions live there (policy).
        <ExternalLink className="button" href={recipe.sourceUrl}>
          View full recipe on {sourceLabel(recipe.sourceName, recipe.sourceUrl)}
        </ExternalLink>
      )}

      <Link to={cookPath(recipe.id)} className="button secondary">
        Cook
      </Link>

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
        {fit === 'excluded' && planned !== 'added' && (
          <p className="small warning" role="note">
            This recipe doesn't fit your diets or allergies.
          </p>
        )}
        {planned === 'added' ? (
          <p role="status">
            Added to this week's plan. <Link to="/plan">See the plan</Link>
          </p>
        ) : (
          <button
            type="button"
            disabled={planned === 'adding'}
            onClick={() => void plan()}
          >
            {planned === 'adding'
              ? 'Adding…'
              : fit === 'excluded'
                ? "Add to this week's plan anyway"
                : "Add to this week's plan"}
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

/** The recipe's cuisine, and a way to correct it for this user only
 *  (TYL-56): pick any number, or go back to the recipe's own. */
function CuisineLine({
  api,
  recipe,
  onChange,
}: {
  api: RecipePageApi
  recipe: RecipeDetail
  onChange: () => Promise<void> | void
}) {
  const [all, setAll] = useState<Option[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [picked, setPicked] = useState<string[]>(recipe.cuisines)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    api.options().then(
      (o) => live && setAll(o.cuisines),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api])

  const name = (slug: string) => all?.find((c) => c.slug === slug)?.name ?? slug

  // Save the user's own cuisines (none: back to the recipe's).
  async function save(slugs: string[]) {
    setBusy(true)
    setFailed(false)
    try {
      await api.setMyCuisines(recipe.id, slugs)
      await onChange()
      setEditing(false)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (!all) return null
  if (!editing) {
    return (
      <p className="small cuisine-line">
        <span className="muted">Cuisine:</span>{' '}
        {recipe.cuisines.length
          ? recipe.cuisines.map(name).join(', ')
          : 'not known'}
        {recipe.cuisinesCorrected && (
          <span className="muted"> (your choice)</span>
        )}{' '}
        <button
          type="button"
          className="link"
          onClick={() => {
            setPicked(recipe.cuisines)
            setEditing(true)
          }}
        >
          {recipe.cuisines.length ? 'Change' : 'Set'}
        </button>
      </p>
    )
  }
  return (
    <fieldset className="cuisine-picker">
      <legend className="small">
        Cuisine, for you only (it shapes what Sous suggests)
      </legend>
      <div className="chips">
        {all.map((c) => (
          <button
            key={c.slug}
            type="button"
            className="chip"
            aria-pressed={picked.includes(c.slug)}
            onClick={() =>
              setPicked(
                picked.includes(c.slug)
                  ? picked.filter((p) => p !== c.slug)
                  : [...picked, c.slug],
              )
            }
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="actions">
        <button
          type="button"
          disabled={busy || !picked.length}
          onClick={() => void save(picked)}
        >
          Save
        </button>
        {recipe.cuisinesCorrected && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void save([])}
          >
            Use the recipe's
          </button>
        )}
        <button
          type="button"
          className="link"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </div>
      {failed && (
        <p className="error" role="alert">
          We couldn't save that. Try again.
        </p>
      )}
    </fieldset>
  )
}

/** The user's own tags on a saved recipe (TYL-81): remove one with its ×, add
 *  one by typing it. Changes are saved straight away. */
function TagEditor({
  tags,
  onChange,
}: {
  tags: string[]
  onChange: (tags: string[]) => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  // Save the whole new list; true when it saved, so the field can clear.
  async function save(next: string[]) {
    setBusy(true)
    setFailed(false)
    try {
      await onChange(next)
      return true
    } catch {
      setFailed(true)
      return false
    } finally {
      setBusy(false)
    }
  }

  // Add the typed tag, tidied; one already there (ignoring case) is skipped.
  async function add(e: FormEvent) {
    e.preventDefault()
    const tag = cleanTag(draft)
    if (!tag) return
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      setDraft('')
      return
    }
    if (await save([...tags, tag])) setDraft('')
  }

  return (
    <form className="tags" onSubmit={(e) => void add(e)}>
      <ul className="tag-list" aria-label="Your tags">
        {tags.map((t) => (
          <li key={t} className="tag">
            {t}
            <button
              type="button"
              className="link"
              disabled={busy}
              aria-label={`Remove tag ${t}`}
              onClick={() => void save(tags.filter((x) => x !== t))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {tags.length < 20 && (
        <>
          <label htmlFor="new-tag" className="visually-hidden">
            Add a tag
          </label>
          <input
            id="new-tag"
            type="text"
            placeholder="Add a tag, like weeknight"
            maxLength={30}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="submit"
            className="chip"
            disabled={busy || !cleanTag(draft)}
          >
            Add tag
          </button>
        </>
      )}
      {failed && (
        <p role="alert" className="error small">
          We couldn't save your tags. Try again.
        </p>
      )}
    </form>
  )
}
