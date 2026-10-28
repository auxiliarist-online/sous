import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Cooked } from './cooked.ts'
import { flushCooked, offlineCooked, pendingCooked } from './cookedQueue.ts'
import { clearListData } from './list.ts'

const OFFLINE = new TypeError('Failed to fetch')

function server(online = { value: true }) {
  const saved: Record<string, Cooked> = {}
  const down = () => {
    if (!online.value) throw OFFLINE
  }
  return {
    online,
    saved,
    cookedEntries: vi.fn(async (ids: string[]) => {
      down()
      return Object.fromEntries(
        Object.values(saved)
          .filter((c) => c.planEntryId && ids.includes(c.planEntryId))
          .map((c) => [c.planEntryId!, c]),
      )
    }),
    markCooked: vi.fn(
      async (meal: {
        id?: string
        recipeId: string
        planEntryId?: string | null
        cookedOn: string
        scale?: number
      }): Promise<Cooked> => {
        down()
        const there = Object.values(saved).find(
          (c) => c.planEntryId && c.planEntryId === meal.planEntryId,
        )
        if (there) return there
        const c: Cooked = {
          id: meal.id ?? 'server-id',
          recipeId: meal.recipeId,
          planEntryId: meal.planEntryId ?? null,
          cookedOn: meal.cookedOn,
          scale: meal.scale ?? 1,
          rating: null,
          note: null,
        }
        saved[c.id] = c
        return c
      },
    ),
    rateCooked: vi.fn(
      async (
        id: string,
        patch: { rating?: Cooked['rating']; note?: string | null },
      ) => {
        down()
        if (saved[id]) saved[id] = { ...saved[id], ...patch } as Cooked
      },
    ),
    undoCooked: vi.fn(async (id: string) => {
      down()
      delete saved[id]
    }),
  }
}

const MEAL = { recipeId: 'r1', planEntryId: 'e1', cookedOn: '2026-10-28' }

afterEach(() => clearListData())

describe('Cooked it offline (TYL-120)', () => {
  it('shows a change made offline at once, keeps it through a reload, and sends it once back online', async () => {
    const s = server({ value: false })
    const api = offlineCooked('u', s, () => 'local-1')
    const cooked = await api.markCooked(MEAL)
    expect(cooked).toMatchObject({ id: 'local-1', planEntryId: 'e1' })
    await api.rateCooked('local-1', { rating: 'love' })
    await api.rateCooked('local-1', { note: '  more garlic ' })
    expect(pendingCooked('u')).toHaveLength(3)

    // A reload, still offline: a fresh set of calls reads from the phone.
    const again = offlineCooked('u', s)
    expect((await again.cookedEntries(['e1'])).e1).toMatchObject({
      id: 'local-1',
      rating: 'love',
      note: 'more garlic',
    })

    s.online.value = true
    expect(await flushCooked('u', s)).toBe(0)
    expect(Object.keys(s.saved)).toEqual(['local-1'])
    expect(s.saved['local-1']).toMatchObject({
      rating: 'love',
      note: '  more garlic ',
    })
    expect(pendingCooked('u')).toEqual([])
    // Sent once: flushing again sends nothing more.
    const calls = s.markCooked.mock.calls.length
    await flushCooked('u', s)
    expect(s.markCooked.mock.calls.length).toBe(calls)
  })

  it('sends at once when online', async () => {
    const s = server()
    const api = offlineCooked('u', s, () => 'local-2')
    await api.markCooked(MEAL)
    expect(s.saved['local-2']).toBeDefined()
    expect(pendingCooked('u')).toEqual([])
  })

  it('counts a plan entry once: one cooked on another phone takes the change', async () => {
    const s = server({ value: false })
    const api = offlineCooked('u', s, () => 'local-3')
    await api.markCooked(MEAL)
    await api.rateCooked('local-3', { rating: 'up' })
    // Meanwhile another phone marked it cooked.
    s.saved.other = { ...MEAL, id: 'other', scale: 1, rating: null, note: null }
    s.online.value = true
    await flushCooked('u', s)
    expect(Object.keys(s.saved)).toEqual(['other'])
    expect(s.saved.other.rating).toBe('up')
  })

  it('undoes a mark that was never sent', async () => {
    const s = server({ value: false })
    const api = offlineCooked('u', s, () => 'local-4')
    await api.markCooked(MEAL)
    await api.undoCooked('local-4')
    expect(await api.cookedEntries(['e1'])).toEqual({})
    s.online.value = true
    await flushCooked('u', s)
    expect(s.saved).toEqual({})
  })

  it('still fails a change the database refuses', async () => {
    const s = server()
    s.rateCooked.mockRejectedValueOnce({ code: '42501' })
    const api = offlineCooked('u', s)
    await expect(api.rateCooked('x', { rating: 'up' })).rejects.toEqual({
      code: '42501',
    })
    expect(pendingCooked('u')).toEqual([])
  })
})
