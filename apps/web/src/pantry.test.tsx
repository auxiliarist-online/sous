import type { SupabaseClient } from '@supabase/supabase-js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  keepStaples,
  kitItems,
  kitsFor,
  setPantry,
  type PantryEntry,
} from './pantry.ts'
import { fakePantryApi, KITS } from './pantryFake.ts'
import { PantryPage } from './PantryPage.tsx'

const staple = (
  id: string,
  name: string,
  status: 'have' | 'out' = 'have',
): PantryEntry => ({
  ingredientId: id,
  name,
  status,
  kind: 'staple',
  group: id === 'oil' ? 'oils_vinegars' : 'spices',
})

const onHand = (id: string, name: string): PantryEntry => ({
  ingredientId: id,
  name,
  status: 'have',
  kind: 'on_hand',
  group: null,
})

/** The pantry page's API: the in-memory pantry, plus names and search. */
function pantryApi(options: Parameters<typeof fakePantryApi>[0] = {}) {
  return {
    ...fakePantryApi(options),
    options: vi.fn(async () => ({
      diets: [{ slug: 'vegetarian', name: 'Vegetarian' }],
      cuisines: [{ slug: 'thai', name: 'Thai' }],
    })),
    searchIngredients: vi.fn(async (q: string) =>
      [
        { id: 'spinach', name: 'spinach' },
        { id: 'feta', name: 'feta' },
      ].filter((i) => i.name.startsWith(q)),
    ),
  }
}

describe('the pantry page (TYL-134)', () => {
  it('groups pantry items by aisle with a count, and finds them by name', async () => {
    render(
      <PantryPage api={pantryApi({ entries: [staple('salt', 'salt')] })} />,
    )
    const spices = await screen.findByText('Spices & dried herbs')
    expect(spices.closest('summary')).toHaveTextContent('1 of 2')
    // A group with nothing kept starts closed; one with something, open.
    expect(spices.closest('details')).toHaveAttribute('open')
    expect(
      screen.getByText('Oils & vinegars').closest('details'),
    ).not.toHaveAttribute('open')

    await userEvent.type(screen.getByLabelText('Find a staple'), 'cum')
    expect(screen.getByRole('checkbox', { name: 'ground cumin' })).toBeVisible()
    expect(screen.queryByRole('checkbox', { name: 'salt' })).toBeNull()
    expect(screen.queryByText('Oils & vinegars')).toBeNull()
    await userEvent.clear(screen.getByLabelText('Find a staple'))
    await userEvent.type(screen.getByLabelText('Find a staple'), 'zzz')
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument()
  })

  it('keeps a staple, marks it out (onto the list) and back', async () => {
    const api = pantryApi({ entries: [staple('salt', 'salt')] })
    render(<PantryPage api={api} />)
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'ground cumin' }),
    )
    expect(api.setPantry).toHaveBeenCalledWith('cumin', 'have', 'staple')

    const out = screen.getByRole('button', { name: 'Out of salt' })
    await userEvent.click(out)
    expect(api.setPantry).toHaveBeenCalledWith('salt', 'out', 'staple')
    expect(out).toHaveAttribute('aria-pressed', 'true')
    expect(out).toHaveTextContent('Out · on your list')
    await userEvent.click(out)
    expect(api.setPantry).toHaveBeenLastCalledWith('salt', 'have', 'staple')

    await userEvent.click(screen.getByRole('checkbox', { name: 'salt' }))
    expect(api.setPantry).toHaveBeenLastCalledWith('salt', null, undefined)
    expect(screen.queryByRole('button', { name: 'Out of salt' })).toBeNull()
  })

  it('adds and removes what you have right now', async () => {
    const api = pantryApi({
      entries: [staple('salt', 'salt'), onHand('spinach', 'spinach')],
    })
    render(<PantryPage api={api} />)
    await userEvent.type(
      await screen.findByLabelText(/add to have right now/),
      'fe',
    )
    await userEvent.click(await screen.findByRole('button', { name: '+ feta' }))
    expect(api.setPantry).toHaveBeenCalledWith('feta', 'have', 'on_hand')
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove spinach' }),
    )
    expect(api.setPantry).toHaveBeenLastCalledWith('spinach', null, undefined)
    expect(
      within(screen.getByLabelText('Have right now: chosen')).getAllByRole(
        'button',
      ),
    ).toHaveLength(1)
  })

  it('waits for one save before taking another tap on the same staple', async () => {
    const api = pantryApi({ entries: [staple('salt', 'salt')] })
    let finish!: () => void
    api.setPantry.mockImplementationOnce(
      () => new Promise<void>((r) => (finish = r)),
    )
    render(<PantryPage api={api} />)
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'ground cumin' }),
    )
    const cumin = screen.getByRole('checkbox', { name: 'ground cumin' })
    expect(cumin).toBeChecked()
    expect(cumin).toBeDisabled()
    finish()
    await waitFor(() => expect(cumin).toBeEnabled())
  })

  it('puts back only what failed to save', async () => {
    const api = pantryApi({ entries: [staple('salt', 'salt')] })
    api.setPantry.mockImplementation(async (id: string) => {
      if (id === 'cumin') throw new Error('nope')
    })
    render(<PantryPage api={api} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Out of salt' }),
    )
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'ground cumin' }),
    )
    expect(
      await screen.findByText("That didn't save. Try again."),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: 'ground cumin' }),
    ).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Out of salt' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('says when the pantry can’t load', async () => {
    const api = pantryApi()
    api.pantry.mockRejectedValue(new Error('down'))
    render(<PantryPage api={api} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't load your pantry.",
    )
  })
})

describe('starter kits (TYL-135)', () => {
  it('offers Basics and your cuisines’ and diets’ kits on an empty pantry, pre-checked', async () => {
    const api = pantryApi()
    render(
      <PantryPage
        api={api}
        prefs={{ diets: ['vegetarian'], favoriteCuisines: ['thai'] }}
      />,
    )
    const thai = await screen.findByRole('group', { name: 'Thai' })
    // Olive oil is in Basics and the Thai kit: listed once, under Basics.
    expect(
      within(screen.getByRole('group', { name: 'Basics' }))
        .getAllByRole('checkbox')
        .map((c) => c.parentElement?.textContent),
    ).toEqual(['olive oil', 'salt'])
    expect(within(thai).getAllByRole('checkbox')).toHaveLength(1)
    await userEvent.click(
      within(thai).getByRole('checkbox', { name: 'fish sauce' }),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Keep these 3' }))
    expect(api.keepStaples).toHaveBeenCalledWith(['oil', 'salt', 'cumin'])
    // Kept: the kits go, and the staples show as kept.
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Thai' })).toBeNull(),
    )
    expect(screen.getByRole('checkbox', { name: 'salt' })).toBeChecked()
  })

  it('picks the kits for someone’s diets and cuisines, Basics first', () => {
    expect(
      kitsFor(KITS, { diets: ['vegetarian'], favoriteCuisines: ['thai'] }).map(
        (k) => k.kit,
      ),
    ).toEqual(['basics', 'thai', 'vegetarian'])
    // What's already kept isn't offered.
    expect(
      kitItems(
        KITS.slice(0, 1),
        [
          { id: 'salt', name: 'salt', group: 'spices' },
          { id: 'oil', name: 'olive oil', group: 'oils_vinegars' },
        ],
        new Set(['salt']),
      ),
    ).toEqual([
      {
        kit: 'basics',
        items: [{ id: 'oil', name: 'olive oil', group: 'oils_vinegars' }],
      },
    ])
  })
})

describe('pantry suggestions (TYL-136)', () => {
  it('suggests keeping what you cook with, and stops on “No thanks”', async () => {
    const api = pantryApi({
      entries: [staple('salt', 'salt')],
      suggestions: [
        { ingredientId: 'cumin', name: 'ground cumin', recipes: 4 },
        { ingredientId: 'fish', name: 'fish sauce', recipes: 3 },
      ],
    })
    render(<PantryPage api={api} />)
    expect(
      await screen.findByText(
        "You've used ground cumin in 4 recipes. Keep it as a staple?",
      ),
    ).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Keep ground cumin' }),
    )
    expect(api.setPantry).toHaveBeenCalledWith('cumin', 'have', 'staple')
    expect(screen.getByRole('checkbox', { name: 'ground cumin' })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'No thanks' }))
    expect(api.dismissSuggestion).toHaveBeenCalledWith('fish')
    expect(screen.queryByRole('list', { name: 'Suggestions' })).toBeNull()
  })
})

describe('pantry data', () => {
  it('saves an on-hand entry as "have", and several staples in one go', async () => {
    const upsert = vi.fn(async () => ({ error: null }))
    const db = { from: vi.fn(() => ({ upsert })) } as unknown as SupabaseClient
    await setPantry(db, 'u1', 'spinach', 'out', 'on_hand')
    expect(upsert).toHaveBeenCalledWith({
      user_id: 'u1',
      ingredient_id: 'spinach',
      status: 'have',
      kind: 'on_hand',
    })
    await keepStaples(db, 'u1', ['salt', 'oil'])
    expect(upsert).toHaveBeenLastCalledWith([
      { user_id: 'u1', ingredient_id: 'salt', status: 'have', kind: 'staple' },
      { user_id: 'u1', ingredient_id: 'oil', status: 'have', kind: 'staple' },
    ])
    await keepStaples(db, 'u1', [])
    expect(upsert).toHaveBeenCalledTimes(2)
  })
})
