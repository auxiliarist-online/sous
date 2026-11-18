import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LocalPlace } from './local.ts'
import { SeasonalPage, type SeasonalApi } from './SeasonalPage.tsx'
import { comingNext, monthsText, type Seasons } from './seasons.ts'

const SEASONS: Seasons = new Map([
  ['i-squash', { name: 'winter squash', months: [9, 10, 11, 12, 1, 2] }],
  ['i-kale', { name: 'kale', months: [10, 11, 12] }],
  ['i-peas', { name: 'peas', months: [12, 1] }],
  [
    'i-onion',
    { name: 'onions', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  ],
])
// November 18, 2026.
const NOV = new Date(2026, 10, 18, 10, 0)

const market: LocalPlace = {
  id: 'm1',
  name: 'City Market',
  kind: 'farmers_market',
  address: '52 N Market St',
  town: 'Asheville',
  zip: '28801',
  latitude: 35.6,
  longitude: -82.55,
  sells: ['produce', 'eggs'],
  hours: [{ days: [6], opens: '09:00', closes: '12:00' }],
  website: null,
  sourceUrl: 'https://example.org',
  checkedOn: '2026-11-11',
}

function api(favorites: string[] = ['m1']): SeasonalApi {
  return {
    seasons: vi.fn(async () => SEASONS),
    seasonalRecipes: vi.fn(
      async () =>
        new Map([
          [
            'i-squash',
            [
              { id: 'r1', title: 'Squash tacos', saved: true },
              { id: 'r2', title: 'Squash soup', saved: false },
            ],
          ],
        ]),
    ),
    localPlaces: vi.fn(async () => [market]),
    favoritePlaces: vi.fn(async () => favorites),
  }
}

describe('seasons in words (TYL-90)', () => {
  it('says a season as month ranges, across the new year', () => {
    expect(monthsText([6, 7, 8, 9])).toBe('Jun–Sep')
    expect(monthsText([11, 12, 1, 2])).toBe('Nov–Feb')
    expect(monthsText([4, 5, 9, 10])).toBe('Apr–May, Sep–Oct')
    expect(monthsText([7])).toBe('Jul')
    expect(monthsText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe('all year')
  })

  it('knows what’s coming next month', () => {
    expect(comingNext(SEASONS, 11).map((i) => i.name)).toEqual(['peas'])
  })
})

describe('the Seasonal page (TYL-90)', () => {
  it('lists what’s in season with recipes, what’s next, and your markets', async () => {
    const a = api()
    render(<SeasonalPage api={a} now={NOV} />)
    const squash = (
      await screen.findByRole('heading', { name: 'winter squash' })
    ).closest('li')!
    expect(within(squash).getByText('In season Sep–Feb')).toBeInTheDocument()
    expect(
      within(squash).getByRole('link', { name: 'Squash tacos' }),
    ).toHaveAttribute('href', '/recipe/r1')
    expect(within(squash).getByText('Yours')).toBeInTheDocument()
    // Onions are in season all year: not news.
    expect(screen.queryByRole('heading', { name: 'onions' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'kale' })).toBeInTheDocument()
    expect(screen.getByText('peas')).toBeInTheDocument()
    expect(
      await screen.findByText(/City Market \(Sat 9 am – 12 pm\)/),
    ).toBeInTheDocument()
    expect(a.seasonalRecipes).toHaveBeenCalledWith(['i-kale', 'i-squash'])
  })

  it('points to the directory without favorite markets', async () => {
    render(<SeasonalPage api={api([])} now={NOV} />)
    expect(
      await screen.findByRole('link', { name: 'Find markets near you' }),
    ).toHaveAttribute('href', '/local')
  })
})
