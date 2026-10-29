import type { SupabaseClient } from '@supabase/supabase-js'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SavedRecipe } from './library.ts'
import { SeasonCard } from './SeasonCard.tsx'
import {
  inSeasonNow,
  loadSeasons,
  recipeInSeason,
  seasonOf,
  type Seasons,
} from './seasons.ts'

const SEASONS: Seasons = new Map([
  ['straw', { name: 'strawberries', months: [4, 5, 6] }],
  ['tom', { name: 'tomatoes', months: [6, 7, 8, 9, 10] }],
  ['squash', { name: 'butternut squash', months: [9, 10, 11, 12, 1, 2] }],
  // All year: never "in season".
  ['basil', { name: 'basil', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }],
])

const saved = (id: string, title: string, ingredientIds: string[]) =>
  ({
    id,
    title,
    sourceUrl: null,
    sourceName: null,
    sourceNote: null,
    totalMinutes: null,
    savedAt: '',
    diets: [],
    ingredients: [],
    ingredientIds,
    tags: [],
    cuisines: [],
    favorite: null,
  }) satisfies SavedRecipe

describe('seasons (TYL-70)', () => {
  it('reads the user’s seasons from the database', async () => {
    const rpc = vi.fn(async () => ({
      data: [
        { ingredient_id: 'straw', name: 'strawberries', months: [4, 5, 6] },
      ],
      error: null,
    }))
    const s = await loadSeasons({ rpc } as unknown as SupabaseClient)
    expect(rpc).toHaveBeenCalledWith('my_seasons')
    expect(s.get('straw')).toEqual({ name: 'strawberries', months: [4, 5, 6] })
  })

  it('says in or out of season, and nothing for what’s in season all year', () => {
    expect(seasonOf(SEASONS, 'straw', 5)).toBe('in')
    expect(seasonOf(SEASONS, 'straw', 11)).toBe('out')
    expect(seasonOf(SEASONS, 'basil', 5)).toBeNull()
    expect(seasonOf(SEASONS, 'unknown', 5)).toBeNull()
    expect(seasonOf(SEASONS, null, 5)).toBeNull()
  })

  it('promotes a recipe only when its seasonal produce is mostly in season', () => {
    expect(recipeInSeason(SEASONS, ['tom', 'basil', 'straw'], 6)).toEqual([
      'tomatoes',
      'strawberries',
    ])
    // In November: squash in, tomatoes and strawberries out.
    expect(recipeInSeason(SEASONS, ['tom', 'straw', 'squash'], 11)).toEqual([])
    expect(recipeInSeason(SEASONS, ['squash', 'basil'], 11)).toEqual([
      'butternut squash',
    ])
  })

  it('lists what’s in season this month', () => {
    expect(inSeasonNow(SEASONS, 6).map((s) => s.name)).toEqual([
      'strawberries',
      'tomatoes',
    ])
  })
})

describe('SeasonCard', () => {
  it('shows what’s in season, the user’s recipes for it first', async () => {
    const api = {
      seasons: vi.fn(async () => SEASONS),
      list: vi.fn(async () => [
        saved('r1', 'Tomato tart', ['tom']),
        saved('r2', 'Panzanella', ['tom', 'basil']),
      ]),
    }
    render(<SeasonCard api={api} now={new Date('2026-06-10T12:00:00')} />)
    const items = await screen.findAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      'tomatoes · Tomato tart, Panzanella',
      'strawberries',
    ])
    expect(screen.getByRole('link', { name: 'Tomato tart' })).toHaveAttribute(
      'href',
      '/recipe/r1',
    )
  })

  it('shows nothing when seasons can’t load', async () => {
    const api = {
      seasons: vi.fn(async () => {
        throw new Error('offline')
      }),
      list: vi.fn(async () => []),
    }
    const { container } = render(
      <SeasonCard api={api} now={new Date('2026-06-10T12:00:00')} />,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })
})

describe('the library’s In season filter', () => {
  it('filters with the current in-season list, not one kept from before', async () => {
    const { filterRecipes, NO_FILTER } = await import('./library.ts')
    const recipes = [saved('r1', 'A', []), saved('r2', 'B', [])]
    const on = { ...NO_FILTER, inSeason: true }
    expect(
      filterRecipes(recipes, on, new Set(['r1'])).map((r) => r.id),
    ).toEqual(['r1'])
    // A recipe saved since is in the new list, and shows.
    expect(
      filterRecipes(recipes, on, new Set(['r1', 'r2'])).map((r) => r.id),
    ).toEqual(['r1', 'r2'])
  })

  it('shows only recipes in season this month', async () => {
    const { Library } = await import('./Library.tsx')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-10T12:00:00'))
    try {
      const api = {
        list: vi.fn(async () => [
          saved('r1', 'Tomato tart', ['tom']),
          saved('r2', 'Squash soup', ['squash']),
        ]),
        save: vi.fn(),
        savePage: vi.fn(),
        saveText: vi.fn(),
        remove: vi.fn(),
        seasons: vi.fn(async () => SEASONS),
      }
      render(<Library api={api} />)
      await userEvent.click(
        await screen.findByRole('button', { name: 'In season' }),
      )
      expect(screen.getByText('Tomato tart')).toBeInTheDocument()
      expect(screen.queryByText('Squash soup')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('which seasons a zip gets (TYL-145)', () => {
  it('says so, and says when there is no zip yet', async () => {
    const { seasonsFrom } = await import('./seasons.ts')
    expect(seasonsFrom('28801')).toMatch(/North Carolina/)
    expect(seasonsFrom('43215')).toMatch(/national guide/)
    expect(seasonsFrom(null)).toMatch(/No home zip yet/)
  })
})
