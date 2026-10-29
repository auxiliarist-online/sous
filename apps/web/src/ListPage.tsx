import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  aisleName,
  applyOp,
  cachedList,
  cacheList,
  flushOps,
  listText,
  ownItems,
  pendingOps,
  queueOp,
  type ListItem,
  type ListOp,
  type ListState,
  type OwnPrices,
  plannedItems,
  type PlannedItem,
} from './list.ts'
import { addDays, dollars, weekLabel, weekOf, type PlanCost } from './plan.ts'
import { Link } from './router.tsx'
import { seasonOf, type Seasons } from './seasons.ts'

/** A place an item can be bought: the user's store, or one they added. */
export interface Place {
  id: string
  name: string
}

export interface ListApi {
  /** The week's buy list and prices, from the plan. */
  planCost(weekStart: string): Promise<PlanCost>
  /** Bring the week's list in line with the plan; returns the list's id. */
  syncList(weekStart: string, items: PlannedItem[]): Promise<string>
  /** The week's list as stored, or null when there isn't one yet. */
  loadList(weekStart: string): Promise<ListState | null>
  /** Send one change to the list. */
  sendListOp(op: ListOp): Promise<void>
  /** The user's stores and own places, for "where to buy". */
  places(): Promise<Place[]>
  /** Add a place of the user's own (a market stand, a bakery). */
  addPlace(name: string): Promise<Place>
  /** What's in season where the user lives, to mark it (TYL-70). */
  seasons(): Promise<Seasons>
  /** Prices for the items the user added themselves (TYL-146). */
  ownItemPrices(
    weekStart: string,
    items: { id: string; name: string }[],
  ): Promise<OwnPrices>
}

/** A list with any changes still waiting to be sent applied, as the user
 *  last saw it. */
function withPending(user: string, state: ListState): ListState {
  return pendingOps(user).reduce(applyOp, state)
}

/** The week's shopping list (TYL-18): check things off in the store, add
 *  anything, edit or take off any item. Works offline: changes are kept on
 *  the phone and sent when there's a connection. */
export function ListPage({
  api,
  week,
  user,
}: {
  api: ListApi
  week: string
  /** Whose list: what's kept on the phone is kept per account. */
  user: string
}) {
  const [list, setList] = useState<ListState | null>(() =>
    cachedList(user, week),
  )
  const [cost, setCost] = useState<PlanCost | null>(null)
  const [places, setPlaces] = useState<Place[]>([])
  const [offline, setOffline] = useState(false)
  const [pending, setPending] = useState(() => pendingOps(user).length)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [showRemoved, setShowRemoved] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [seasons, setSeasons] = useState<Seasons | null>(null)
  // The user's own items by name: priced again when one is added or renamed,
  // and a price shown only for the names it was worked out for.
  const ownKey = JSON.stringify(
    list ? ownItems(list, cost?.storeId ?? null) : [],
  )
  const [priced, setPriced] = useState<{ key: string; prices: OwnPrices }>()
  // Bumped when the phone is back online, to price them again.
  const [reconnected, setReconnected] = useState(0)
  useEffect(() => {
    const back = () => setReconnected((n) => n + 1)
    window.addEventListener('online', back)
    return () => window.removeEventListener('online', back)
  }, [])
  const own = priced?.key === ownKey ? priced.prices : null
  useEffect(() => {
    let live = true
    const items = JSON.parse(ownKey) as { id: string; name: string }[]
    // The list works without them: own items just go unpriced.
    if (items.length)
      api.ownItemPrices(week, items).then(
        (prices) => live && setPriced({ key: ownKey, prices }),
        () => {},
      )
    return () => {
      live = false
    }
  }, [api, week, ownKey, reconnected])
  // Marks only; the list works without them.
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

  // Send any changes made offline, then bring the list up to date with the
  // plan, then reload it. Changes go first: otherwise the plan could drop an
  // item checked off offline before the check-off arrives. Without a
  // connection, the phone's copy stands.
  const refresh = useCallback(
    () =>
      flushOps(user, api.sendListOp)
        .then(async (left) => {
          setPending(left)
          const c = await api.planCost(week).catch(() => null)
          setCost(c)
          // Only once everything's sent (see above).
          if (c && left === 0) await api.syncList(week, plannedItems(c))
          const fresh = await api.loadList(week)
          if (fresh) {
            const shown = withPending(user, fresh)
            setList(shown)
            cacheList(user, shown)
          }
          setOffline(false)
        })
        .catch(() => setOffline(true))
        .finally(() => setLoading(false)),
    [api, week, user],
  )

  useEffect(() => {
    let live = true
    void refresh()
    api.places().then(
      (p) => live && setPlaces(p),
      () => {},
    )
    const back = () => void refresh()
    window.addEventListener('online', back)
    return () => {
      live = false
      window.removeEventListener('online', back)
    }
  }, [api, refresh])

  // Apply a change now, keep it on the phone, and send it when possible.
  function change(op: ListOp) {
    setList((s) => {
      if (!s) return s
      const next = applyOp(s, op)
      cacheList(user, next)
      return next
    })
    queueOp(user, op)
    setPending(pendingOps(user).length)
    flushOps(user, api.sendListOp).then(
      (left) => {
        setPending(left)
        if (left) setOffline(true)
      },
      () => setOffline(true),
    )
  }

  if (!list) {
    return loading ? (
      <p className="card muted">Loading your list…</p>
    ) : (
      <section className="card">
        <h2>Shopping list</h2>
        <p className="muted">
          {offline
            ? "You're offline, and this week's list isn't on this phone yet."
            : 'Nothing to buy yet. Add recipes to this week’s plan.'}
        </p>
        <Link to="/plan">Plan this week</Link>
      </section>
    )
  }

  const shown = list.items.filter((i) => !i.removed)
  const toBuy = shown
    .filter((i) => !i.checked)
    .sort((a, b) => a.position - b.position)
  const inCart = shown.filter((i) => i.checked)
  const removed = list.items.filter((i) => i.removed)
  const prices = new Map(
    (cost?.items ?? []).map((i) => [i.ingredientId, i] as const),
  )
  // By aisle at the user's store; anything to buy elsewhere (the market, a
  // bakery) under that place's name.
  const placeName = new Map(places.map((p) => [p.id, p.name] as const))
  const groups = new Map<string, ListItem[]>()
  for (const i of toBuy) {
    const key = (i.storeId && placeName.get(i.storeId)) || aisleName(i.aisle)
    groups.set(key, [...(groups.get(key) ?? []), i])
  }
  const ownEstimated = Object.values(own?.items ?? {}).some((p) => p.estimated)
  const title = `Shopping list · week of ${weekLabel(week)}`
  // The month the week mostly falls in, for what's in season (TYL-70).
  const month = Number(addDays(week, 3).slice(5, 7))

  // Share the list as text, or copy it where sharing isn't available.
  async function share() {
    if (!list) return
    const text = listText(list, title)
    try {
      if (navigator.share) await navigator.share({ title, text })
      else {
        await navigator.clipboard.writeText(text)
        setMessage('List copied.')
      }
    } catch {
      // The user closed the share sheet.
    }
  }

  // One item: its checkbox, amount, price, and the editor when open.
  const row = (i: ListItem) => {
    const price = i.ingredientId ? prices.get(i.ingredientId) : own?.items[i.id]
    return (
      <li key={i.id} className={i.checked ? 'list-item checked' : 'list-item'}>
        <label className="list-check">
          <input
            type="checkbox"
            checked={i.checked}
            onChange={(e) =>
              change({ kind: 'check', id: i.id, checked: e.target.checked })
            }
          />
          <span>
            {i.name}
            {i.amount && <span className="muted small"> · {i.amount}</span>}
            {seasons && seasonOf(seasons, i.ingredientId, month) === 'in' && (
              <span className="small in-season"> · in season</span>
            )}
          </span>
        </label>
        {price?.cents != null && !i.checked && (
          <span className="muted small list-price">
            {price.estimated ? '~' : ''}
            {dollars(price.cents)}
          </span>
        )}
        <button
          type="button"
          className="link small"
          aria-label={`Edit ${i.name}`}
          onClick={() => setEditing(editing === i.id ? null : i.id)}
        >
          Edit
        </button>
        {editing === i.id && (
          <ItemEditor
            item={i}
            places={places}
            onAddPlace={async (name) => {
              const p = await api.addPlace(name)
              setPlaces([...places, p])
              return p
            }}
            onSave={(patch) => {
              change({ kind: 'edit', id: i.id, patch })
              setEditing(null)
            }}
            onRemove={() => {
              change({ kind: 'remove', id: i.id, manual: i.isManual })
              setEditing(null)
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </li>
    )
  }

  return (
    <section className="card shopping-list">
      <nav className="week-nav" aria-label="Weeks">
        <Link to={`/list/${addDays(week, -7)}`} className="small">
          ← Previous
        </Link>
        <Link to={`/list/${addDays(week, 7)}`} className="small">
          Next →
        </Link>
      </nav>
      <h2>
        Shopping list{' '}
        <span className="muted">
          {week === weekOf() ? 'this week' : `week of ${weekLabel(week)}`}
        </span>
      </h2>
      <p className="small">
        {inCart.length} of {shown.length} in the cart
        {cost && (
          <span className="muted">
            {' '}
            · {cost.estimated || ownEstimated ? '~' : ''}
            {dollars(cost.totalCents + (own?.totalCents ?? 0))}
            {cost.budgetCents !== null &&
              ` of your ${dollars(cost.budgetCents)} budget`}
            {!!own?.totalCents &&
              `, with ${dollars(own.totalCents)} for items you added`}
          </span>
        )}
      </p>
      {cost && <WaitingChoices cost={cost} week={week} />}
      {(offline || pending > 0) && (
        <p role="status" className="muted small offline-note">
          {offline
            ? "You're offline. Changes are saved on this phone and sent when you're back."
            : `Sending ${pending} change${pending === 1 ? '' : 's'}…`}
        </p>
      )}

      <AddItem
        onAdd={(name, amount) =>
          change({
            kind: 'add',
            id: crypto.randomUUID(),
            listId: list.listId,
            name,
            amount,
          })
        }
      />

      {toBuy.length === 0 && (
        <p className="muted">
          {shown.length ? 'Everything’s in the cart.' : 'Nothing on the list.'}
        </p>
      )}
      {[...groups].map(([aisle, items]) => (
        <section key={aisle} className="list-aisle">
          <h3>{aisle}</h3>
          <ul aria-label={aisle}>{items.map(row)}</ul>
        </section>
      ))}

      {inCart.length > 0 && (
        <section className="list-aisle">
          <h3>In the cart ({inCart.length})</h3>
          <ul aria-label="In the cart">{inCart.map(row)}</ul>
        </section>
      )}

      {removed.length > 0 && (
        <details
          className="list-removed"
          open={showRemoved}
          onToggle={(e) => setShowRemoved(e.currentTarget.open)}
        >
          <summary className="small">Taken off ({removed.length})</summary>
          <ul aria-label="Taken off">
            {removed.map((i) => (
              <li key={i.id} className="list-item">
                <span>{i.name}</span>
                <button
                  type="button"
                  className="link small"
                  aria-label={`Put ${i.name} back`}
                  onClick={() => change({ kind: 'restore', id: i.id })}
                >
                  Put back
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="list-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => void share()}
        >
          Share list
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => window.print()}
        >
          Print
        </button>
      </div>
      {message && (
        <p role="status" className="muted small">
          {message}
        </p>
      )}
    </section>
  )
}

/** "Almond milk or cow's milk" lines waiting for the user's choice (TYL-98)
 *  aren't on the list yet: say so, and where to choose. */
function WaitingChoices({ cost, week }: { cost: PlanCost; week: string }) {
  const waiting = cost.choices.filter((c) => c.reason === 'pending')
  if (waiting.length === 0) return null
  return (
    <p className="small notice">
      Not on the list until you choose:{' '}
      {waiting.map((c) => c.options.map((o) => o.name).join(' or ')).join('; ')}
      . <Link to={`/plan/${week}`}>Choose on your plan</Link>
    </p>
  )
}

/** "Add an item": anything, recipe or not (paper towels, coffee). */
function AddItem({
  onAdd,
}: {
  onAdd: (name: string, amount: string | null) => void
}) {
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')

  // Add what's typed, then clear the fields for the next item.
  function submit(e: FormEvent) {
    e.preventDefault()
    const n = name.trim().slice(0, 120)
    if (!n) return
    onAdd(n, amount.trim().slice(0, 60) || null)
    setName('')
    setAmount('')
  }

  return (
    <form className="list-add" onSubmit={submit}>
      <label htmlFor="list-add-name" className="visually-hidden">
        Add an item
      </label>
      <input
        id="list-add-name"
        placeholder="Add an item, like paper towels"
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor="list-add-amount" className="visually-hidden">
        Amount to buy
      </label>
      <input
        id="list-add-amount"
        className="list-amount"
        placeholder="Amount, like 2 lb"
        value={amount}
        maxLength={60}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button type="submit" className="chip" disabled={!name.trim()}>
        Add
      </button>
    </form>
  )
}

/** Edit one item: name, amount and where to buy it; or take it off. */
function ItemEditor({
  item,
  places,
  onAddPlace,
  onSave,
  onRemove,
  onCancel,
}: {
  item: ListItem
  places: Place[]
  onAddPlace: (name: string) => Promise<Place>
  onSave: (patch: {
    name?: string
    amount?: string | null
    storeId?: string | null
  }) => void
  onRemove: () => void
  onCancel: () => void
}) {
  const [name, setName] = useState(item.name)
  const [amount, setAmount] = useState(item.amount ?? '')
  const [storeId, setStoreId] = useState(item.storeId ?? '')
  const [newPlace, setNewPlace] = useState('')
  const [failed, setFailed] = useState(false)

  // Save only what changed.
  function submit(e: FormEvent) {
    e.preventDefault()
    const n = name.trim().slice(0, 120)
    if (!n) return
    const a = amount.trim().slice(0, 60) || null
    const s = storeId || null
    onSave({
      ...(n !== item.name && { name: n }),
      ...(a !== item.amount && { amount: a }),
      ...(s !== item.storeId && { storeId: s }),
    })
  }

  // Add a place of the user's own and choose it.
  async function addPlace() {
    const n = newPlace.trim().slice(0, 80)
    if (!n) return
    try {
      const p = await onAddPlace(n)
      setStoreId(p.id)
      setNewPlace('')
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

  const id = `edit-${item.id}`
  return (
    <form className="list-edit" onSubmit={submit}>
      <label htmlFor={`${id}-name`}>Item</label>
      <input
        id={`${id}-name`}
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor={`${id}-amount`}>Amount to buy (like 2 lb)</label>
      <input
        id={`${id}-amount`}
        value={amount}
        maxLength={60}
        onChange={(e) => setAmount(e.target.value)}
      />
      <label htmlFor={`${id}-store`}>Where to buy it</label>
      <select
        id={`${id}-store`}
        value={storeId}
        onChange={(e) => setStoreId(e.target.value)}
      >
        <option value="">Your store</option>
        {places.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="row">
        <div>
          <label htmlFor={`${id}-place`} className="small">
            Or a new place
          </label>
          <input
            id={`${id}-place`}
            placeholder="Farmers market, bakery…"
            value={newPlace}
            maxLength={80}
            onChange={(e) => setNewPlace(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="chip"
          disabled={!newPlace.trim()}
          onClick={() => void addPlace()}
        >
          Add place
        </button>
      </div>
      {failed && (
        <p role="alert" className="error small">
          We couldn't add that place. Try again when you're online.
        </p>
      )}
      <div className="list-edit-actions">
        <button type="submit" disabled={!name.trim()}>
          Save
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="link danger" onClick={onRemove}>
          Take off the list
        </button>
      </div>
    </form>
  )
}
