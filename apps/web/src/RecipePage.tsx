import { Fragment, useEffect, useState, type FormEvent } from 'react'
import { DietChips } from './Library.tsx'
import { cleanTag, dietLabels, sourceLabel } from './library.ts'
import { cookPath, navigate } from './navigation.ts'
import { CookedButton } from './Cooked.tsx'
import { FavoriteControl } from './Favorite.tsx'
import type { Frequency } from './variety.ts'
import { recipeInSeason, type Seasons } from './seasons.ts'
import { shortDate, type CookedApi, type CookedSummary } from './cooked.ts'
import {
  dollars,
  isoDate,
  weekOf,
  type AddedCosts,
  type Fit,
  type Scale,
} from './plan.ts'
import { Link } from './router.tsx'
import { ArrowLeft, Leaf } from 'lucide-react'
import { showToast } from './toast.ts'
import { ExternalLink } from './ExternalLink.tsx'
import {
  ingredientLines,
  type IngredientLine,
  type Option,
  type RecipeDetail,
} from './sous.ts'
import { Sheet } from './Shell.tsx'
import { swapText, type Swap, type SwapFit } from './swaps.ts'

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
  /** What adding recipes would add to a week's cost (TYL-30). */
  addedCosts(weekStart: string, recipeIds: string[]): Promise<AddedCosts>
  /** Every cuisine, to correct a recipe's (TYL-56). */
  options(): Promise<{ cuisines: Option[] }>
  /** The user's own cuisines for a recipe; none goes back to the recipe's. */
  setMyCuisines(recipeId: string, slugs: string[]): Promise<void>
  /** Swaps for these ingredients (TYL-77). */
  swapsFor(ingredientIds: string[]): Promise<Swap[]>
  /** The swaps the user chose for a recipe, by the ingredient swapped out. */
  recipeSwaps(recipeId: string): Promise<Record<string, string>>
  setRecipeSwap(
    recipeId: string,
    fromId: string,
    swapId: string | null,
  ): Promise<void>
  /** How the recipe fits the user's diets with swaps, if it can. */
  swapFit(recipeId: string): Promise<SwapFit | null>
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
    <p className="small in-season">
      <Leaf size={16} strokeWidth={2.75} aria-hidden="true" />
      <strong>In season:</strong> {names.slice(0, 4).join(', ')}
    </p>
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
  // What's on hand of it (TYL-149: "You have"), and what it would add to
  // this week's shopping; both optional.
  const [have, setHave] = useState<Set<string> | null>(null)
  // Swaps (TYL-77): those for the recipe's ingredients, the user's choices,
  // how it fits with swaps, and the line whose swaps are open.
  const [swaps, setSwaps] = useState<Swap[]>([])
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [swapFit, setSwapFit] = useState<SwapFit | null>(null)
  const [swapping, setSwapping] = useState<IngredientLine | null>(null)
  const [adds, setAdds] = useState<{
    cents: number
    estimated: boolean
  } | null>(null)

  useEffect(() => {
    let live = true
    api.onHandIn(id).then(
      (items) => live && setHave(new Set(items.map((i) => i.ingredientId))),
      () => live && setHave(new Set()),
    )
    api.addedCosts(weekOf(), [id]).then(
      (a) => {
        const r = a.recipes[id]
        if (live && r && !r.unpriced)
          setAdds({ cents: r.cents, estimated: r.estimated })
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [api, id])

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

  // Swaps for the recipe's ingredients, and the user's; the page works
  // without them.
  const ingredientKey = (recipe?.ingredients ?? [])
    .flatMap((l) => (l.ingredientId ? [l.ingredientId] : []))
    .join(',')
  useEffect(() => {
    let live = true
    if (ingredientKey) {
      api.swapsFor([...new Set(ingredientKey.split(','))]).then(
        (s) => live && setSwaps(s),
        () => {},
      )
      api.recipeSwaps(id).then(
        (c) => live && setChosen(c),
        () => {},
      )
    }
    return () => {
      live = false
    }
  }, [api, id, ingredientKey])
  // Only for a recipe that doesn't fit as it is.
  useEffect(() => {
    let live = true
    if (fit === 'excluded')
      api.swapFit(id).then(
        (f) => live && setSwapFit(f),
        () => {},
      )
    return () => {
      live = false
    }
  }, [api, id, fit])

  // Choose a swap for a line's ingredient, or go back to the recipe's.
  async function chooseSwap(fromId: string, swapId: string | null) {
    const before = chosen
    const next = { ...chosen }
    if (swapId) next[fromId] = swapId
    else delete next[fromId]
    setChosen(next)
    setSwapping(null)
    try {
      await api.setRecipeSwap(id, fromId, swapId)
      showToast(
        swapId
          ? 'Swapped. Your list will buy that instead.'
          : 'Back to the recipe’s.',
      )
    } catch {
      setChosen(before)
      showToast("We couldn't save that swap. Try again.")
    }
  }

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

  // Add the recipe to this week, and say how it went.
  async function plan() {
    setPlanned('adding')
    try {
      await api.addToPlan(weekOf(), id, 1)
      setPlanned('added')
      showToast('Added to this week. Review it for the list.')
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

  // "To buy" and "You have" (TYL-149): a line is had when every option of
  // it is on hand; lines Sous couldn't match stay to buy.
  const isHad = (lineNo: number) => {
    const ids = recipe.ingredients
      .filter((o) => o.lineNo === lineNo)
      .map((o) => o.ingredientId)
    return !!have && ids.length > 0 && ids.every((x) => x && have.has(x))
  }
  const toBuy = lines.filter((l) => !isHad(l.lineNo))
  const had = lines.filter((l) => isHad(l.lineNo))
  // One line, with its section heading when it starts one.
  const lineItem = (
    line: (typeof lines)[number],
    i: number,
    list: typeof lines,
  ) => {
    const options = recipe.ingredients.filter((o) => o.lineNo === line.lineNo)
    const star = options.some((o) => o.name && starred.includes(o.name))
    const heading =
      line.section && line.section !== list[i - 1]?.section
        ? line.section
        : null
    const haveIt = isHad(line.lineNo)
    const fromId = line.ingredientId ?? null
    const swapOptions = fromId ? swaps.filter((s) => s.fromId === fromId) : []
    const swap = fromId ? swaps.find((s) => s.id === chosen[fromId]) : undefined
    // A swap would make the recipe fit, and none that does is chosen yet.
    const toFit =
      !!fromId &&
      !!swapFit?.fixes[fromId] &&
      !swapFit.fixes[fromId].includes(chosen[fromId] ?? '')
    const item = (
      <li key={line.lineNo} className={haveIt ? 'have' : undefined}>
        <span className="dot" aria-hidden="true" />
        <span className="line-text">
          {swap ? (
            <>
              <s>{line.rawText}</s> → {swapText(line, swap)}{' '}
              <span className="muted small">(your swap)</span>
            </>
          ) : (
            line.rawText
          )}
          {toFit && <span className="tag swap-to-fit">swap to fit</span>}
          {star && (
            <span className="star" aria-label="check the label">
              {' '}
              *
            </span>
          )}
          {line.isOptional && <span className="muted small"> (optional)</span>}
        </span>
        {haveIt && <span className="small muted">have it</span>}
        {swapOptions.length > 0 && (
          <button
            type="button"
            className="link small"
            aria-label={`Swap ${line.name ?? line.rawText}`}
            onClick={() => setSwapping(line)}
          >
            {swap ? 'Change' : 'Swap'}
          </button>
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
  }
  const source = sourceLabel(recipe.sourceName, recipe.sourceUrl)
  // Lines that need a swap to fit, with no fitting swap chosen yet.
  const unfixed = Object.entries(swapFit?.fixes ?? {}).filter(
    ([from, ids]) => !ids.includes(chosen[from] ?? ''),
  ).length

  return (
    <article className="recipe">
      <div className="recipe-top">
        <Link to="/recipes" className="back">
          <ArrowLeft size={18} strokeWidth={2.75} aria-hidden="true" />
          Your recipes
        </Link>
        <FavoriteControl
          title={recipe.title}
          favorite={recipe.favorite}
          onChange={async (frequency) => {
            await api.setFavorite(recipe.id, frequency)
            setRecipe({ ...recipe, favorite: frequency })
          }}
        />
      </div>
      <h2 className="recipe-name">{recipe.title}</h2>
      <p className="muted recipe-facts">{facts.join(' · ')}</p>
      {history?.note && (
        <p className="note-card cooked-note-shown">
          Your note from {shortDate(history.note.on)}: {history.note.text}
        </p>
      )}
      <InSeason
        seasons={seasons}
        recipe={recipe}
        month={Number(today.slice(5, 7))}
      />
      {history && history.times > 0 && (
        <p className="small muted">
          Cooked {history.times === 1 ? 'once' : `${history.times} times`}
          {history.lastOn && `, last on ${shortDate(history.lastOn)}`}.
        </p>
      )}
      <div className="recipe-chips">
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
      </div>
      {recipe.sourceUrl && !recipe.license && (
        // The author's page is the main action: their instructions live there (policy).
        <>
          <ExternalLink className="button view-full" href={recipe.sourceUrl}>
            View full recipe on {source}
          </ExternalLink>
          <p className="small muted">
            The steps live on the author's page. Sous keeps the ingredients so
            it can plan and price them.
          </p>
        </>
      )}

      <div className="recipe-buttons">
        <Link to={cookPath(recipe.id)} className="button secondary">
          Cook
        </Link>
        <CookedButton
          api={api}
          recipeId={recipe.id}
          title={recipe.title}
          cookedOn={today}
          onChange={() => setVersion((v) => v + 1)}
        />
        {recipe.handTyped && (
          <Link to={`/edit/${recipe.id}`} className="button secondary">
            Edit recipe
          </Link>
        )}
      </div>

      <h3 className="split-title">
        {had.length ? `To buy (${toBuy.length})` : 'Ingredients'}
        {adds && (
          <span>
            {' '}
            · {adds.estimated ? '~' : ''}
            {dollars(adds.cents)}
          </span>
        )}
      </h3>
      <ul className="ingredients split">
        {toBuy.map((l, i) => lineItem(l, i, toBuy))}
      </ul>
      {had.length > 0 && (
        <>
          <h3 className="split-title">You have ({had.length})</h3>
          <ul className="ingredients split">
            {had.map((l, i) => lineItem(l, i, had))}
          </ul>
        </>
      )}

      {recipe.instructions && recipe.instructions.length > 0 && (
        <>
          <h3 className="split-title">Steps</h3>
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

      {fit === 'excluded' && planned !== 'added' && (
        <p className="small warning" role="note">
          {swapFit
            ? unfixed === 0
              ? 'Fits your diets and allergies with your swaps.'
              : `Fits your diets and allergies with ${swapFit.count} swap${swapFit.count === 1 ? '' : 's'}: tap Swap on the marked ${swapFit.count === 1 ? 'line' : 'lines'}.`
            : "This recipe doesn't fit your diets or allergies."}
        </p>
      )}
      {swapping?.ingredientId && (
        <SwapSheet
          line={swapping}
          swaps={swaps.filter((s) => s.fromId === swapping.ingredientId)}
          chosen={chosen[swapping.ingredientId] ?? null}
          fixes={swapFit?.fixes[swapping.ingredientId] ?? []}
          have={have}
          onChoose={(swapId) => void chooseSwap(swapping.ingredientId!, swapId)}
          onClose={() => setSwapping(null)}
        />
      )}
      {planned === 'error' && (
        <p role="alert" className="error">
          We couldn't add it to your plan. Try again.
        </p>
      )}
      {saveFailed && (
        <p role="alert" className="error">
          We couldn't save it. Try again.
        </p>
      )}

      {/* The sticky bar (TYL-149): save, and add to this week. */}
      <div className="sticky-bar">
        {recipe.saved ? (
          <button
            type="button"
            className="secondary"
            aria-label="Remove from my recipes"
            onClick={() => void remove(recipe)}
          >
            Saved
          </button>
        ) : (
          <button
            type="button"
            className="secondary"
            onClick={() => void save(recipe)}
          >
            Save
          </button>
        )}
        {planned === 'added' ? (
          <Link to="/plan" className="button in-week" label="See the plan">
            In this week · see the plan
          </Link>
        ) : (
          <button
            type="button"
            disabled={planned === 'adding'}
            onClick={() => void plan()}
          >
            {planned === 'adding'
              ? 'Adding…'
              : fit === 'excluded' && !(swapFit && unfixed === 0)
                ? "Add to this week's plan anyway"
                : "Add to this week's plan"}
          </button>
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

/** The swaps for one line (TYL-77): best first, with those that make the
 *  recipe fit the user's diets, and those they have, marked. Choosing one
 *  saves it for this recipe; "Keep the recipe's" goes back. */
function SwapSheet({
  line,
  swaps,
  chosen,
  fixes,
  have,
  onChoose,
  onClose,
}: {
  line: IngredientLine
  swaps: Swap[]
  chosen: string | null
  fixes: string[]
  have: Set<string> | null
  onChoose: (swapId: string | null) => void
  onClose: () => void
}) {
  const rank = (s: Swap) =>
    (fixes.length && !fixes.includes(s.id) ? 4 : 0) +
    (have?.has(s.toId) ? 0 : 2) +
    (s.quality === 'good' ? 0 : 1)
  const sorted = [...swaps].sort((a, b) => rank(a) - rank(b))
  return (
    <Sheet title={`Swap ${line.name ?? 'this'}`} onClose={onClose}>
      <p className="small muted">{line.rawText}</p>
      <ul className="swap-options">
        {sorted.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className="swap-option"
              aria-pressed={chosen === s.id}
              onClick={() => onChoose(s.id)}
            >
              <span className="swap-name">{swapText(line, s)}</span>
              <span className="tags">
                {fixes.includes(s.id) && (
                  <span className="tag fit">Fits your diet</span>
                )}
                {have?.has(s.toId) && <span className="tag">You have it</span>}
                <span className="tag">
                  {s.quality === 'good' ? 'Works well' : 'In a pinch'}
                </span>
                {s.uses !== 'any' && <span className="tag">For {s.uses}</span>}
              </span>
              <span className="small muted">{s.note}</span>
            </button>
          </li>
        ))}
      </ul>
      {chosen && (
        <button
          type="button"
          className="secondary"
          onClick={() => onChoose(null)}
        >
          Keep the recipe’s
        </button>
      )}
    </Sheet>
  )
}
