import type { SupabaseClient } from '@supabase/supabase-js'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CookedButton } from './Cooked.tsx'
import {
  cookedSummary,
  markCooked,
  rateCooked,
  shortDate,
  type Cooked,
} from './cooked.ts'
import { fakeCookedApi } from './cookedFake.ts'
import { History } from './History.tsx'

const ROW = {
  id: 'c1',
  recipe_id: 'r1',
  plan_entry_id: 'e1',
  cooked_on: '2026-10-12',
  scale: '2',
  rating: null,
  note: null,
}

describe('cooked meals (TYL-68)', () => {
  it('records a meal, and a second tap on an entry finds the first', async () => {
    const single = vi
      .fn()
      .mockResolvedValueOnce({ data: ROW, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { code: '23505', message: 'duplicate' },
      })
    const insert = vi.fn(() => ({ select: () => ({ single }) }))
    const inFn = vi.fn(async () => ({ data: [ROW], error: null }))
    const db = {
      from: vi.fn(() => ({ insert, select: () => ({ in: inFn }) })),
    } as unknown as SupabaseClient
    const meal = {
      recipeId: 'r1',
      planEntryId: 'e1',
      cookedOn: '2026-10-12',
      scale: 2,
    }
    const first = await markCooked(db, meal)
    expect(first).toEqual({
      id: 'c1',
      recipeId: 'r1',
      planEntryId: 'e1',
      cookedOn: '2026-10-12',
      scale: 2,
      rating: null,
      note: null,
    })
    expect(insert).toHaveBeenCalledWith({
      recipe_id: 'r1',
      plan_entry_id: 'e1',
      cooked_on: '2026-10-12',
      scale: 2,
    })
    expect(await markCooked(db, meal)).toEqual(first)
    expect(inFn).toHaveBeenCalledWith('plan_entry_id', ['e1'])
  })

  it('saves a note trimmed, and an empty one as none', async () => {
    const eq = vi.fn(async () => ({ error: null }))
    const update = vi.fn(() => ({ eq }))
    const db = { from: vi.fn(() => ({ update })) } as unknown as SupabaseClient
    await rateCooked(db, 'c1', { note: '  less salt ' })
    expect(update).toHaveBeenLastCalledWith({ note: 'less salt' })
    await rateCooked(db, 'c1', { note: '   ', rating: 'love' })
    expect(update).toHaveBeenLastCalledWith({ note: null, rating: 'love' })
  })

  it('sums up a recipe’s history with the latest note', async () => {
    const rows = [
      { ...ROW, id: 'c3', cooked_on: '2026-10-19', note: null },
      { ...ROW, id: 'c2', cooked_on: '2026-10-12', note: 'less salt' },
      { ...ROW, id: 'c1', cooked_on: '2026-10-05', note: 'too salty' },
    ]
    const order2 = vi.fn(async () => ({ data: rows, error: null }))
    const order1 = vi.fn(() => ({ order: order2 }))
    const eq = vi.fn(() => ({ order: order1 }))
    const db = {
      from: vi.fn(() => ({ select: () => ({ eq }) })),
    } as unknown as SupabaseClient
    expect(await cookedSummary(db, 'r1')).toEqual({
      times: 3,
      lastOn: '2026-10-19',
      note: { text: 'less salt', on: '2026-10-12' },
    })
  })

  it('writes dates the short way', () => {
    expect(shortDate('2026-10-12')).toBe('Oct 12')
  })
})

describe('CookedButton', () => {
  it('cooks in one tap, then rates, notes and undoes', async () => {
    const api = fakeCookedApi()
    const changes: (Cooked | null)[] = []
    render(
      <CookedButton
        api={api}
        recipeId="r1"
        title="Dal"
        planEntryId="e1"
        cookedOn="2026-10-14"
        scale={2}
        onChange={(c) => changes.push(c)}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cooked Dal' }))
    expect(api.markCooked).toHaveBeenCalledWith({
      recipeId: 'r1',
      planEntryId: 'e1',
      cookedOn: '2026-10-14',
      scale: 2,
    })
    const rate = await screen.findByRole('group', { name: 'Rate Dal' })
    await userEvent.click(
      within(rate).getByRole('button', { name: 'Would make again' }),
    )
    expect(api.rateCooked).toHaveBeenCalledWith('cooked-1', { rating: 'love' })
    expect(
      within(rate).getByRole('button', { name: 'Would make again' }),
    ).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(screen.getByRole('button', { name: 'Add a note' }))
    await userEvent.type(
      screen.getByLabelText('Note for next time'),
      'kids loved it',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save note' }))
    expect(api.rateCooked).toHaveBeenLastCalledWith('cooked-1', {
      note: 'kids loved it',
    })
    expect(
      await screen.findByRole('button', { name: 'Edit note' }),
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(api.undoCooked).toHaveBeenCalledWith('cooked-1')
    expect(
      await screen.findByRole('button', { name: 'Cooked Dal' }),
    ).toBeInTheDocument()
    expect(changes.at(-1)).toBeNull()
  })

  it('says when saving fails, and keeps the button', async () => {
    const api = fakeCookedApi()
    api.markCooked.mockRejectedValueOnce(new Error('offline'))
    render(
      <CookedButton
        api={api}
        recipeId="r1"
        title="Dal"
        cookedOn="2026-10-14"
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cooked Dal' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save")
    expect(screen.getByRole('button', { name: 'Cooked Dal' })).toBeEnabled()
  })
})

describe('History', () => {
  it('lists what was cooked, with ratings and notes', async () => {
    const api = fakeCookedApi(
      [],
      [
        {
          id: 'c1',
          recipeId: 'r1',
          planEntryId: null,
          cookedOn: '2026-10-12',
          scale: 1,
          rating: 'love',
          note: 'less salt',
          title: 'Red lentil dal',
        },
      ],
    )
    render(<History api={api} />)
    expect(
      await screen.findByRole('link', { name: 'Red lentil dal' }),
    ).toHaveAttribute('href', '/recipe/r1')
    expect(screen.getByText('less salt')).toBeInTheDocument()
    expect(screen.getByLabelText('rated love')).toBeInTheDocument()
  })

  it('says how to start when there’s nothing yet', async () => {
    render(<History api={fakeCookedApi()} />)
    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument()
  })
})
