// The week's shopping list (TYL-18): filled from the plan, edited freely, and
// usable offline in the store. Changes apply at once, are kept on the phone,
// and are sent in order when there's a connection.
import type { SupabaseClient } from '@supabase/supabase-js'
import { buyText, type PlanCost } from './plan.ts'

export interface ListItem {
  id: string
  /** Set for items from the plan; null for the user's own. */
  ingredientId: string | null
  name: string
  amount: string | null
  aisle: string | null
  storeId: string | null
  isManual: boolean
  /** Changed by the user, so the plan no longer updates it. */
  edited: boolean
  /** A plan item the user took off. */
  removed: boolean
  checked: boolean
  position: number
}

export interface ListState {
  week: string
  listId: string
  items: ListItem[]
}

/** One change to the list, as queued. */
export type ListOp =
  | { kind: 'check'; id: string; checked: boolean }
  | {
      kind: 'edit'
      id: string
      patch: { name?: string; amount?: string | null; storeId?: string | null }
    }
  | { kind: 'remove'; id: string; manual: boolean }
  | { kind: 'restore'; id: string }
  | {
      kind: 'add'
      id: string
      listId: string
      name: string
      amount: string | null
    }

/** A plan item to put on the list. */
export interface PlannedItem {
  ingredientId: string
  name: string
  amount: string | null
  aisle: string | null
  position: number
}

interface ItemRow {
  id: string
  ingredient_id: string | null
  name: string
  amount: string | null
  aisle: string | null
  store_id: string | null
  is_manual: boolean
  edited: boolean
  removed: boolean
  checked_at: string | null
  position: number
}

function fromRow(r: ItemRow): ListItem {
  return {
    id: r.id,
    ingredientId: r.ingredient_id,
    name: r.name,
    amount: r.amount,
    aisle: r.aisle,
    storeId: r.store_id,
    isManual: r.is_manual,
    edited: r.edited,
    removed: r.removed,
    checked: r.checked_at !== null,
    position: r.position,
  }
}

/** Bring the week's list in line with the plan; returns the list's id. */
export async function syncList(
  db: SupabaseClient,
  week: string,
  items: PlannedItem[],
): Promise<string> {
  const { data, error } = await db.rpc('sync_shopping_list', {
    p_week: week,
    p_items: items.map((i) => ({
      ingredient_id: i.ingredientId,
      name: i.name,
      amount: i.amount,
      aisle: i.aisle,
      position: i.position,
    })),
  })
  if (error) throw error
  return data as string
}

/** The week's list as stored, or null when there isn't one yet. */
export async function loadList(
  db: SupabaseClient,
  week: string,
): Promise<ListState | null> {
  const { data, error } = await db
    .from('shopping_lists')
    .select(
      'id, items:shopping_list_items(id, ingredient_id, name, amount, aisle, store_id, is_manual, edited, removed, checked_at, position)',
    )
    .eq('week_start', week)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as unknown as { id: string; items: ItemRow[] }
  return { week, listId: row.id, items: row.items.map(fromRow) }
}

/** Send one change to the database. */
export async function sendOp(db: SupabaseClient, op: ListOp): Promise<void> {
  const items = db.from('shopping_list_items')
  const { error } =
    op.kind === 'check'
      ? await items
          .update({ checked_at: op.checked ? new Date().toISOString() : null })
          .eq('id', op.id)
      : op.kind === 'edit'
        ? await items
            .update({
              ...(op.patch.name !== undefined && { name: op.patch.name }),
              ...(op.patch.amount !== undefined && { amount: op.patch.amount }),
              ...(op.patch.storeId !== undefined && {
                store_id: op.patch.storeId,
              }),
              edited: true,
            })
            .eq('id', op.id)
        : op.kind === 'remove'
          ? op.manual
            ? await items.delete().eq('id', op.id)
            : await items.update({ removed: true }).eq('id', op.id)
          : op.kind === 'restore'
            ? await items.update({ removed: false }).eq('id', op.id)
            : await items.insert({
                id: op.id,
                shopping_list_id: op.listId,
                name: op.name,
                amount: op.amount,
                is_manual: true,
                // The user's own items go after the plan's.
                position: 10_000,
              })
  if (error) throw error
}

/** A change, applied to the list as shown. */
export function applyOp(state: ListState, op: ListOp): ListState {
  const items = state.items
  const change = (id: string, f: (i: ListItem) => ListItem) =>
    items.map((i) => (i.id === id ? f(i) : i))
  switch (op.kind) {
    case 'check':
      return {
        ...state,
        items: change(op.id, (i) => ({ ...i, checked: op.checked })),
      }
    case 'edit':
      return {
        ...state,
        items: change(op.id, (i) => ({
          ...i,
          ...(op.patch.name !== undefined && { name: op.patch.name }),
          ...(op.patch.amount !== undefined && { amount: op.patch.amount }),
          ...(op.patch.storeId !== undefined && { storeId: op.patch.storeId }),
          edited: true,
        })),
      }
    case 'remove':
      return op.manual
        ? { ...state, items: items.filter((i) => i.id !== op.id) }
        : { ...state, items: change(op.id, (i) => ({ ...i, removed: true })) }
    case 'restore':
      return {
        ...state,
        items: change(op.id, (i) => ({ ...i, removed: false })),
      }
    case 'add':
      return {
        ...state,
        items: [
          ...items,
          {
            id: op.id,
            ingredientId: null,
            name: op.name,
            amount: op.amount,
            aisle: null,
            storeId: null,
            isManual: true,
            edited: false,
            removed: false,
            checked: false,
            position: 10_000,
          },
        ],
      }
  }
}

const listKey = (week: string) => `sous:list:${week}`
const QUEUE = 'sous:list-queue'
// A change that keeps failing while online is dropped after this many tries,
// so one bad change can't hold up the rest for good.
const MAX_TRIES = 5

/** Local storage, or nothing when the browser won't give it. */
function store(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function read<T>(key: string): T | null {
  try {
    const raw = store()?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    store()?.setItem(key, JSON.stringify(value))
  } catch {
    // Full or blocked storage: the list still works while the page is open.
  }
}

/** The list as last seen on this phone. */
export function cachedList(week: string): ListState | null {
  return read<ListState>(listKey(week))
}

export function cacheList(state: ListState): void {
  write(listKey(state.week), state)
}

interface Queued {
  op: ListOp
  tries: number
}

/** Changes not yet sent. */
export function pendingOps(): ListOp[] {
  return (read<Queued[]>(QUEUE) ?? []).map((q) => q.op)
}

/** Keep a change to send later. */
export function queueOp(op: ListOp): void {
  write(QUEUE, [...(read<Queued[]>(QUEUE) ?? []), { op, tries: 0 }])
}

/** Send queued changes in order, stopping at the first that fails (it's kept
 *  for next time). Returns how many are left. */
export async function flushOps(
  send: (op: ListOp) => Promise<void>,
): Promise<number> {
  let queue = read<Queued[]>(QUEUE) ?? []
  while (queue.length) {
    const [first, ...rest] = queue
    try {
      await send(first.op)
      queue = rest
    } catch {
      const tries = first.tries + 1
      if (tries < MAX_TRIES || !navigator.onLine) {
        // Offline, or not failing for long: keep it, and try again later.
        queue = [{ ...first, tries }, ...rest]
        write(QUEUE, queue)
        return queue.length
      }
      queue = rest // it keeps failing with a connection: give up on it
    }
    write(QUEUE, queue)
  }
  return 0
}

const AISLES: Record<string, string> = {
  produce: 'Produce',
  dairy_eggs: 'Dairy & eggs',
  meat_seafood: 'Meat & seafood',
  bakery: 'Bakery',
  pantry: 'Pantry',
  spices: 'Spices',
  frozen: 'Frozen',
  beverages: 'Drinks',
  international: 'International',
  other: 'Other',
}

/** An aisle's name, for headings. */
export function aisleName(aisle: string | null): string {
  return aisle ? (AISLES[aisle] ?? aisle) : 'Other things'
}

/** The list as plain text, to share or keep: unchecked items by aisle. */
export function listText(state: ListState, title: string): string {
  const open = state.items.filter((i) => !i.removed && !i.checked)
  const byAisle = new Map<string, ListItem[]>()
  for (const i of open) {
    const key = aisleName(i.aisle)
    byAisle.set(key, [...(byAisle.get(key) ?? []), i])
  }
  const lines = [title]
  for (const [aisle, items] of byAisle) {
    lines.push('', aisle)
    for (const i of items)
      lines.push(`☐ ${i.name}${i.amount ? ` (${i.amount})` : ''}`)
  }
  return lines.join('\n')
}

/** The user's stores and their own places, for "where to buy". */
export async function places(
  db: SupabaseClient,
  userId: string,
): Promise<{ id: string; name: string }[]> {
  const [chosen, own] = await Promise.all([
    db.from('user_stores').select('store:stores(id, name)'),
    db.from('stores').select('id, name').eq('created_by', userId),
  ])
  if (chosen.error) throw chosen.error
  if (own.error) throw own.error
  const all = [
    ...(
      (chosen.data ?? []) as unknown as {
        store: { id: string; name: string } | null
      }[]
    ).flatMap((r) => (r.store ? [r.store] : [])),
    ...((own.data ?? []) as { id: string; name: string }[]),
  ]
  return [...new Map(all.map((p) => [p.id, p])).values()]
}

/** Add a place of the user's own: a market stand, a bakery. */
export async function addPlace(
  db: SupabaseClient,
  userId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const { data, error } = await db
    .from('stores')
    .insert({ chain_slug: 'other', name, created_by: userId })
    .select('id, name')
    .single()
  if (error) throw error
  return data as { id: string; name: string }
}

/** The plan's buy list, as items for the shopping list. */
export function plannedItems(cost: PlanCost): PlannedItem[] {
  return cost.items.flatMap((i, n) =>
    i.buy && i.ingredientId
      ? [
          {
            ingredientId: i.ingredientId,
            name: i.name,
            amount: buyText(i),
            aisle: i.aisle,
            position: n,
          },
        ]
      : [],
  )
}
