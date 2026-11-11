import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
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
  type OwnItem,
  type OwnPrices,
  type SizeOption,
  plannedItems,
  type PlannedItem,
} from './list.ts'
import {
  addDays,
  dollars,
  unreviewed,
  weekLabel,
  weekOf,
  type PlanCost,
  type PlanEntry,
} from './plan.ts'
import { PendingNotice, ReviewSheet, type ReviewApi } from './Review.tsx'
import { Link } from './router.tsx'
import { Share2 } from 'lucide-react'
import {
  nearAsheville,
  openingText,
  planLocal,
  type LocalPlace,
  type LocalPrefer,
  type Needed,
} from './local.ts'
import type { Preferences } from './sous.ts'
import { seasonOf, type Seasons } from './seasons.ts'

/** A place an item can be bought: the user's store, or one they added. */
export interface Place {
  id: string
  name: string
}

export interface ListApi extends ReviewApi {
  /** The week's planned meals: any not reviewed yet are offered for review. */
  plan(weekStart: string): Promise<PlanEntry[]>
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
  ownItemPrices(weekStart: string, items: OwnItem[]): Promise<OwnPrices>
  /** The sizes a typed item comes in at the user's store (TYL-142). */
  itemSizes(name: string): Promise<SizeOption[]>
  /** For local first (TYL-71): the setting and home zip. */
  preferences(): Promise<Preferences>
  /** The local food directory. */
  localPlaces(): Promise<LocalPlace[]>
  /** The ids of the user's favorite places. */
  favoritePlaces(): Promise<string[]>
  /** Where the user has said to buy things, by ingredient. */
  localPreferences(): Promise<Record<string, LocalPrefer>>
  /** Remember where to buy an ingredient, or (null) let the list decide. */
  setLocalPreference(
    ingredientId: string,
    prefer: LocalPrefer | null,
  ): Promise<void>
  /** Each ingredient's categories, and the first day a meal needs it. */
  localInputs(
    weekStart: string,
    ingredientIds: string[],
  ): Promise<{
    contains: Record<string, string[]>
    neededBy: Record<string, Needed>
  }>
}

/** What local first works from, once loaded. */
interface LocalSetup {
  on: boolean
  homeZip: string | null
  places: LocalPlace[]
  favorites: Set<string>
  prefer: Record<string, LocalPrefer>
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
  now,
}: {
  api: ListApi
  week: string
  /** Whose list: what's kept on the phone is kept per account. */
  user: string
  /** For tests: when "now" is, for the local places' hours. */
  now?: Date
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
  // The typed item whose store sizes are showing (TYL-142).
  const [sizesFor, setSizesFor] = useState<string | null>(null)
  const [showRemoved, setShowRemoved] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [seasons, setSeasons] = useState<Seasons | null>(null)
  const [local, setLocal] = useState<LocalSetup | null>(null)
  const [localInfo, setLocalInfo] = useState<{
    key: string
    contains: Record<string, string[]>
    neededBy: Record<string, Needed>
  }>()
  // The time, for the places' hours: kept current while the list is open
  // (tests fix it).
  const [clock, setClock] = useState(() => now ?? new Date())
  // Tick once a minute.
  useEffect(() => {
    if (now) return
    const tick = setInterval(() => setClock(new Date()), 60_000)
    return () => clearInterval(tick)
  }, [now])
  // Where-to-buy saves still on their way, by ingredient: each waits for the
  // one before, so they land in the order they were made.
  const writes = useRef(new Map<string, Promise<void>>())
  // What's known to be saved, by ingredient: where a failed save goes back
  // to (undefined: nothing said, the list decides).
  const confirmed = useRef(new Map<string, LocalPrefer | undefined>())
  // The week's meals not on the list yet (TYL-150), and the review sheet.
  const [waiting, setWaiting] = useState<PlanEntry[]>([])
  const [reviewing, setReviewing] = useState(false)
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
    const items = JSON.parse(ownKey) as OwnItem[]
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

  // Local first (TYL-71): the list works without it, so a failure just
  // leaves everything at the supermarket.
  useEffect(() => {
    let live = true
    Promise.all([
      api.preferences(),
      api.localPlaces(),
      api.favoritePlaces(),
      api.localPreferences(),
    ]).then(
      // All four in: local first can work.
      ([p, places, favorites, prefer]) =>
        live &&
        setLocal({
          on: p.localFirst,
          homeZip: p.homeZip,
          places,
          favorites: new Set(favorites),
          prefer,
        }),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api])
  // The plan's ingredients (what's matched), for their categories and days.
  const localKey =
    local?.on && local.favorites.size && list
      ? [
          ...new Set(
            list.items.flatMap((i) => (i.ingredientId ? [i.ingredientId] : [])),
          ),
        ]
          .sort()
          .join(',')
      : ''
  // Load them whenever the list's ingredients change.
  useEffect(() => {
    let live = true
    if (localKey)
      api.localInputs(week, localKey.split(',')).then(
        (info) => live && setLocalInfo({ key: localKey, ...info }),
        () => {},
      )
    return () => {
      live = false
    }
  }, [api, week, localKey])

  // Remember where to buy an ingredient, showing it at once and undoing it
  // if it can't be saved.
  async function preferAt(ingredientId: string, prefer: LocalPrefer) {
    if (!local) return
    // Loaded with the list, so it's what's saved until a save here.
    if (!confirmed.current.has(ingredientId))
      confirmed.current.set(ingredientId, local.prefer[ingredientId])
    // Show where to buy it.
    const set = (p: LocalPrefer | undefined) =>
      setLocal((l) => {
        if (!l) return l
        const next = { ...l.prefer }
        if (p) next[ingredientId] = p
        else delete next[ingredientId]
        return { ...l, prefer: next }
      })
    set(prefer)
    const write = (writes.current.get(ingredientId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => api.setLocalPreference(ingredientId, prefer))
    writes.current.set(ingredientId, write)
    try {
      await write
      confirmed.current.set(ingredientId, prefer)
    } catch {
      // Only the newest change goes back, and to what's saved.
      if (writes.current.get(ingredientId) === write)
        set(confirmed.current.get(ingredientId))
      setMessage("We couldn't save where to buy that. Try again.")
    } finally {
      if (writes.current.get(ingredientId) === write)
        writes.current.delete(ingredientId)
    }
  }

  // Send any changes made offline, then bring the list up to date with the
  // plan, then reload it. Changes go first: otherwise the plan could drop an
  // item checked off offline before the check-off arrives. Without a
  // connection, the phone's copy stands.
  const refresh = useCallback(
    () =>
      flushOps(user, api.sendListOp)
        .then(async (left) => {
          setPending(left)
          const c = await api.listCost(week).catch(() => null)
          api.plan(week).then(
            (e) => setWaiting(unreviewed(e)),
            () => {},
          )
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
  // Local first (TYL-71): what favorite local places sell goes to them.
  const plan =
    local?.on && localInfo?.key === localKey && localKey
      ? planLocal(toBuy, {
          places: local.places,
          favorites: local.favorites,
          contains: localInfo.contains,
          neededBy: localInfo.neededBy,
          prefer: local.prefer,
          now: clock,
        })
      : null
  const atLocal = new Set(
    (plan?.stops ?? []).flatMap((s) => s.items.map((i) => i.id)),
  )
  const groups = new Map<string, ListItem[]>()
  for (const i of toBuy.filter((i) => !atLocal.has(i.id))) {
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
    const text = listText(
      list,
      title,
      (plan?.stops ?? []).map((s) => ({
        name: s.place.name,
        ids: s.items.map((i) => i.id),
      })),
    )
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

  // One item: its checkbox, amount, price, and the editor when open; and
  // moving it between a local place and the supermarket (TYL-71).
  const row = (i: ListItem) => {
    const price = i.ingredientId ? prices.get(i.ingredientId) : own?.items[i.id]
    const could = plan?.elsewhere.get(i.id)
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
          // Under a local place, the price is the supermarket's (TYL-71).
          <span
            className="muted small list-price"
            title={
              atLocal.has(i.id)
                ? "Your store's price; the local place's may differ"
                : undefined
            }
          >
            {atLocal.has(i.id) ? 'store ' : ''}
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
        {i.ingredientId && atLocal.has(i.id) && (
          <button
            type="button"
            className="link small"
            aria-label={`Buy ${i.name} at the supermarket`}
            onClick={() => void preferAt(i.ingredientId!, 'store')}
          >
            Supermarket
          </button>
        )}
        {i.ingredientId && could && !i.checked && (
          <button
            type="button"
            className="link small"
            aria-label={`Buy ${i.name} at ${could.place.name}`}
            onClick={() => void preferAt(i.ingredientId!, 'local')}
          >
            Local
          </button>
        )}
        {could?.why && !i.checked && (
          <p className="small muted list-local-why">{could.why}</p>
        )}
        {i.isManual && !i.checked && (
          <button
            type="button"
            className="link small"
            aria-label={`Sizes of ${i.name}`}
            aria-expanded={sizesFor === i.id}
            onClick={() => setSizesFor(sizesFor === i.id ? null : i.id)}
          >
            Size
          </button>
        )}
        {sizesFor === i.id && (
          <SizePicker
            api={api}
            name={i.name}
            picked={i.productId}
            onPick={(productId) => {
              change({ kind: 'edit', id: i.id, patch: { productId } })
              setSizesFor(null)
            }}
            onClose={() => setSizesFor(null)}
          />
        )}
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
              // A new name is another thing: its picked size no longer holds.
              const next =
                patch.name !== undefined && i.productId
                  ? { ...patch, productId: null }
                  : patch
              change({ kind: 'edit', id: i.id, patch: next })
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
    <section className="shopping-list">
      <header className="screen-head">
        <h2 className="screen-title list-title">
          Shopping list
          <small>
            {week === weekOf() ? 'this week' : `week of ${weekLabel(week)}`}
          </small>
        </h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Share list"
          onClick={() => void share()}
        >
          <Share2 size={20} strokeWidth={2.75} aria-hidden="true" />
        </button>
      </header>
      <nav className="week-nav" aria-label="Weeks">
        <Link to={`/list/${addDays(week, -7)}`} className="small">
          ← Previous
        </Link>
        <Link to={`/list/${addDays(week, 7)}`} className="small">
          Next →
        </Link>
      </nav>
      {/* The summary (TYL-149): the total, and how much is in the cart. */}
      <section className="list-summary" aria-label="Summary">
        <p className="list-summary-row">
          {cost && (
            <span>
              <strong>
                {cost.estimated || ownEstimated ? '~' : ''}
                {dollars(cost.totalCents + (own?.totalCents ?? 0))}
              </strong>
              {cost.budgetCents !== null && (
                <span className="small">
                  {' '}
                  of your {dollars(cost.budgetCents)} budget
                </span>
              )}
            </span>
          )}
          <span className="small">
            {inCart.length} of {shown.length} in the cart
          </span>
        </p>
        {!!own?.totalCents && (
          <p className="small">
            With {dollars(own.totalCents)} for items you added
          </p>
        )}
        {atLocal.size > 0 && (
          <p className="small">
            {atLocal.size} item{atLocal.size === 1 ? '' : 's'} from local places
            this week (priced at your store's prices)
          </p>
        )}
        <div className="meter" aria-hidden="true">
          <span
            style={{
              width: `${shown.length ? (inCart.length / shown.length) * 100 : 0}%`,
            }}
          />
        </div>
      </section>
      <PendingNotice entries={waiting} onReview={() => setReviewing(true)} />
      {reviewing && (
        <ReviewSheet
          api={api}
          week={week}
          entries={waiting}
          onClose={() => setReviewing(false)}
          onDone={() => {
            setReviewing(false)
            void refresh()
          }}
        />
      )}
      {cost && <WaitingChoices cost={cost} week={week} />}
      {(offline || pending > 0) && (
        <p role="status" className="muted small offline-note">
          {offline
            ? "You're offline. Changes are saved on this phone and sent when you're back."
            : `Sending ${pending} change${pending === 1 ? '' : 's'}…`}
        </p>
      )}

      <AddItem
        onAdd={(name, amount) => {
          const id = crypto.randomUUID()
          change({ kind: 'add', id, listId: list.listId, name, amount })
          // Offer the store's sizes straight away (TYL-142).
          setSizesFor(id)
        }}
      />

      {toBuy.length === 0 && (
        <p className="muted">
          {shown.length ? 'Everything’s in the cart.' : 'Nothing on the list.'}
        </p>
      )}
      {plan?.stops.map(({ place, items }) => (
        <section key={place.id} className="list-aisle list-local">
          <h3 className="kicker">{place.name}</h3>
          <p className="small muted">{openingText(place, clock)}</p>
          <ul aria-label={place.name}>{items.map(row)}</ul>
        </section>
      ))}
      {local?.on &&
        local.favorites.size === 0 &&
        nearAsheville(local.homeZip) && (
          <p className="small">
            <Link to="/local">Find markets and bakeries near you</Link> to shop
            local first.
          </p>
        )}
      {[...groups].map(([aisle, items]) => (
        <section key={aisle} className="list-aisle">
          <h3 className="kicker">{aisle}</h3>
          <ul aria-label={aisle}>{items.map(row)}</ul>
        </section>
      ))}

      {inCart.length > 0 && (
        <section className="list-aisle">
          <h3 className="kicker">In the cart ({inCart.length})</h3>
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

/** The sizes a typed item comes in at the user's store, with today's
 *  prices, to tap one (TYL-142). Nothing shows when the store doesn't know
 *  it; the item is then priced as Sous's default package. */
function SizePicker({
  api,
  name,
  picked,
  onPick,
  onClose,
}: {
  api: Pick<ListApi, 'itemSizes'>
  name: string
  picked: string | null
  onPick: (productId: string | null) => void
  onClose: () => void
}) {
  const [sizes, setSizes] = useState<SizeOption[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    api.itemSizes(name).then(
      (s) => live && setSizes(s),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [api, name])

  if (failed)
    return (
      <p className="small muted size-picker" role="status">
        We couldn't look up sizes.{' '}
        <button type="button" className="link" onClick={onClose}>
          OK
        </button>
      </p>
    )
  if (!sizes) return <p className="small muted size-picker">Finding sizes…</p>
  if (!sizes.length)
    return (
      <p className="small muted size-picker" role="status">
        Your store doesn't list sizes for this.{' '}
        <button type="button" className="link" onClick={onClose}>
          OK
        </button>
      </p>
    )
  const current = picked ?? sizes.find((o) => o.default)?.productId ?? null
  return (
    <div
      className="chips size-picker"
      role="group"
      aria-label={`Sizes of ${name}`}
    >
      {sizes.map((o) => (
        <button
          key={o.productId}
          type="button"
          className="chip"
          aria-pressed={o.productId === current}
          onClick={() => onPick(o.default && !picked ? null : o.productId)}
        >
          {o.size} · {dollars(o.cents)}
          {o.onSale ? ' (sale)' : ''}
        </button>
      ))}
    </div>
  )
}
