import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  clock,
  milesBetween,
  nearAsheville,
  nextOpen,
  openingText,
  openThisWeekend,
  localInputs,
  planLocal,
  sellsCategory,
  type LocalPlace,
} from './local.ts'
import { LocalPage, type LocalApi } from './LocalPage.tsx'
import { NO_PREFERENCES } from './sous.ts'
import { Welcome, type WelcomeApi } from './Welcome.tsx'
import { fakePantryApi } from './pantryFake.ts'

const place = (over: Partial<LocalPlace> = {}): LocalPlace => ({
  id: 'p1',
  name: 'City Market',
  kind: 'farmers_market',
  address: '52 N Market St',
  town: 'Asheville',
  zip: '28801',
  latitude: 35.5975,
  longitude: -82.5513,
  sells: ['produce', 'eggs'],
  // Saturday mornings, April to November; a later winter market.
  hours: [
    { days: [6], opens: '09:00', closes: '12:00', from: '04-04', to: '11-28' },
    { days: [6], opens: '10:00', closes: '13:00', from: '12-05', to: '03-27' },
  ],
  website: null,
  sourceUrl: 'https://example.org/market',
  checkedOn: '2026-11-11',
  ...over,
})

const bakery = place({
  id: 'p2',
  name: 'Corner Bakery',
  kind: 'bakery',
  sells: ['bread'],
  latitude: 35.7,
  hours: [{ days: [1, 2, 3, 4, 5, 6], opens: '07:30', closes: '14:30' }],
})

// Wednesday, November 11, 2026, 10 am; and a Saturday in season.
const WED = new Date(2026, 10, 11, 10, 0)
const SAT = new Date(2026, 10, 14, 10, 30)

describe('opening hours (TYL-69)', () => {
  it('says when a place is next open', () => {
    expect(openingText(place(), WED)).toBe('Sat 9 am – 12 pm')
    expect(openingText(place(), SAT)).toBe('Open now until 12 pm')
    expect(openingText(place(), new Date(2026, 10, 14, 8, 0))).toBe(
      'Opens today at 9 am',
    )
    expect(openingText(place(), new Date(2026, 10, 13, 18, 0))).toBe(
      'Tomorrow 9 am – 12 pm',
    )
    expect(openingText(bakery, WED)).toBe('Open now until 2:30 pm')
  })

  it('follows the seasons, wrapping the new year', () => {
    // After the last summer Saturday, the winter market.
    const next = nextOpen(place(), new Date(2026, 10, 28, 13, 0))
    expect(next?.day).toEqual(new Date(2026, 11, 5))
    expect(next?.hours.opens).toBe('10:00')
    // January is in the winter season.
    expect(nextOpen(place(), new Date(2027, 0, 4))?.day).toEqual(
      new Date(2027, 0, 9),
    )
    // A summer-only market is back next year, on its first Thursday in
    // season (June 4, 2027 is a Friday).
    const summer = place({
      hours: [
        {
          days: [4],
          opens: '15:00',
          closes: '18:00',
          from: '06-04',
          to: '08-06',
        },
      ],
    })
    expect(openingText(summer, WED)).toBe('Back Jun 10')
  })

  it('knows the weekend and the Asheville area', () => {
    expect(openThisWeekend(place(), WED)).toBe(true)
    expect(openThisWeekend(place(), new Date(2026, 10, 14, 13, 0))).toBe(false)
    expect(nearAsheville('28801')).toBe(true)
    expect(nearAsheville('28711')).toBe(true)
    expect(nearAsheville('23451')).toBe(false)
    expect(nearAsheville(null)).toBe(false)
    expect(clock('15:30')).toBe('3:30 pm')
    expect(clock('12:00')).toBe('12 pm')
    expect(milesBetween(place(), bakery)).toBeCloseTo(7.1, 0)
  })
})

function localApi(favorites: string[] = []): LocalApi {
  return {
    localPlaces: vi.fn(async () => [place(), bakery]),
    favoritePlaces: vi.fn(async () => favorites),
    setFavoritePlace: vi.fn(async () => {}),
  }
}

describe('Local food page (TYL-69)', () => {
  it('lists places by when they open, with what they sell', async () => {
    render(<LocalPage api={localApi()} now={WED} />)
    await screen.findByText('City Market')
    const names = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
    // The bakery is open now; the market opens Saturday.
    expect(names).toEqual(['Corner Bakery', 'City Market'])
    expect(screen.getByText('Open now until 2:30 pm')).toBeInTheDocument()
    expect(screen.getByText('Sat 9 am – 12 pm')).toBeInTheDocument()
    expect(screen.getByText('Eggs')).toBeInTheDocument()
  })

  it('filters to what’s open today', async () => {
    render(<LocalPage api={localApi()} now={WED} />)
    await screen.findByText('City Market')
    await userEvent.click(screen.getByRole('button', { name: 'Open today' }))
    expect(screen.queryByText('City Market')).not.toBeInTheDocument()
    expect(screen.getByText('Corner Bakery')).toBeInTheDocument()
  })

  it('keeps favorites first, and undoes one that can’t be saved', async () => {
    const api = localApi(['p1'])
    render(<LocalPage api={api} now={WED} />)
    const fav = await screen.findByRole('button', {
      name: 'Favorite City Market',
    })
    await waitFor(() => expect(fav).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getAllByRole('heading', { level: 3 })[0]).toHaveTextContent(
      'City Market',
    )

    const other = screen.getByRole('button', { name: 'Favorite Corner Bakery' })
    await userEvent.click(other)
    expect(api.setFavoritePlace).toHaveBeenCalledWith('p2', true)
    expect(other).toHaveAttribute('aria-pressed', 'true')

    vi.mocked(api.setFavoritePlace).mockRejectedValueOnce(new Error('down'))
    await userEvent.click(fav)
    expect(
      await screen.findByText("We couldn't save that favorite. Try again."),
    ).toBeInTheDocument()
    expect(fav).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows favorites alone, and says when there are none', async () => {
    render(<LocalPage api={localApi()} now={WED} />)
    await screen.findByText('City Market')
    await userEvent.click(screen.getByRole('button', { name: 'Favorites' }))
    expect(screen.getByText(/No favorites yet/)).toBeInTheDocument()
  })

  it('links each place to directions and its source', async () => {
    render(<LocalPage api={localApi()} now={WED} />)
    const card = (await screen.findByText('City Market')).closest('li')!
    expect(
      within(card).getByRole('link', { name: '52 N Market St' }),
    ).toHaveAttribute(
      'href',
      expect.stringContaining('maps/search/?api=1&query=City%20Market'),
    )
    expect(within(card).getByRole('link', { name: 'Source' })).toHaveAttribute(
      'href',
      'https://example.org/market',
    )
    expect(within(card).getByText(/Checked Nov 11, 2026/)).toBeInTheDocument()
  })

  it('says when the places can’t load', async () => {
    const api = localApi()
    vi.mocked(api.localPlaces).mockRejectedValue(new Error('down'))
    render(<LocalPage api={api} now={WED} />)
    expect(
      await screen.findByText("We couldn't load the local places."),
    ).toBeInTheDocument()
  })
})

describe('Setup’s local places (TYL-69)', () => {
  function welcomeApi() {
    return {
      ...localApi(),
      preferences: vi.fn(async () => NO_PREFERENCES),
      savePreferences: vi.fn(async () => {}),
      options: vi.fn(async () => ({ diets: [], cuisines: [] })),
      searchIngredients: vi.fn(async () => []),
      storesNear: vi.fn(async () => []),
      myStore: vi.fn(async () => null),
      chooseStore: vi.fn(),
      clearStore: vi.fn(),
      ...fakePantryApi(),
    } as unknown as WelcomeApi & Record<string, ReturnType<typeof vi.fn>>
  }

  it('offers Asheville-area favorites and keeps the ones picked', async () => {
    const api = welcomeApi()
    render(
      <Welcome
        api={api}
        initial={{ ...NO_PREFERENCES, homeZip: '28801' }}
        onDone={vi.fn()}
      />,
    )
    for (let i = 0; i < 5; i++)
      await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await userEvent.click(
      await screen.findByRole('button', { name: 'City Market' }),
    )
    await userEvent.click(screen.getByRole('button', { name: /Skip the rest/ }))
    await waitFor(() => expect(api.savePreferences).toHaveBeenCalled())
    expect(api.setFavoritePlace).toHaveBeenCalledWith('p1', true)
    expect(api.setFavoritePlace).toHaveBeenCalledTimes(1)
  })

  it('doesn’t offer them elsewhere', async () => {
    const api = welcomeApi()
    render(
      <Welcome
        api={api}
        initial={{ ...NO_PREFERENCES, homeZip: '23451' }}
        onDone={vi.fn()}
      />,
    )
    for (let i = 0; i < 5; i++)
      await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await screen.findByText(/Step 6 of 7/)
    expect(screen.queryByText('Local places you like')).not.toBeInTheDocument()
  })
})

describe('local first matching (TYL-71)', () => {
  const coop = place({
    id: 'c1',
    name: 'Co-op',
    kind: 'co_op',
    sells: ['groceries'],
    hours: [{ days: [0, 1, 2, 3, 4, 5, 6], opens: '08:00', closes: '20:00' }],
  })
  const it_ = (
    id: string,
    name: string,
    aisle: string | null,
    storeId: string | null = null,
  ) => ({ id, ingredientId: `i-${id}`, name, aisle, storeId })

  it('sorts items by what each favorite sells', () => {
    expect(sellsCategory({ name: 'eggs', aisle: 'dairy_eggs' }, ['egg'])).toBe(
      'eggs',
    )
    expect(
      sellsCategory({ name: 'butter', aisle: 'dairy_eggs' }, ['dairy']),
    ).toBe('dairy')
    expect(
      sellsCategory({ name: 'trout', aisle: 'meat_seafood' }, ['fish']),
    ).toBe('seafood')
    expect(sellsCategory({ name: 'sourdough', aisle: 'bakery' })).toBe('bread')
    expect(sellsCategory({ name: 'local honey', aisle: 'pantry' })).toBe(
      'honey',
    )
    expect(sellsCategory({ name: 'cumin', aisle: 'spices' })).toBeNull()

    const plan = planLocal(
      [
        it_('kale', 'kale', 'produce'),
        it_('bread', 'sourdough', 'bakery'),
        it_('cumin', 'cumin', 'spices'),
        // Put somewhere by the user: that stands.
        it_('leek', 'leeks', 'produce', 'my-stand'),
      ],
      {
        places: [place(), bakery, coop],
        favorites: new Set(['p1', 'p2']),
        contains: {},
        neededBy: {},
        prefer: {},
        now: WED,
      },
    )
    // The bakery is open now, the market Saturday.
    expect(
      plan.stops.map((s) => [s.place.name, s.items.map((i) => i.id)]),
    ).toEqual([
      ['Corner Bakery', ['bread']],
      ['City Market', ['kale']],
    ])
  })

  it('prefers a specialist to a full grocery opening as soon', () => {
    const plan = planLocal([it_('bread', 'sourdough', 'bakery')], {
      places: [bakery, coop],
      favorites: new Set(['p2', 'c1']),
      contains: {},
      neededBy: {},
      prefer: {},
      now: new Date(2026, 10, 11, 7, 0),
    })
    // The co-op opens at 8, the bakery at 7:30.
    expect(plan.stops[0].place.name).toBe('Corner Bakery')
  })

  it('keeps an item back for a meal before the market, or when asked', () => {
    const args = {
      places: [place()],
      favorites: new Set(['p1']),
      contains: {},
      now: WED,
    }
    const kale = it_('kale', 'kale', 'produce')
    const late = planLocal([kale], {
      ...args,
      neededBy: { 'i-kale': { day: '2026-11-12', meal: null } },
      prefer: {},
    })
    expect(late.stops).toEqual([])
    expect(late.elsewhere.get('kale')?.why).toBe(
      "City Market opens Sat; it's needed Thu",
    )
    // Saturday breakfast is before the market opens at 9; Saturday dinner
    // isn't.
    const sat = (meal: string) =>
      planLocal([kale], {
        ...args,
        neededBy: { 'i-kale': { day: '2026-11-14', meal } },
        prefer: {},
      })
    expect(sat('breakfast').elsewhere.get('kale')?.why).toBe(
      "City Market opens Sat; it's needed Sat",
    )
    expect(sat('dinner').stops).toHaveLength(1)
    // A meal day already past sets no deadline.
    expect(
      planLocal([kale], {
        ...args,
        neededBy: { 'i-kale': { day: '2026-11-09', meal: null } },
        prefer: {},
      }).stops,
    ).toHaveLength(1)
    const kept = planLocal([kale], {
      ...args,
      neededBy: {},
      prefer: { 'i-kale': 'store' },
    })
    expect(kept.stops).toEqual([])
    expect(kept.elsewhere.get('kale')).toEqual({ place: place(), why: null })
    expect(
      planLocal([kale], {
        ...args,
        neededBy: { 'i-kale': { day: '2026-11-12', meal: null } },
        prefer: { 'i-kale': 'local' },
      }).stops,
    ).toHaveLength(1)
  })
})

describe('when a meal needs it (TYL-71)', () => {
  // A stand-in for the two reads localInputs makes.
  function fakeDb(plan: unknown) {
    const result = (data: unknown) => ({
      in: async () => ({ data, error: null }),
      eq: () => ({ maybeSingle: async () => ({ data: plan, error: null }) }),
    })
    return {
      from: (table: string) => ({
        select: () =>
          result(
            table === 'ingredients' ? [{ id: 'i-kale', contains: [] }] : [],
          ),
      }),
    } as unknown as Parameters<typeof localInputs>[0]
  }

  it('takes the first meal, and only the option the week buys', async () => {
    const line = (line_no: number, ingredient_id: string) => ({
      line_no,
      ingredient_id,
      is_optional: false,
    })
    const db = fakeDb({
      // Almond milk or oat milk: the week chose oat milk.
      choices: { 'i-almond,i-oat': 'i-oat' },
      entries: [
        {
          planned_for: '2026-11-13',
          meal: 'dinner',
          recipe: { lines: [line(0, 'i-kale')] },
        },
        {
          planned_for: '2026-11-13',
          meal: 'lunch',
          recipe: {
            lines: [line(0, 'i-kale'), line(1, 'i-almond'), line(1, 'i-oat')],
          },
        },
        {
          planned_for: null,
          meal: null,
          recipe: { lines: [line(0, 'i-leek')] },
        },
      ],
    })
    const { neededBy, contains } = await localInputs(db, '2026-11-09', [
      'i-kale',
    ])
    expect(contains).toEqual({ 'i-kale': [] })
    expect(neededBy).toEqual({
      'i-kale': { day: '2026-11-13', meal: 'lunch' },
      'i-oat': { day: '2026-11-13', meal: 'lunch' },
    })
  })
})

describe('the Local page while it’s open (TYL-69)', () => {
  it('keeps a heart tapped while favorites load', async () => {
    let answer: (ids: string[]) => void = () => {}
    const api = {
      ...localApi(),
      favoritePlaces: vi.fn(
        () => new Promise<string[]>((resolve) => (answer = resolve)),
      ),
    }
    render(<LocalPage api={api} now={WED} />)
    const heart = await screen.findByRole('button', {
      name: 'Favorite Corner Bakery',
    })
    await userEvent.click(heart)
    answer(['p1'])
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Favorite City Market' }),
      ).toHaveAttribute('aria-pressed', 'true'),
    )
    expect(heart).toHaveAttribute('aria-pressed', 'true')
  })

  it('saves a place’s changes in the order they were made', async () => {
    const order: string[] = []
    let first: () => void = () => {}
    const api = {
      ...localApi(),
      setFavoritePlace: vi.fn(async (_id: string, on: boolean) => {
        if (on) await new Promise<void>((resolve) => (first = resolve))
        order.push(on ? 'add' : 'remove')
      }),
    }
    render(<LocalPage api={api} now={WED} />)
    const heart = await screen.findByRole('button', {
      name: 'Favorite Corner Bakery',
    })
    await userEvent.click(heart)
    await userEvent.click(heart)
    first()
    await waitFor(() => expect(order).toEqual(['add', 'remove']))
    expect(heart).toHaveAttribute('aria-pressed', 'false')
  })

  it('goes back to what’s saved when queued saves all fail', async () => {
    let fail: () => void = () => {}
    const api = {
      ...localApi(),
      setFavoritePlace: vi.fn(
        () =>
          new Promise<void>(
            (_, reject) => (fail = () => reject(new Error('down'))),
          ),
      ),
    }
    render(<LocalPage api={api} now={WED} />)
    const heart = await screen.findByRole('button', {
      name: 'Favorite Corner Bakery',
    })
    await userEvent.click(heart) // add
    await userEvent.click(heart) // and take back
    fail() // the add fails; the take-back then runs, and fails too
    await waitFor(() => expect(api.setFavoritePlace).toHaveBeenCalledTimes(2))
    fail()
    expect(
      await screen.findByText("We couldn't save that favorite. Try again."),
    ).toBeInTheDocument()
    // Never saved: not a favorite.
    expect(heart).toHaveAttribute('aria-pressed', 'false')
  })
})
