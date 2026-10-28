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

/** The record an id this phone made stands for. */
function resolve(user: string, id: string): string {
  return read<Record<string, string>>(aliasKey(user))?.[id] ?? id
}

/** Changes not yet sent. */
export function pendingCooked(user: string): CookedOp[] {
  return read<CookedOp[]>(queueKey(user)) ?? []
}

/** A plan entry's records with the unsent changes applied, as the user last
 *  saw them. */
function withPending(
  user: string,
  found: Record<string, Cooked>,
  entryIds: string[],
): Record<string, Cooked> {
  const byEntry = { ...found }
  for (const op of pendingCooked(user)) {
    if (op.kind === 'mark') {
      const entry = op.cooked.planEntryId
      if (entry && entryIds.includes(entry) && !byEntry[entry])
        byEntry[entry] = op.cooked
      continue
    }
    for (const [entry, c] of Object.entries(byEntry)) {
      if (c.id !== op.id) continue
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
        const [first, ...rest] = read<CookedOp[]>(key) ?? []
        if (!first) return 0
        try {
          const savedId = await send(user, server, first)
          const sentId = first.kind === 'mark' ? first.cooked.id : null
          if (savedId && sentId && savedId !== sentId)
            alias(user, sentId, savedId)
          write(key, (read<CookedOp[]>(key) ?? []).slice(1))
        } catch (err) {
          // The database won't take it, now or later: drop it, go on.
          if (isRefused(err)) {
            write(key, (read<CookedOp[]>(key) ?? []).slice(1))
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
  write(key, { ...(read<Record<string, string>>(key) ?? {}), [from]: to })
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
    cookedEntries: async (entryIds) => {
      void flushCooked(user, server)
      const found = await server.cookedEntries(entryIds).catch(() => ({}))
      return withPending(user, found, entryIds)
    },
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
