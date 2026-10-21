import type { SupabaseClient } from '@supabase/supabase-js'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CookedButton } from './Cooked.tsx'
import { fakeCookedApi } from './cookedFake.ts'
import { FavoriteControl } from './Favorite.tsx'
import { addFavorite, recentRecipes, setFavorite } from './favorites.ts'
import { filterRecipes, NO_FILTER, type SavedRecipe } from './library.ts'
import { isDue, mainProteins, varietyNotes, weeksAgo } from './variety.ts'

describe('variety (TYL-66)', () => {
  it('finds a recipe’s main proteins at the meat and seafood counter', () => {
    expect(
      mainProteins([
        { aisle: 'meat_seafood', contains: ['poultry'] },
        // Broth from the pantry doesn't make it a chicken dinner…
        { aisle: 'pantry', contains: ['poultry'] },
        { aisle: 'international', contains: ['fish'] },
        // …and pork is pork, not red meat.
        { aisle: 'meat_seafood', contains: ['meat', 'pork'] },
      ]),
    ).toEqual(['poultry', 'pork'])
    expect(mainProteins([{ aisle: 'produce', contains: [] }])).toEqual([])
  })

  it('notes a protein more than twice, and a cuisine three days running', () => {
    const e = (day: string | null, proteins: string[], cuisines: string[]) => ({
      day,
      proteins,
      cuisines,
    })
    expect(
      varietyNotes([
        e('2026-10-12', ['poultry'], ['Italian']),
        e('2026-10-13', ['poultry'], ['Italian']),
        e('2026-10-14', [], ['Italian']),
        e(null, ['poultry'], []),
      ]),
    ).toEqual(['3 dinners with poultry this week', 'Italian 3 days in a row'])
    // Not in a row: a day between.
    expect(
      varietyNotes([
        e('2026-10-12', [], ['Italian']),
        e('2026-10-13', [], ['Italian']),
        e('2026-10-15', [], ['Italian']),
      ]),
    ).toEqual([])
  })

  it('counts weeks back and when a favorite is due', () => {
    expect(weeksAgo('2026-10-19', '2026-10-19')).toBe(0)
    expect(weeksAgo('2026-10-15', '2026-10-19')).toBe(1)
    expect(weeksAgo('2026-10-05', '2026-10-19')).toBe(2)
    expect(isDue('weekly', 1)).toBe(true)
    expect(isDue('biweekly', 1)).toBe(false)
    expect(isDue('monthly', 4)).toBe(true)
    expect(isDue('monthly', undefined)).toBe(true)
  })

  it('reads what was planned or cooked lately, the latest of each', async () => {
    const planned = {
      data: [
        { recipe_id: 'a', plan: { week_start: '2026-10-05' } },
        { recipe_id: 'a', plan: { week_start: '2026-10-12' } },
      ],
      error: null,
    }
    const cooked = {
      data: [{ recipe_id: 'b', cooked_on: '2026-10-20' }],
      error: null,
    }
    const chain = (result: unknown) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'gte', 'lte', 'lt']) c[m] = () => c
      c.then = (f: (r: unknown) => unknown) => Promise.resolve(result).then(f)
      return c
    }
    const db = {
      from: vi.fn((t: string) =>
        chain(t === 'meal_plan_entries' ? planned : cooked),
      ),
    } as unknown as SupabaseClient
    expect(await recentRecipes(db, '2026-10-19', 5)).toEqual({ a: 1, b: 0 })
  })

  it('saves a favorite, or stops one; a ❤️ keeps an existing rhythm', async () => {
    const upsert = vi.fn(async () => ({ error: null }))
    const eq = vi.fn(async () => ({ error: null }))
    const db = {
      from: vi.fn(() => ({ upsert, delete: () => ({ eq }) })),
    } as unknown as SupabaseClient
    await setFavorite(db, 'r1', 'weekly')
    expect(upsert).toHaveBeenLastCalledWith(
      { recipe_id: 'r1', frequency: 'weekly' },
      { onConflict: 'user_id,recipe_id' },
    )
    await setFavorite(db, 'r1', null)
    expect(eq).toHaveBeenCalledWith('recipe_id', 'r1')
    await addFavorite(db, 'r1')
    expect(upsert).toHaveBeenLastCalledWith(
      { recipe_id: 'r1' },
      { onConflict: 'user_id,recipe_id', ignoreDuplicates: true },
    )
  })

  it('filters the library to favorites', () => {
    const r = (id: string, favorite: SavedRecipe['favorite']) =>
      ({
        id,
        title: id,
        sourceUrl: null,
        sourceName: null,
        sourceNote: null,
        totalMinutes: null,
        savedAt: '',
        diets: [],
        ingredients: [],
        tags: [],
        cuisines: [],
        favorite,
      }) satisfies SavedRecipe
    expect(
      filterRecipes([r('a', 'weekly'), r('b', null)], {
        ...NO_FILTER,
        favorites: true,
      }).map((x) => x.id),
    ).toEqual(['a'])
  })
})

describe('FavoriteControl', () => {
  it('hearts a recipe, then sets how often it comes back', async () => {
    const onChange = vi.fn(async () => {})
    const { rerender } = render(
      <FavoriteControl title="Dal" favorite={null} onChange={onChange} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Favorite Dal' }))
    expect(onChange).toHaveBeenLastCalledWith('biweekly')
    rerender(
      <FavoriteControl title="Dal" favorite="biweekly" onChange={onChange} />,
    )
    await userEvent.selectOptions(
      screen.getByLabelText('How often Dal comes back'),
      'monthly',
    )
    expect(onChange).toHaveBeenLastCalledWith('monthly')
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Dal from favorites' }),
    )
    expect(onChange).toHaveBeenLastCalledWith(null)
  })
})

describe('a ❤️ after cooking', () => {
  it('offers to make it a favorite', async () => {
    const api = fakeCookedApi()
    render(
      <CookedButton
        api={api}
        recipeId="r1"
        title="Dal"
        cookedOn="2026-10-14"
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cooked Dal' }))
    expect(
      screen.queryByRole('button', { name: 'Add to favorites' }),
    ).toBeNull()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Would make again' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Add to favorites' }),
    )
    expect(api.addFavorite).toHaveBeenCalledWith('r1')
    expect(await screen.findByText('In your favorites')).toBeInTheDocument()
  })
})
