// "Cooked it" offline (TYL-120). In the kitchen the signal is often bad, so
// marking a meal cooked, rating it and noting it work without a connection,
// like the shopping list: the change shows at once, is kept on the phone, and
// is sent in order when the phone is back online.
import type { Cooked, CookedApi, Rating } from './cooked.ts'
import { isRefused, read, write } from './list.ts'

/** One change to the user's cooked meals, as queued. */
export type CookedOp =
  | { kind: 'mark'; cooked: Cooked }
  | {
      kind: 'rate'
      id: string
      patch: { rating?: Rating | null; note?: string | null }
    }
  | { kind: 'undo'; id: string }

type Server = Pick<
  CookedApi,
  'cookedEntries' | 'markCooked' | 'rateCooked' | 'undoCooked'
>

// Under the list's prefix, so sign-out forgets them with the list.
const queueKey = (user: string) => `sous:list-cooked:${user}`
// Records made on this phone that turned out to be another's (the meal was
// already marked cooked elsewhere): this phone's id -> the record's.
const aliasKey = (user: string) => `sous:list-cooked-ids:${user}`

/** The phone's id -> record map, or empty when what's kept isn't one. */
function aliases(user: string): Record<string, string> {
  const kept: unknown = read(aliasKey(user))
  if (!kept || typeof kept !== 'object' || Array.isArray(kept)) return {}
  return Object.fromEntries(
    Object.entries(kept).filter(([, v]) => typeof v === 'string'),
  ) as Record<string, string>
}

/** The record an id this phone made stands for. */
function resolve(user: string, id: string): string {
  return aliases(user)[id] ?? id
}

const RATINGS = new Set([null, 'down', 'up', 'love'])

/** Whether something kept on the phone is a change this version can send
 *  (storage can hold anything: an older app's, or a damaged one). */
function isOp(x: unknown): x is CookedOp {
  const op = x as Partial<Record<string, unknown>> | null
  if (!op || typeof op !== 'object') return false
  if (op.kind === 'mark') {
    const c = op.cooked as Partial<Cooked> | null
    return (
      !!c &&
      typeof c.id === 'string' &&
      typeof c.recipeId === 'string' &&
      typeof c.cookedOn === 'string' &&
      typeof c.scale === 'number'
    )
  }
  if (typeof op.id !== 'string') return false
  if (op.kind === 'undo') return true
  if (op.kind !== 'rate' || !op.patch || typeof op.patch !== 'object')
    return false
  const patch = op.patch as { rating?: unknown; note?: unknown }
  return (
    (patch.rating === undefined || RATINGS.has(patch.rating as never)) &&
    (patch.note === undefined ||
      patch.note === null ||
      typeof patch.note === 'string')
  )
}

/** Changes not yet sent. */
export function pendingCooked(user: string): CookedOp[] {
  const kept: unknown = read(queueKey(user))
  return Array.isArray(kept) ? kept.filter(isOp) : []
}

/** A plan entry's records with the unsent changes applied, as the user last
 *  saw them. `pending` is the queue as it was when the records were asked
 *  for, so a change sent meanwhile still shows. */
function withPending(
  user: string,
  pending: CookedOp[],
  found: Record<string, Cooked>,
  entryIds: string[],
): Record<string, Cooked> {
  const byEntry = { ...found }
  for (const op of pending) {
    if (op.kind === 'mark') {
      const entry = op.cooked.planEntryId
      if (entry && entryIds.includes(entry) && !byEntry[entry])
        byEntry[entry] = op.cooked
      continue
    }
    // A record this phone made may be saved as another phone's.
    const id = resolve(user, op.id)
    for (const [entry, c] of Object.entries(byEntry)) {
      if (c.id !== op.id && c.id !== id) continue
      if (op.kind === 'undo') delete byEntry[entry]
      else
        byEntry[entry] = {
          ...c,
          ...(op.patch.rating !== undefined && { rating: op.patch.rating }),
          ...(op.patch.note !== undefined && {
            note: op.patch.note?.trim() || null,
          }),
        }
    }
  }
  return byEntry
}

// What browsers say when a request never reaches the server: Chrome's
// "Failed to fetch" or "network error", Firefox's "NetworkError…", Safari's
// "Load failed" (16: "The Internet connection appears to be offline").
const NETWORK =
  /failed to fetch|network ?error|load failed|network request failed|internet connection appears to be offline/i

/** Whether a failure means the server couldn't be reached: offline, a
 *  network TypeError, or supabase-js wrapping one (no code, and a browser's
 *  network message). A server error without a code is passed on. */
function unreachable(err: unknown): boolean {
  if (!navigator.onLine || err instanceof TypeError) return true
  const e = err as { code?: unknown; message?: unknown } | null
  return (
    (e?.code === '' || e?.code === undefined) &&
    typeof e?.message === 'string' &&
    NETWORK.test(e.message)
  )
}

/** Send one change; for a mark, the id of the record it's saved as. */
async function send(
  user: string,
  server: Server,
  op: CookedOp,
): Promise<string | null> {
  if (op.kind === 'mark') {
    const { id, recipeId, planEntryId, cookedOn, scale } = op.cooked
    const saved = await server.markCooked({
      id,
      recipeId,
      planEntryId,
      cookedOn,
      scale,
    })
    return saved.id
  }
  if (op.kind === 'rate')
    await server.rateCooked(resolve(user, op.id), op.patch)
  else await server.undoCooked(resolve(user, op.id))
  return null
}

// Accounts already sending on "online", and the calls to send with.
const listening = new Set<string>()
const latest = new Map<string, Server>()

// The send running for each account, if any.
const inflight = new Map<string, Promise<number>>()

/** Send the account's queued changes in order, one send at a time; a failure
 *  that may pass (offline) stops it and keeps the rest. A meal another phone
 *  already marked cooked comes back as that record: later changes go to it.
 *  Returns how many are left. */
export function flushCooked(user: string, server: Server): Promise<number> {
  const previous = inflight.get(user) ?? Promise.resolve(0)
  const next = previous
    .catch(() => 0)
    .then(async () => {
      const key = queueKey(user)
      for (;;) {
        const [first, ...rest] = pendingCooked(user)
        if (!first) return 0
        try {
          const savedId = await send(user, server, first)
          const sentId = first.kind === 'mark' ? first.cooked.id : null
          if (savedId && sentId && savedId !== sentId)
            alias(user, sentId, savedId)
          write(key, pendingCooked(user).slice(1))
        } catch (err) {
          // The database won't take it, now or later: drop it, go on.
          if (isRefused(err)) {
            write(key, pendingCooked(user).slice(1))
            continue
          }
          return rest.length + 1
        }
      }
    })
  inflight.set(user, next)
  void next.finally(() => {
    if (inflight.get(user) === next) inflight.delete(user)
  })
  return next
}

/** Note that a record this phone made is saved as another. */
function alias(user: string, from: string, to: string) {
  const key = aliasKey(user)
  write(key, { ...aliases(user), [from]: to })
}

/** Send a change now when nothing is waiting, or queue it behind what is,
 *  to keep the order. One the database refuses fails as before; one that
 *  can't be sent yet (offline) is kept and sent later. */
async function change(
  user: string,
  server: Server,
  op: CookedOp,
): Promise<string | null> {
  if (!pendingCooked(user).length) {
    try {
      return await send(user, server, op)
    } catch (err) {
      if (isRefused(err)) throw err
    }
  }
  write(queueKey(user), [...pendingCooked(user), op])
  void flushCooked(user, server)
  return null
}

/** The cooked-meal calls, working offline: each change is queued and sent in
 *  order, so it shows as saved at once and survives a reload. */
export function offlineCooked(
  user: string,
  server: Server,
  newId: () => string = () => crypto.randomUUID(),
): Server {
  // Back online: send what waited. The latest calls are the ones to use.
  latest.set(user, server)
  if (!listening.has(user)) {
    listening.add(user)
    window.addEventListener('online', () => {
      const current = latest.get(user)
      if (current) void flushCooked(user, current)
    })
  }
  return {
    // The records for these plan entries, with what's queued applied; the
    // phone's copy alone when the server can't be reached.
    cookedEntries: async (entryIds) => {
      const pending = pendingCooked(user)
      void flushCooked(user, server)
      // Can't reach the server (offline, or a bad signal): what's on the
      // phone. A server that answers with an error is passed on, so an empty
      // list isn't shown as if nothing were cooked.
      const found = await server
        .cookedEntries(entryIds)
        .catch((err: unknown) => {
          if (unreachable(err)) return {}
          throw err
        })
      return withPending(user, pending, found, entryIds)
    },
    // Mark a meal cooked, with its id made here: sent now, or queued.
    markCooked: async (meal) => {
      const cooked: Cooked = {
        id: meal.id ?? newId(),
        recipeId: meal.recipeId,
        planEntryId: meal.planEntryId ?? null,
        cookedOn: meal.cookedOn,
        scale: meal.scale ?? 1,
        rating: null,
        note: null,
      }
      // Sent now, it may come back as the record another phone made.
      const savedId = await change(user, server, { kind: 'mark', cooked })
      return savedId ? { ...cooked, id: savedId } : cooked
    },
    rateCooked: async (id, patch) => {
      await change(user, server, { kind: 'rate', id, patch })
    },
    undoCooked: async (id) => {
      await change(user, server, { kind: 'undo', id })
    },
  }
}
