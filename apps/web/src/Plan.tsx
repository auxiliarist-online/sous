import { useEffect, useState } from 'react'
import { filterRecipes, NO_FILTER, type SavedRecipe } from './library.ts'
import {
  addDays,
  dayName,
  buyText,
  dollars,
  formatQuantity,
  scaledLine,
  SCALES,
  weekDays,
  weekLabel,
  weekOf,
  type BuyItem,
  type Fit,
  type PantryStatus,
  type PlanCost,
  type PlanEntry,
  type Scale,
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
    scale?: Scale,
    day?: string | null,
  ): Promise<void>
  updateEntry(
    id: string,
    patch: { scale?: Scale; day?: string | null },
  ): Promise<void>
  removeEntry(id: string): Promise<void>
  copyPlan(from: string, to: string): Promise<number>
  planCost(weekStart: string): Promise<PlanCost>
  recipeFits(ids: string[]): Promise<Record<string, Fit>>
  setPantry(ingredientId: string, status: PantryStatus | null): Promise<void>
}

/** The week's meals (TYL-15): what's planned on which day and at what size,
 *  and what buying it all is likely to cost against the budget. */
export function PlanPage({ api, week }: { api: PlanApi; week: string }) {
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
          <Budget
            cost={cost}
            empty={entries.length === 0}
            busy={busy}
            onPantry={(item, status) =>
              void change(
                () => api.setPantry(item.ingredientId!, status),
                "We couldn't update your pantry. Try again.",
              )
            }
          />

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
                () => api.addToPlan(week, r.id, 1),
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
  busy,
  onPantry,
}: {
  cost: PlanCost | 'error' | null
  empty: boolean
  busy: boolean
  onPantry: (item: BuyItem, status: PantryStatus) => void
}) {
  if (cost === null) {
    return empty ? null : <p className="muted small">Working out the cost…</p>
  }
  if (cost === 'error') {
    return <p className="muted small">We couldn't estimate the cost.</p>
  }
  if (empty) return null
  const approx = cost.estimated ? '~' : ''
  const total = `${approx}${dollars(cost.totalCents)}`
  const over = cost.budgetCents !== null && cost.totalCents > cost.budgetCents
  const toBuy = cost.items.filter((i) => i.buy)
  const onHand = cost.items.filter((i) => !i.buy)
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
      {(cost.estimated || cost.unpriced > 0) && (
        <p className="muted small">
          {cost.estimated && 'Rough prices until store prices are in. '}
          {cost.unpriced > 0 &&
            `${cost.unpriced} item${cost.unpriced === 1 ? '' : 's'} not priced yet.`}
        </p>
      )}
      <details className="buying">
        <summary className="small">
          What you'll buy ({toBuy.length})
          {onHand.length > 0 && `, and ${onHand.length} on hand`}
        </summary>
        <ul className="buy-list" aria-label="To buy">
          {toBuy.map((i, n) => (
            <BuyRow
              key={i.ingredientId ?? `x${n}`}
              item={i}
              busy={busy}
              onPantry={onPantry}
            />
          ))}
        </ul>
        {onHand.length > 0 && (
          <>
            <h4>On hand</h4>
            <p className="muted small">
              Not counted. Staples like salt and oil are assumed on hand until
              you say you're out.
            </p>
            <ul className="buy-list" aria-label="On hand">
              {onHand.map((i) => (
                <BuyRow
                  key={i.ingredientId}
                  item={i}
                  busy={busy}
                  onPantry={onPantry}
                />
              ))}
            </ul>
          </>
        )}
      </details>
    </div>
  )
}

function BuyRow({
  item,
  busy,
  onPantry,
}: {
  item: BuyItem
  busy: boolean
  onPantry: (item: BuyItem, status: PantryStatus) => void
}) {
  const amount = buyText(item)
  const leftover =
    item.leftover && item.packageQuantity && item.packageUnit !== 'each'
      ? item.leftover / item.packageQuantity
      : null
  return (
    <li>
      <span className="buy-name">
        {item.name}
        {amount && <span className="muted"> · {amount}</span>}
        {item.buy && item.amountUnknown && !item.packages && (
          <span className="muted"> · amount not given</span>
        )}
        {leftover !== null && leftover >= 0.25 && (
          <span className="muted small">
            {' '}
            (about {formatQuantity(Math.round(leftover * 4) / 4)} of a package
            left over)
          </span>
        )}
      </span>
      <span className="buy-price small">
        {item.buy ? (item.cents !== null ? dollars(item.cents) : '—') : ''}
      </span>
      {item.ingredientId && (
        <button
          type="button"
          className="chip"
          disabled={busy}
          onClick={() => onPantry(item, item.buy ? 'have' : 'out')}
          aria-label={
            item.buy ? `I have ${item.name} already` : `I'm out of ${item.name}`
          }
        >
          {item.buy ? 'Have it' : "I'm out"}
        </button>
      )}
    </li>
  )
}

function Entry({
  entry,
  days,
  api,
  busy,
  onChange,
  onRemove,
}: {
  entry: PlanEntry
  days: string[]
  api: PlanApi
  busy: boolean
  onChange: (patch: { scale?: Scale; day?: string | null }) => void
  onRemove: () => void
}) {
  const [recipe, setRecipe] = useState<RecipeDetail | null | undefined>(
    undefined,
  )
  const serves = entry.recipeServings
    ? Math.round(entry.recipeServings * entry.scale * 10) / 10
    : null

  function open(isOpen: boolean) {
    if (isOpen && recipe === undefined) {
      api.recipe(entry.recipeId).then(setRecipe, () => setRecipe(null))
    }
  }

  return (
    <li className="plan-entry">
      <div className="entry-head">
        <Link to={`/recipe/${entry.recipeId}`}>{entry.title}</Link>
        {serves && <span className="muted small">serves {serves}</span>}
      </div>
      <div className="entry-controls">
        <div
          className="chips sizes"
          role="group"
          aria-label={`Size of ${entry.title}`}
        >
          {SCALES.map(([scale, label]) => (
            <button
              key={scale}
              type="button"
              className="chip"
              aria-pressed={entry.scale === scale}
              disabled={busy}
              onClick={() => entry.scale !== scale && onChange({ scale })}
            >
              {label}
            </button>
          ))}
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
          {entry.scale === 2 && ', doubled'}
          {entry.scale === 0.5 && ', halved'}
        </summary>
        {recipe === undefined && <p className="muted small">Loading…</p>}
        {recipe === null && (
          <p className="muted small">We couldn't load the ingredients.</p>
        )}
        {recipe && (
          <ul className="ingredients small">
            {ingredientLines(recipe.ingredients).map((l) => (
              <li key={l.lineNo}>
                {scaledLine(l, entry.scale)}
                {l.isOptional && <span className="muted"> (optional)</span>}
              </li>
            ))}
          </ul>
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
