import type { SupabaseClient } from '@supabase/supabase-js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Home, type HomeApi } from './Home.tsx'
import {
  applyOp,
  cacheList,
  cachedList,
  flushOps,
  listText,
  pendingOps,
  plannedItems,
  queueOp,
  sendOp,
  syncList,
  type ListItem,
  type ListState,
} from './list.ts'
import { ListPage, type ListApi } from './ListPage.tsx'
import { PantryPage, type PantryApi } from './PantryPage.tsx'
import type { BuyItem, PlanCost, PlanEntry } from './plan.ts'

const WEEK = '2026-10-12'

const item = (id: string, extra: Partial<ListItem> = {}): ListItem => ({
  id,
  ingredientId: `i-${id}`,
  name: id,
  amount: null,
  aisle: 'pantry',
  storeId: null,
  isManual: false,
  edited: false,
  removed: false,
  checked: false,
  position: 0,
  ...extra,
})

const state = (...items: ListItem[]): ListState => ({
  week: WEEK,
  listId: 'list-1',
  items,
})

const buy = (name: string, extra: Partial<BuyItem> = {}): BuyItem => ({
  ingredientId: `i-${name}`,
  name,
  aisle: 'pantry',
  quantity: null,
  unit: null,
  amountUnknown: false,
  soldBy: 'package',
  packageQuantity: null,
  packageUnit: null,
  packages: null,
  leftover: null,
  staple: false,
  pantry: null,
  buy: true,
  cents: null,
  estimated: false,
  priceSource: null,
  onSale: false,
  saleEnds: null,
  regularCents: null,
  ...extra,
})

const COST: PlanCost = {
  budgetCents: 6000,
  totalCents: 4800,
  estimated: true,
  unpriced: 0,
  storeName: null,
  storeId: null,
  entryCents: {},
  items: [
    buy('eggs', {
      aisle: 'dairy_eggs',
      packages: 1,
      packageQuantity: 12,
      packageUnit: 'each',
      cents: 399,
    }),
    buy('rice', {
      packages: 1,
      packageQuantity: 2,
      packageUnit: 'lb',
      cents: 300,
    }),
    buy('salt', { aisle: 'spices', staple: true, buy: false }),
    buy('mystery', { ingredientId: null }),
  ],
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('list changes', () => {
  it('checks, edits, takes off, puts back and adds', () => {
    let s = state(
      item('eggs'),
      item('rice'),
      item('towels', { isManual: true }),
    )
    s = applyOp(s, { kind: 'check', id: 'eggs', checked: true })
    s = applyOp(s, { kind: 'edit', id: 'rice', patch: { amount: '5 lb' } })
    s = applyOp(s, { kind: 'remove', id: 'towels', manual: true })
    s = applyOp(s, { kind: 'remove', id: 'rice', manual: false })
    s = applyOp(s, {
      kind: 'add',
      id: 'new',
      listId: 'list-1',
      name: 'coffee',
      amount: '1 bag',
    })
    expect(
      s.items.map((i) => [i.name, i.checked, i.amount, i.edited, i.removed]),
    ).toEqual([
      ['eggs', true, null, false, false],
      ['rice', false, '5 lb', true, true],
      ['coffee', false, '1 bag', false, false],
    ])
    s = applyOp(s, { kind: 'restore', id: 'rice' })
    expect(s.items[1].removed).toBe(false)
  })

  it('turns the plan’s buy list into list items, leaving out what’s on hand', () => {
    expect(plannedItems(COST)).toEqual([
      {
        ingredientId: 'i-eggs',
        name: 'eggs',
        amount: 'pack of 12',
        aisle: 'dairy_eggs',
        position: 0,
      },
      {
        ingredientId: 'i-rice',
        name: 'rice',
        amount: '2 lb',
        aisle: 'pantry',
        position: 1,
      },
    ])
  })

  it('writes the list as text, by aisle, without what’s in the cart', () => {
    const text = listText(
      state(
        item('eggs', { aisle: 'dairy_eggs', amount: '12' }),
        item('rice', { checked: true }),
        item('towels', { aisle: null, isManual: true }),
      ),
      'Shopping list',
    )
    expect(text).toBe(
      'Shopping list\n\nDairy & eggs\n☐ eggs (12)\n\nOther things\n☐ towels',
    )
  })
})

describe('offline queue', () => {
  it('keeps changes on the phone and sends them in order later', async () => {
    cacheList(state(item('eggs')))
    expect(cachedList(WEEK)?.items[0].name).toBe('eggs')
    queueOp({ kind: 'check', id: 'eggs', checked: true })
    queueOp({ kind: 'edit', id: 'eggs', patch: { amount: '18' } })
    const offline = vi.fn(async () => {
      throw new Error('Failed to fetch')
    })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(await flushOps(offline)).toBe(2)
    expect(pendingOps()).toHaveLength(2)

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const sent: string[] = []
    expect(
      await flushOps(async (op) => {
        sent.push(op.kind)
      }),
    ).toBe(0)
    expect(sent).toEqual(['check', 'edit'])
    expect(pendingOps()).toEqual([])
  })

  it('gives up on a change that keeps failing with a connection', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    queueOp({ kind: 'check', id: 'bad', checked: true })
    queueOp({ kind: 'check', id: 'good', checked: true })
    const sent: string[] = []
    const send = async (op: { kind: string; id?: string }) => {
      if (op.id === 'bad') throw new Error('nope')
      sent.push(op.id!)
    }
    for (let i = 0; i < 4; i++) expect(await flushOps(send)).toBe(2)
    expect(await flushOps(send)).toBe(0)
    expect(sent).toEqual(['good'])
  })
})

describe('list calls', () => {
  it('syncs the plan’s items and sends each kind of change', async () => {
    const rpc = vi.fn(async () => ({ data: 'list-1', error: null }))
    const calls: [string, unknown][] = []
    const chain = {
      update: (v: unknown) => (calls.push(['update', v]), chain),
      delete: () => (calls.push(['delete', null]), chain),
      insert: async (v: unknown) => (
        calls.push(['insert', v]),
        { error: null }
      ),
      eq: async () => ({ error: null }),
    }
    const db = { rpc, from: () => chain } as unknown as SupabaseClient
    expect(await syncList(db, WEEK, plannedItems(COST))).toBe('list-1')
    expect(rpc).toHaveBeenCalledWith('sync_shopping_list', {
      p_week: WEEK,
      p_items: [
        {
          ingredient_id: 'i-eggs',
          name: 'eggs',
          amount: 'pack of 12',
          aisle: 'dairy_eggs',
          position: 0,
        },
        {
          ingredient_id: 'i-rice',
          name: 'rice',
          amount: '2 lb',
          aisle: 'pantry',
          position: 1,
        },
      ],
    })
    await sendOp(db, { kind: 'edit', id: 'a', patch: { amount: '3' } })
    await sendOp(db, { kind: 'remove', id: 'a', manual: false })
    await sendOp(db, { kind: 'remove', id: 'b', manual: true })
    await sendOp(db, { kind: 'restore', id: 'a' })
    await sendOp(db, {
      kind: 'add',
      id: 'c',
      listId: 'list-1',
      name: 'coffee',
      amount: null,
    })
    expect(calls).toEqual([
      ['update', { amount: '3', edited: true }],
      ['update', { removed: true }],
      ['delete', null],
      ['update', { removed: false }],
      [
        'insert',
        {
          id: 'c',
          shopping_list_id: 'list-1',
          name: 'coffee',
          amount: null,
          is_manual: true,
          position: 10_000,
        },
      ],
    ])
  })
})

function listApi(
  over: Partial<ListApi> = {},
): ListApi & Record<string, ReturnType<typeof vi.fn>> {
  let current = state(
    item('eggs', {
      ingredientId: 'i-eggs',
      aisle: 'dairy_eggs',
      amount: 'pack of 12',
    }),
    item('rice', { ingredientId: 'i-rice', amount: '2 lb', position: 1 }),
  )
  return {
    planCost: vi.fn(async () => COST),
    syncList: vi.fn(async () => 'list-1'),
    loadList: vi.fn(async () => current),
    sendListOp: vi.fn(async (op) => {
      current = applyOp(current, op)
    }),
    places: vi.fn(async () => [{ id: 'market', name: 'River Arts market' }]),
    addPlace: vi.fn(async (name: string) => ({ id: 'new-place', name })),
    ...over,
  } as ListApi & Record<string, ReturnType<typeof vi.fn>>
}

describe('ListPage', () => {
  it('fills the list from the plan and checks things off', async () => {
    const api = listApi()
    render(<ListPage api={api} week={WEEK} />)
    const dairy = await screen.findByRole('list', { name: 'Dairy & eggs' })
    expect(within(dairy).getByText('eggs')).toBeInTheDocument()
    expect(within(dairy).getByText('$3.99')).toBeInTheDocument()
    expect(api.syncList).toHaveBeenCalledWith(WEEK, plannedItems(COST))
    expect(screen.getByText(/0 of 2 in the cart/)).toBeInTheDocument()
    expect(
      screen.getByText(/~\$48\.00 of your \$60\.00 budget/),
    ).toBeInTheDocument()

    await userEvent.click(within(dairy).getByRole('checkbox', { name: /eggs/ }))
    const cart = screen.getByRole('list', { name: 'In the cart' })
    expect(within(cart).getByText('eggs')).toBeInTheDocument()
    expect(screen.getByText(/1 of 2 in the cart/)).toBeInTheDocument()
    await waitFor(() =>
      expect(api.sendListOp).toHaveBeenCalledWith({
        kind: 'check',
        id: 'eggs',
        checked: true,
      }),
    )
    expect(cachedList(WEEK)?.items.find((i) => i.id === 'eggs')?.checked).toBe(
      true,
    )
  })

  it('works from the phone’s copy offline, and sends changes when back', async () => {
    cacheList(
      state(
        item('eggs', { aisle: 'dairy_eggs' }),
        item('rice', { position: 1 }),
      ),
    )
    const down = async () => {
      throw new Error('Failed to fetch')
    }
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const api = listApi({ loadList: vi.fn(down), sendListOp: vi.fn(down) })
    render(<ListPage api={api} week={WEEK} />)
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /rice/ }))
    expect(pendingOps()).toEqual([{ kind: 'check', id: 'rice', checked: true }])

    // Back online: the queued check-off reaches the server, then the list
    // reloads from it.
    let server = state(
      item('eggs', { aisle: 'dairy_eggs' }),
      item('rice', { position: 1 }),
    )
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    vi.mocked(api.sendListOp).mockImplementation(async (op) => {
      server = applyOp(server, op)
    })
    vi.mocked(api.loadList).mockImplementation(async () => server)
    window.dispatchEvent(new Event('online'))
    await waitFor(() => expect(pendingOps()).toEqual([]))
    expect(api.sendListOp).toHaveBeenLastCalledWith({
      kind: 'check',
      id: 'rice',
      checked: true,
    })
    await waitFor(() => expect(screen.queryByText(/You're offline/)).toBeNull())
    expect(screen.getByText(/1 of 2 in the cart/)).toBeInTheDocument()
  })

  it('adds anything, edits it, and takes items off and back on', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000001',
    )
    const api = listApi()
    render(<ListPage api={api} week={WEEK} />)
    await screen.findByRole('list', { name: 'Dairy & eggs' })

    await userEvent.type(screen.getByLabelText('Add an item'), 'paper towels')
    await userEvent.type(screen.getByLabelText('How much'), '1 pack')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByText('paper towels')).toBeInTheDocument()
    expect(api.sendListOp).toHaveBeenCalledWith({
      kind: 'add',
      id: '00000000-0000-4000-8000-000000000001',
      listId: 'list-1',
      name: 'paper towels',
      amount: '1 pack',
    })

    await userEvent.click(screen.getByRole('button', { name: 'Edit rice' }))
    const amount = screen.getAllByLabelText('How much')[1]
    await userEvent.clear(amount)
    await userEvent.type(amount, '5 lb')
    await userEvent.selectOptions(
      screen.getByLabelText('Where to buy it'),
      'River Arts market',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.sendListOp).toHaveBeenCalledWith({
      kind: 'edit',
      id: 'rice',
      patch: { amount: '5 lb', storeId: 'market' },
    })
    // Bought at the market, so it's listed under it.
    const market = screen.getByRole('list', { name: 'River Arts market' })
    expect(within(market).getByText('rice')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Edit eggs' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Take off the list' }),
    )
    expect(screen.queryByRole('list', { name: 'Dairy & eggs' })).toBeNull()
    await userEvent.click(screen.getByText('Taken off (1)'))
    await userEvent.click(screen.getByRole('button', { name: 'Put eggs back' }))
    expect(
      screen.getByRole('list', { name: 'Dairy & eggs' }),
    ).toBeInTheDocument()
  })

  it('adds a place of the user’s own to buy something at', async () => {
    const api = listApi()
    render(<ListPage api={api} week={WEEK} />)
    await screen.findByRole('list', { name: 'Dairy & eggs' })
    await userEvent.click(screen.getByRole('button', { name: 'Edit eggs' }))
    await userEvent.type(
      screen.getByLabelText('Or a new place'),
      'Hickory Nut Gap',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Add place' }))
    expect(api.addPlace).toHaveBeenCalledWith('Hickory Nut Gap')
    expect(screen.getByLabelText('Where to buy it')).toHaveValue('new-place')
  })

  it('shares the list as text, or copies it', async () => {
    const api = listApi()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    render(<ListPage api={api} week={WEEK} />)
    await screen.findByRole('list', { name: 'Dairy & eggs' })
    await userEvent.click(screen.getByRole('button', { name: 'Share list' }))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('☐ eggs (pack of 12)'),
    )
    expect(await screen.findByText('List copied.')).toBeInTheDocument()
  })

  it('says when there’s nothing yet', async () => {
    const api = listApi({ loadList: vi.fn(async () => null) })
    render(<ListPage api={api} week={WEEK} />)
    expect(await screen.findByText(/Nothing to buy yet/)).toBeInTheDocument()
  })
})

const entry = (id: string, day: string | null, title: string): PlanEntry => ({
  id,
  recipeId: `r-${id}`,
  title,
  scale: 1,
  recipeServings: 4,
  day,
  position: 0,
})

describe('Home', () => {
  const now = new Date('2026-10-14T17:00:00')
  const homeApi = (entries: PlanEntry[]): HomeApi => ({
    plan: vi.fn(async () => entries),
    planCost: vi.fn(async () => COST),
  })

  it('shows tonight, the days ahead, and what’s left to buy', async () => {
    render(
      <Home
        api={homeApi([
          entry('1', '2026-10-14', 'Red lentil dal'),
          entry('2', '2026-10-16', 'Fish tacos'),
          entry('3', '2026-10-13', 'Yesterday’s soup'),
        ])}
        now={now}
      />,
    )
    const tonight = await screen.findByRole('link', { name: 'Red lentil dal' })
    expect(tonight).toHaveAttribute('href', '/recipe/r-1')
    expect(screen.getByText('Fish tacos')).toBeInTheDocument()
    expect(screen.queryByText('Yesterday’s soup')).toBeNull()
    expect(
      await screen.findByText(/2 items to buy · ~\$48\.00 of \$60\.00/),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the list' })).toHaveAttribute(
      'href',
      '/list',
    )
  })

  it('leads to planning when nothing is planned', async () => {
    render(<Home api={homeApi([])} now={now} />)
    expect(await screen.findByText('Nothing planned yet.')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Plan this week' }),
    ).toHaveAttribute('href', '/plan')
  })
})

describe('PantryPage', () => {
  it('marks staples out, and other things used up', async () => {
    const api: PantryApi = {
      pantry: vi.fn(async () => [
        { ingredientId: 'oil', name: 'olive oil', status: 'out' as const },
        { ingredientId: 'rice', name: 'rice', status: 'have' as const },
      ]),
      pantryStaples: vi.fn(async () => [
        { id: 'salt', name: 'salt' },
        { id: 'oil', name: 'olive oil' },
      ]),
      setPantry: vi.fn(async () => {}),
    }
    render(<PantryPage api={api} />)
    expect(
      await screen.findByRole('button', { name: 'Out of olive oil' }),
    ).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'salt' }))
    expect(api.setPantry).toHaveBeenCalledWith('salt', 'out')
    await userEvent.click(
      screen.getByRole('button', { name: 'Out of olive oil' }),
    )
    expect(api.setPantry).toHaveBeenCalledWith('oil', null)
    await userEvent.click(
      screen.getByRole('button', { name: "I'm out of rice" }),
    )
    expect(api.setPantry).toHaveBeenCalledWith('rice', null)
  })
})
