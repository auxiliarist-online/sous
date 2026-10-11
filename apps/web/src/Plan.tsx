import { useEffect, useState } from 'react'
import { filterRecipes, NO_FILTER, type SavedRecipe } from './library.ts'
import {
  addDays,
  dayName,
  dollars,
  scaledLine,
  weekDays,
  weekLabel,
  weekOf,
  type Fit,
  type PlanCost,
  type PlanEntry,
} from './plan.ts'
import { Link } from './router.tsx'
import { ingredientLines, type RecipeDetail } from './sous.ts'

export interface PlanApi {
  list(): Promise<SavedRecipe[]>
  recipe(id: string): Promise<RecipeDetail | null>
  plan(weekStart: string): Promise<PlanEntry[]>
  addToPlan(
    weekStart: string,
    recipeId: string,
    servings: number,
    day?: string | null,
  ): Promise<void>
  updateEntry(
    id: string,
    patch: { servings?: number; day?: string | null },
  ): Promise<void>
  removeEntry(id: string): Promise<void>
  copyPlan(from: string, to: string): Promise<number>
  planCost(weekStart: string): Promise<PlanCost>
  recipeFits(ids: string[]): Promise<Record<string, Fit>>
}

/** The week's meals (TYL-15): what's planned on which day, for how many, and
 *  what it's likely to cost against the budget. */
export function PlanPage({
  api,
  week,
  householdSize,
}: {
  api: PlanApi
  week: string
  householdSize: number
}) {
  const [entries, setEntries] = useState<PlanEntry[] | null>(null)
  const [cost, setCost] = useState<PlanCost | 'error' | null>(null)
  const [failed, setFailed] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [version, setVersion] = useState(0)
  const reload = () => setVersion((v) => v + 1)

  // App keys this page by week, so a new week starts from a clean slate.
  useEffect(() => {
    let live = true
    api.plan(week).then(
      (planned) => {
        if (!live) return
        setEntries(planned)
        setFailed(false)
        // The cost comes from the API; the plan works without it.
        api.planCost(week).then(
          (c) => live && setCost(c),
          () => live && setCost('error'),
        )
      },
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [api, week, version])

  async function change(action: () => Promise<unknown>, failure: string) {
    setBusy(true)
    setMessage(null)
    try {
      await action()
      reload()
    } catch {
      setMessage(failure)
    } finally {
      setBusy(false)
    }
  }

  async function copyLastWeek() {
    setBusy(true)
    setMessage(null)
    try {
      const n = await api.copyPlan(addDays(week, -7), week)
      if (n === 0) setMessage('Nothing was planned last week.')
      reload()
    } catch {
      setMessage("We couldn't copy last week's plan. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const thisWeek = weekOf()
  const days = weekDays(week)

  return (
    <section className="card plan" aria-busy={busy}>
      <nav className="week-nav" aria-label="Weeks">
        <Link to={`/plan/${addDays(week, -7)}`} className="small">
          ← Previous
        </Link>
        <Link to={`/plan/${addDays(week, 7)}`} className="small">
          Next →
        </Link>
      </nav>
      <h2>
        {week === thisWeek ? 'This week' : 'Week of'}{' '}
        <span className="muted">{weekLabel(week)}</span>
      </h2>
      {week !== thisWeek && (
        <Link to="/plan" className="small">
          Back to this week
        </Link>
      )}

      {failed && (
        <p className="error" role="alert">
          We couldn't load your plan.
        </p>
      )}
      {!failed && entries === null && <p className="muted">Loading…</p>}

      {entries && (
        <>
          <Budget cost={cost} empty={entries.length === 0} />

          {entries.length === 0 && (
            <div className="empty">
              <p className="muted">Nothing planned for this week yet.</p>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void copyLastWeek()}
              >
                Copy last week's plan
              </button>
            </div>
          )}

          {[...days, null].map((day) => {
            const planned = entries.filter((e) => e.day === day)
            if (!planned.length) return null
            return (
              <section key={day ?? 'any'} className="plan-day">
                <h3>{day ? dayName(day) : 'Any day this week'}</h3>
                <ul className="plan-entries">
                  {planned.map((e) => (
                    <Entry
                      key={e.id}
                      entry={e}
                      days={days}
                      cents={
                        cost && cost !== 'error' ? cost.entries[e.id] : null
                      }
                      api={api}
                      busy={busy}
                      onChange={(patch) =>
                        void change(
                          () => api.updateEntry(e.id, patch),
                          "We couldn't change that. Try again.",
                        )
                      }
                      onRemove={() =>
                        void change(
                          () => api.removeEntry(e.id),
                          "We couldn't remove that. Try again.",
                        )
                      }
                    />
                  ))}
                </ul>
              </section>
            )
          })}

          {message && (
            <p role="status" className="muted">
              {message}
            </p>
          )}

          <AddRecipe
            api={api}
            busy={busy}
            onAdd={(r) =>
              void change(
                () => api.addToPlan(week, r.id, householdSize),
                `We couldn't add ${r.title}. Try again.`,
              )
            }
          />
        </>
      )}
    </section>
  )
}

function Budget({
  cost,
  empty,
}: {
  cost: PlanCost | 'error' | null
  empty: boolean
}) {
  if (cost === null) {
    return empty ? null : <p className="muted small">Working out the cost…</p>
  }
  if (cost === 'error') {
    return <p className="muted small">We couldn't estimate the cost.</p>
  }
  const approx = cost.estimated ? '~' : ''
  const total = `${approx}${dollars(cost.totalCents)}`
  const over = cost.budgetCents !== null && cost.totalCents > cost.budgetCents
  return (
    <div className="budget">
      {cost.budgetCents !== null ? (
        <>
          <p className={over ? 'over' : undefined}>
            <strong>{total}</strong> of your {dollars(cost.budgetCents)} budget
            {over && ' (over budget)'}
          </p>
          <meter
            min={0}
            max={cost.budgetCents}
            high={cost.budgetCents * 0.9}
            optimum={0}
            value={Math.min(cost.totalCents, cost.budgetCents)}
            aria-label="Spent of budget"
          />
        </>
      ) : (
        <p>
          <strong>{total}</strong> this week.{' '}
          <Link to="/settings" className="small">
            Set a weekly budget
          </Link>
        </p>
      )}
      {(cost.estimated || cost.unpricedLines > 0) && (
        <p className="muted small">
          {cost.estimated && 'Rough prices until store prices are in. '}
          {cost.unpricedLines > 0 &&
            `${cost.unpricedLines} ingredient${cost.unpricedLines === 1 ? '' : 's'} not priced yet.`}
        </p>
      )}
    </div>
  )
}

function Entry({
  entry,
  days,
  cents,
  api,
  busy,
  onChange,
  onRemove,
}: {
  entry: PlanEntry
  days: string[]
  cents: number | null | undefined
  api: PlanApi
  busy: boolean
  onChange: (patch: { servings?: number; day?: string | null }) => void
  onRemove: () => void
}) {
  const [recipe, setRecipe] = useState<RecipeDetail | null | undefined>(
    undefined,
  )
  const factor = entry.recipeServings
    ? entry.servings / entry.recipeServings
    : 1

  function open(isOpen: boolean) {
    if (isOpen && recipe === undefined) {
      api.recipe(entry.recipeId).then(setRecipe, () => setRecipe(null))
    }
  }

  return (
    <li className="plan-entry">
      <div className="entry-head">
        <Link to={`/recipe/${entry.recipeId}`}>{entry.title}</Link>
        {cents != null && cents > 0 && (
          <span className="muted small">~{dollars(cents)}</span>
        )}
      </div>
      <div className="entry-controls">
        <div className="stepper" role="group" aria-label="Servings">
          <button
            type="button"
            aria-label={`Fewer servings of ${entry.title}`}
            disabled={busy || entry.servings <= 1}
            onClick={() => onChange({ servings: entry.servings - 1 })}
          >
            −
          </button>
          <span aria-live="polite">
            {entry.servings} serving{entry.servings === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            aria-label={`More servings of ${entry.title}`}
            disabled={busy || entry.servings >= 50}
            onClick={() => onChange({ servings: entry.servings + 1 })}
          >
            +
          </button>
        </div>
        <label className="visually-hidden" htmlFor={`day-${entry.id}`}>
          Day for {entry.title}
        </label>
        <select
          id={`day-${entry.id}`}
          value={entry.day ?? ''}
          disabled={busy}
          onChange={(e) => onChange({ day: e.target.value || null })}
        >
          <option value="">Any day</option>
          {days.map((d) => (
            <option key={d} value={d}>
              {dayName(d)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="link"
          disabled={busy}
          onClick={onRemove}
          aria-label={`Remove ${entry.title} from the plan`}
        >
          Remove
        </button>
      </div>
      <details onToggle={(e) => open(e.currentTarget.open)}>
        <summary className="small">
          Ingredients
          {factor !== 1 && ` for ${entry.servings}`}
        </summary>
        {recipe === undefined && <p className="muted small">Loading…</p>}
        {recipe === null && (
          <p className="muted small">We couldn't load the ingredients.</p>
        )}
        {recipe && (
          <ul className="ingredients small">
            {ingredientLines(recipe.ingredients).map((l) => (
              <li key={l.lineNo}>
                {scaledLine(l, factor)}
                {l.isOptional && <span className="muted"> (optional)</span>}
              </li>
            ))}
          </ul>
        )}
        {!entry.recipeServings && (
          <p className="muted small">
            This recipe doesn't say how many it serves, so amounts are as
            written.
          </p>
        )}
      </details>
    </li>
  )
}

/** Pick from the user's saved recipes, leaving out any that break their
 *  diets, allergies or exclusions (a hard filter). */
function AddRecipe({
  api,
  busy,
  onAdd,
}: {
  api: PlanApi
  busy: boolean
  onAdd: (r: SavedRecipe) => void
}) {
  const [recipes, setRecipes] = useState<SavedRecipe[] | null>(null)
  const [fits, setFits] = useState<Record<string, Fit>>({})
  const [query, setQuery] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    api
      .list()
      .then(async (list) => {
        const f = await api.recipeFits(list.map((r) => r.id))
        if (!live) return
        setFits(f)
        setRecipes(list)
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [api])

  if (failed) {
    return (
      <p className="muted small">We couldn't load your recipes to add one.</p>
    )
  }
  if (!recipes) return null

  const allowed = recipes.filter((r) => fits[r.id] !== 'excluded')
  const hidden = recipes.length - allowed.length
  const shown = filterRecipes(allowed, { ...NO_FILTER, query })

  return (
    <section className="add-to-plan">
      <h3>Add a recipe</h3>
      {recipes.length === 0 ? (
        <p className="muted small">
          Save some recipes first, then plan them here.{' '}
          <Link to="/">Your recipes</Link>
        </p>
      ) : (
        <>
          <label htmlFor="plan-search" className="visually-hidden">
            Search your recipes
          </label>
          <input
            id="plan-search"
            type="search"
            placeholder="Search your recipes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="recipes" aria-label="Recipes you can add">
            {shown.map((r) => (
              <li key={r.id}>
                <span>
                  {r.title}
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
                <button
                  type="button"
                  className="chip"
                  disabled={busy}
                  aria-label={`Add ${r.title}`}
                  onClick={() => onAdd(r)}
                >
                  + Add
                </button>
              </li>
            ))}
          </ul>
          {shown.length === 0 && (
            <p className="muted small">No recipes match “{query}”.</p>
          )}
          {hidden > 0 && (
            <p className="muted small">
              {hidden} recipe{hidden === 1 ? '' : 's'} left out because{' '}
              {hidden === 1 ? "it doesn't" : "they don't"} fit your diets or
              allergies.
            </p>
          )}
        </>
      )}
    </section>
  )
}
