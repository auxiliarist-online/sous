import { useEffect, useState, type FormEvent } from 'react'
import { filterRecipes, NO_FILTER, type SavedRecipe } from './library.ts'
import {
  addDays,
  isoDate,
  dayName,
  buyText,
  dollars,
  parseDollars,
  priceBasis,
  saleText,
  formatQuantity,
  scaledLine,
  SCALES,
  weekDays,
  weekLabel,
  weekOf,
  type AddedCost,
  type AddedCosts,
  type BuyItem,
  type Fit,
  type PantryStatus,
  type PlanChoice,
  type PlanCost,
  type PlanEntry,
  type Scale,
} from './plan.ts'
import { CookedButton } from './Cooked.tsx'
import type { Cooked, CookedApi } from './cooked.ts'
import { Link } from './router.tsx'
import { ingredientLines, type RecipeDetail } from './sous.ts'

export interface PlanApi extends CookedApi {
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
  /** Take several recipes out at once (clearing the week). */
  removeEntries(ids: string[]): Promise<void>
  copyPlan(from: string, to: string): Promise<number>
  planCost(weekStart: string): Promise<PlanCost>
  /** What adding each recipe would add to the week (TYL-30). */
  addedCosts(weekStart: string, recipeIds: string[]): Promise<AddedCosts>
  recipeFits(ids: string[]): Promise<Record<string, Fit>>
  /** The user's favorite cuisine slugs, to suggest those first. */
  favoriteCuisines(): Promise<string[]>
  setPantry(ingredientId: string, status: PantryStatus | null): Promise<void>
  /** The user's own price for an ingredient at a store (TYL-34). */
  setMyPrice(
    ingredientId: string,
    storeId: string | null,
    cents: number,
    basis: { quantity: number; unit: string },
  ): Promise<void>
  /** Back to the usual price at a store (or anywhere, with null). */
  clearMyPrice(ingredientId: string, storeId: string | null): Promise<void>
  /** Which option of an "or" line to buy this week (TYL-98). */
  saveChoice(
    weekStart: string,
    key: string,
    ingredientId: string,
  ): Promise<void>
}

/** The week's meals (TYL-15): what's planned on which day and at what size,
 *  and what buying it all is likely to cost against the budget. */
export function PlanPage({ api, week }: { api: PlanApi; week: string }) {
  const [entries, setEntries] = useState<PlanEntry[] | null>(null)
  const [cost, setCost] = useState<PlanCost | 'error' | null>(null)
  // What's been cooked, by plan entry (TYL-68).
  const [cooked, setCooked] = useState<Record<string, Cooked>>({})
  const [failed, setFailed] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [clearing, setClearing] = useState(false)

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
        // Extra: the plan works without knowing what was cooked.
        api.cookedEntries(planned.map((e) => e.id)).then(
          (c) => live && setCooked(c),
          () => {},
        )
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
          {cost && cost !== 'error' && (
            <Choices
              choices={cost.choices}
              busy={busy}
              onChoose={(key, ingredientId) =>
                void change(
                  () => api.saveChoice(week, key, ingredientId),
                  "We couldn't save your choice. Try again.",
                )
              }
            />
          )}
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
            onPrice={(item, cents) => {
              const storeId = cost && cost !== 'error' ? cost.storeId : null
              void change(
                () =>
                  cents === null
                    ? api.clearMyPrice(item.ingredientId!, storeId)
                    : api.setMyPrice(
                        item.ingredientId!,
                        storeId,
                        cents,
                        priceBasis(item),
                      ),
                "We couldn't save your price. Try again.",
              )
            }}
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
                      cooked={cooked[e.id] ?? null}
                      onCooked={(c) =>
                        setCooked((all) => {
                          const next = { ...all }
                          if (c) next[e.id] = c
                          else delete next[e.id]
                          return next
                        })
                      }
                      onMoveOn={
                        week < thisWeek
                          ? () =>
                              void change(async () => {
                                await api.addToPlan(
                                  thisWeek,
                                  e.recipeId,
                                  e.scale,
                                  null,
                                )
                                await api.removeEntry(e.id)
                              }, "We couldn't move that. Try again.")
                          : null
                      }
                      cost={cost && cost !== 'error' ? cost : null}
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

          {entries.length > 0 &&
            (clearing ? (
              <div
                className="clear-week"
                role="group"
                aria-label="Clear the week"
              >
                <p className="small">
                  Take all {entries.length} recipe
                  {entries.length === 1 ? '' : 's'} off this week?
                </p>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    setClearing(false)
                    void change(
                      () => api.removeEntries(entries.map((e) => e.id)),
                      "We couldn't clear the week. Try again.",
                    )
                  }}
                >
                  Clear the week
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setClearing(false)}
                >
                  Keep them
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="link small"
                disabled={busy}
                onClick={() => setClearing(true)}
              >
                Clear this week
              </button>
            ))}

          {message && (
            <p role="status" className="muted">
              {message}
            </p>
          )}

          <AddRecipe
            api={api}
            week={week}
            version={version}
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

/** The week's cost against the budget, and the buy list: where each price
 *  is from, with the pantry and the user's own prices editable. */
function Budget({
  cost,
  empty,
  busy,
  onPantry,
  onPrice,
}: {
  cost: PlanCost | 'error' | null
  empty: boolean
  busy: boolean
  onPantry: (item: BuyItem, status: PantryStatus | null) => void
  /** Save the user's price for one item (null clears it). */
  onPrice: (item: BuyItem, cents: number | null) => void
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
      <p className="muted small price-note">
        <PriceSource cost={cost} />
        {cost.unpriced > 0 &&
          ` ${cost.unpriced} item${cost.unpriced === 1 ? '' : 's'} not priced yet.`}
      </p>
      <details className="buying">
        <summary className="small">What you'll buy ({toBuy.length})</summary>
        <ul className="buy-list" aria-label="To buy">
          {toBuy.map((i, n) => (
            <BuyRow
              key={i.ingredientId ?? `x${n}`}
              item={i}
              busy={busy}
              storeName={cost.storeName}
              onPantry={onPantry}
              onPrice={onPrice}
            />
          ))}
        </ul>
      </details>
      {onHand.length > 0 && (
        <section className="on-hand" aria-labelledby="on-hand-title">
          <h4 id="on-hand-title">On hand, not on your list</h4>
          <p className="muted small">
            You said you have these, so they aren't counted. Tap "Need it" to
            put one back on the list.
          </p>
          <ul className="buy-list" aria-label="On hand">
            {onHand.map((i) => (
              <BuyRow
                key={i.ingredientId}
                item={i}
                busy={busy}
                storeName={cost.storeName}
                onPantry={onPantry}
                onPrice={onPrice}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** Where the week's prices come from. Without a store's prices it says
 *  why (no store chosen, none near the user's zip code, or the store's
 *  prices didn't load), and mentions estimates only when some prices are
 *  (a user may have entered their own for everything). */
function PriceSource({ cost }: { cost: PlanCost }) {
  const estimates = cost.estimated ? ' Prices marked ~ are estimates.' : ''
  if (cost.storeName) {
    return (
      <>
        Prices from {cost.storeName}, today.{estimates}
      </>
    )
  }
  switch (cost.storeStatus) {
    case 'none_nearby':
      return (
        <>
          Store prices come from Kroger-family stores, and there isn't one near{' '}
          {cost.homeZip ?? 'you'}.{estimates} Use <strong>Edit price</strong> to
          use what you pay.
        </>
      )
    case 'unavailable':
      return <>Your store's prices didn't load this time.{estimates}</>
    case 'unknown':
      return <>Store prices aren't available right now.{estimates}</>
    default:
      return (
        <>
          <Link to="/settings">Choose your store</Link> for today's shelf
          prices.{estimates}
        </>
      )
  }
}

const SOURCE_LABELS = { user: 'your price', estimate: 'estimate' } as const

/** One thing to buy: amount, price and where it's from, with buttons for the
 *  pantry and for the user's own price. */
function BuyRow({
  item,
  busy,
  storeName,
  onPantry,
  onPrice,
}: {
  item: BuyItem
  busy: boolean
  storeName: string | null
  onPantry: (item: BuyItem, status: PantryStatus | null) => void
  onPrice: (item: BuyItem, cents: number | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const amount = buyText(item)
  const source =
    item.priceSource === 'store'
      ? storeName
      : item.priceSource
        ? SOURCE_LABELS[item.priceSource]
        : null
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
        {item.buy && saleText(item) && (
          <span className="sale small"> · {saleText(item)}</span>
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
        {item.buy
          ? item.cents !== null
            ? `${item.estimated ? '~' : ''}${dollars(item.cents)}`
            : '—'
          : ''}
        {item.buy && item.cents !== null && source && (
          <span className="muted price-source"> {source}</span>
        )}
      </span>
      {item.buy && item.ingredientId && !editing && (
        <button
          type="button"
          className="link small edit-price"
          disabled={busy}
          aria-label={`Set your price for ${item.name}`}
          onClick={() => setEditing(true)}
        >
          Edit price
        </button>
      )}
      {editing && (
        <PriceForm
          item={item}
          storeName={storeName}
          busy={busy}
          onSave={(cents) => {
            setEditing(false)
            onPrice(item, cents)
          }}
          onCancel={() => setEditing(false)}
        />
      )}
      {item.ingredientId && (
        <button
          type="button"
          className="chip"
          disabled={busy}
          onClick={() => onPantry(item, item.buy ? 'have' : null)}
          aria-label={
            item.buy
              ? `I have ${item.name} already`
              : `I need ${item.name}, put it on the list`
          }
        >
          {item.buy ? 'Have it' : 'Need it'}
        </button>
      )}
    </li>
  )
}

/** "Your price at Harris Teeter for 14 oz: $__": saves the user's own
 *  price for one package (or pound) of an item, or clears it (TYL-34). */
function PriceForm({
  item,
  storeName,
  busy,
  onSave,
  onCancel,
}: {
  item: BuyItem
  storeName: string | null
  busy: boolean
  onSave: (cents: number | null) => void
  onCancel: () => void
}) {
  const basis = priceBasis(item)
  const [text, setText] = useState('')
  const cents = parseDollars(text)
  const id = `price-${item.ingredientId}`

  // Save the typed price, if it is one.
  function submit(e: FormEvent) {
    e.preventDefault()
    if (cents !== null) onSave(cents)
  }

  return (
    <form className="price-form" onSubmit={submit}>
      <label htmlFor={id} className="small">
        Your price{storeName ? ` at ${storeName}` : ''} for {basis.label}{' '}
        {item.name}
      </label>
      <input
        id={id}
        inputMode="decimal"
        placeholder="$0.00"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-invalid={text !== '' && cents === null}
      />
      <button type="submit" className="chip" disabled={busy || cents === null}>
        Save
      </button>
      {item.priceSource === 'user' && (
        <button
          type="button"
          className="link small"
          disabled={busy}
          onClick={() => onSave(null)}
        >
          Use the usual price
        </button>
      )}
      <button type="button" className="link small" onClick={onCancel}>
        Cancel
      </button>
    </form>
  )
}

/** One planned recipe: its size, day and share of the cost, with its
 *  ingredients at the planned size on request. */
function Entry({
  entry,
  cooked,
  onCooked,
  onMoveOn,
  cost,
  days,
  api,
  busy,
  onChange,
  onRemove,
}: {
  entry: PlanEntry
  /** Whether it's been cooked, with the rating and note (TYL-68). */
  cooked: Cooked | null
  onCooked: (cooked: Cooked | null) => void
  /** In a week that's over: move a meal that wasn't cooked to this week. */
  onMoveOn: (() => void) | null
  /** The week's cost, for this recipe's share of it (TYL-30). */
  cost: PlanCost | null
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
        {cost && cost.entryCents[entry.id] !== undefined && (
          <span className="muted small" aria-label="This recipe's share">
            {cost.estimated ? '~' : ''}
            {dollars(cost.entryCents[entry.id])}
          </span>
        )}
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
      <CookedButton
        api={api}
        recipeId={entry.recipeId}
        title={entry.title}
        planEntryId={entry.id}
        cookedOn={cookedOn(entry.day)}
        scale={entry.scale}
        cooked={cooked}
        onChange={onCooked}
      />
      {onMoveOn && !cooked && (
        <p className="small muted">
          Didn't make it?{' '}
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={onMoveOn}
          >
            Move to this week
          </button>
        </p>
      )}
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

/** The day a planned meal counts as cooked: its planned day, unless that's
 *  still ahead (cooked early), or today for "any day". */
function cookedOn(day: string | null): string {
  const today = isoDate(new Date())
  return day && day <= today ? day : today
}

/** The week's "or" lines (TYL-98): ones waiting for the user to choose,
 *  each option with what it adds, and ones settled by what another recipe
 *  needs or an earlier choice, which can be switched. One settled by diet
 *  has nothing to choose, so it isn't shown. */
function Choices({
  choices,
  busy,
  onChoose,
}: {
  choices: PlanChoice[]
  busy: boolean
  onChoose: (key: string, ingredientId: string) => void
}) {
  const shown = choices.filter((c) => c.options.length > 1)
  if (shown.length === 0) return null
  const pending = shown.filter((c) => c.reason === 'pending')
  return (
    <section className="choices" aria-labelledby="choices-title">
      <h3 id="choices-title">
        {pending.length > 0
          ? 'Choose before you shop'
          : 'Recipes that take either'}
      </h3>
      {pending.length > 0 && (
        <p className="small muted">These go on your list once you choose.</p>
      )}
      <ul>
        {shown.map((c) => (
          <li key={c.key}>
            <ChoiceRow choice={c} busy={busy} onChoose={onChoose} />
          </li>
        ))}
      </ul>
    </section>
  )
}

// Why an "or" line uses the option it does, after its name.
const REASONS: Record<PlanChoice['reason'], string> = {
  diet: ', the one that fits your diet.',
  chosen: ', your choice.',
  on_hand: ', since you have it.',
  needed: ', since another recipe needs it.',
  pending: '.',
}

/** One "or" line: its options as buttons while it waits, or what's used,
 *  why, and what the other would add. */
function ChoiceRow({
  choice,
  busy,
  onChoose,
}: {
  choice: PlanChoice
  busy: boolean
  onChoose: (key: string, ingredientId: string) => void
}) {
  const names = choice.options.map((o) => o.name).join(' or ')
  const where =
    choice.recipes > 1 ? `${choice.recipes} recipes take` : 'A recipe takes'
  if (choice.reason === 'pending') {
    return (
      <>
        <p className="small">
          {where} {names}.
          {!choice.fits && (
            <span className="warning">
              {' '}
              None of these fit your diets or allergies.
            </span>
          )}
        </p>
        <div className="chips">
          {choice.options.map((o) => (
            <button
              key={o.ingredientId}
              type="button"
              className="chip"
              disabled={busy}
              onClick={() => onChoose(choice.key, o.ingredientId)}
            >
              {o.name}
              {o.cents !== null && ` +${dollars(o.cents)}`}
            </button>
          ))}
        </div>
      </>
    )
  }
  const used = choice.options.find((o) => o.ingredientId === choice.chosen)
  const others = choice.options.filter((o) => o !== used)
  return (
    <p className="small">
      {where} {names}: using <strong>{used?.name}</strong>
      {REASONS[choice.reason]}{' '}
      {!choice.fits && (
        <span className="warning">
          It doesn't fit your diets or allergies.{' '}
        </span>
      )}
      {others.map((o) => (
        <button
          key={o.ingredientId}
          type="button"
          className="link"
          disabled={busy}
          onClick={() => onChoose(choice.key, o.ingredientId)}
        >
          Use {o.name} instead
          {o.cents !== null &&
            used?.cents != null &&
            ` (${o.cents >= used.cents ? '+' : '−'}${dollars(Math.abs(o.cents - used.cents))})`}
        </button>
      ))}
    </p>
  )
}

/** "+~$4.10", or "+~$4.10 or more" when some of what it needs has no price. */
function addedText(a: AddedCost): string {
  return `+${a.estimated ? '~' : ''}${dollars(a.cents)}${a.unpriced ? ' or more' : ''}`
}

/** Pick from the user's saved recipes, each with what it would add to the
 *  week's cost (TYL-30). One that breaks their diets, allergies or exclusions
 *  (TYL-85), or would take the week over budget, asks first; going over also
 *  suggests cheaper recipes that fit the budget and their rules, favorite
 *  cuisines first. */
function AddRecipe({
  api,
  week,
  version,
  busy,
  onAdd,
}: {
  api: PlanApi
  week: string
  /** Changes whenever the plan does, so the costs are worked out again. */
  version: number
  busy: boolean
  onAdd: (r: SavedRecipe) => void
}) {
  const [recipes, setRecipes] = useState<SavedRecipe[] | null>(null)
  const [fits, setFits] = useState<Record<string, Fit>>({})
  const [added, setAdded] = useState<AddedCosts | null>(null)
  const [favorites, setFavorites] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [failed, setFailed] = useState(false)
  // A recipe waiting for "Add anyway": it breaks the user's rules, or the budget.
  const [confirming, setConfirming] = useState<string | null>(null)

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
    // Only for ordering suggestions, so it can fail quietly.
    api.favoriteCuisines().then(
      (c) => live && setFavorites(c),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api])

  // What each would add; without it the list still works, just without costs.
  useEffect(() => {
    if (!recipes?.length) return
    let live = true
    api
      .addedCosts(
        week,
        recipes.map((r) => r.id),
      )
      .then(
        (a) => live && setAdded(a),
        () => live && setAdded(null),
      )
    return () => {
      live = false
    }
  }, [api, week, version, recipes])

  if (failed) {
    return (
      <p className="muted small">We couldn't load your recipes to add one.</p>
    )
  }
  if (!recipes) return null

  const shown = filterRecipes(recipes, { ...NO_FILTER, query })
  const budget = added?.budgetCents ?? null
  // How far over budget the week would go with this recipe; 0 when it fits.
  const overBy = (r: SavedRecipe) => {
    const a = added?.recipes[r.id]
    if (!added || budget === null || !a) return 0
    return Math.max(0, added.totalCents + a.cents - budget)
  }
  // 0 for a recipe from one of the user's favorite cuisines, to list first.
  const favorite = (r: SavedRecipe) =>
    r.cuisines.some((c) => favorites.includes(c)) ? 0 : 1
  // Up to three other recipes that fit the budget and the user's rules: from
  // their favorite cuisines first, then cheapest.
  const cheaper = (r: SavedRecipe) =>
    recipes
      .filter(
        (o) =>
          o.id !== r.id &&
          fits[o.id] !== 'excluded' &&
          added?.recipes[o.id] &&
          overBy(o) === 0,
      )
      .sort(
        (a, b) =>
          favorite(a) - favorite(b) ||
          added!.recipes[a.id].cents - added!.recipes[b.id].cents,
      )
      .slice(0, 3)

  return (
    <section className="add-to-plan">
      <h3>Add a recipe</h3>
      <Link to="/browse" className="small">
        Find more recipes
      </Link>
      {recipes.length === 0 ? (
        <p className="muted small">
          Save some recipes, or find one and add it to this week from its page.
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
            {shown.map((r) => {
              const cost = added?.recipes[r.id]
              const excluded = fits[r.id] === 'excluded'
              const over = overBy(r)
              const others = confirming === r.id && over > 0 ? cheaper(r) : []
              return (
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
                  {confirming === r.id ? (
                    <button
                      type="button"
                      className="link"
                      aria-label={`Don't add ${r.title}`}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="chip"
                      disabled={busy}
                      aria-label={`Add ${r.title}`}
                      onClick={() =>
                        excluded || over > 0 ? setConfirming(r.id) : onAdd(r)
                      }
                    >
                      + Add
                    </button>
                  )}
                  {confirming !== r.id && (cost || excluded) && (
                    <span className="small">
                      {cost && (
                        <span className="muted" aria-label="Adds to this week">
                          {addedText(cost)}
                        </span>
                      )}
                      {cost && cost.staplesCents > 0 && (
                        <span
                          className="muted"
                          title="Staples like salt and oil you may already have. Mark them in your pantry to leave them off."
                        >
                          {' '}
                          incl. {dollars(cost.staplesCents)} of staples
                        </span>
                      )}
                      {cost && over > 0 && (
                        <span className="warning"> · over budget</span>
                      )}
                      {cost && excluded && ' · '}
                      {excluded && (
                        <span className="warning">
                          Doesn't fit your diets or allergies
                        </span>
                      )}
                    </span>
                  )}
                  {confirming === r.id && (
                    <div className="small warning confirm" role="alert">
                      {excluded && (
                        <p>{r.title} doesn't fit your diets or allergies.</p>
                      )}
                      {over > 0 && cost && budget !== null && (
                        <p>
                          Adding it ({addedText(cost)}) puts the week at{' '}
                          {cost.estimated ? '~' : ''}
                          {dollars(added!.totalCents + cost.cents)},{' '}
                          {dollars(over)} over your {dollars(budget)} budget.
                        </p>
                      )}
                      <button
                        type="button"
                        className="link"
                        disabled={busy}
                        onClick={() => {
                          setConfirming(null)
                          onAdd(r)
                        }}
                      >
                        Add anyway
                      </button>
                      {others.length > 0 && (
                        <div className="cheaper">
                          <p className="muted">Cheaper picks that fit:</p>
                          <ul aria-label="Cheaper picks">
                            {others.map((o) => (
                              <li key={o.id}>
                                <button
                                  type="button"
                                  className="chip"
                                  disabled={busy}
                                  onClick={() => {
                                    setConfirming(null)
                                    onAdd(o)
                                  }}
                                >
                                  {o.title} {addedText(added!.recipes[o.id])}
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          {shown.length === 0 && (
            <p className="muted small">No recipes match “{query}”.</p>
          )}
        </>
      )}
    </section>
  )
}
