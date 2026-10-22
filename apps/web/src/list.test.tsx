import type { SupabaseClient } from '@supabase/supabase-js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Home, type HomeApi } from './Home.tsx'
import {
  applyOp,
  cacheList,
  clearListData,
  cachedList,
  flushOps,
  isRefused,
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
import { fakeCookedApi } from './cookedFake.ts'

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
  storeStatus: 'not_chosen' as const,
  homeZip: null,
  entryCents: {},
  choices: [],
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
    cacheList('u', state(item('eggs')))
    expect(cachedList('u', WEEK)?.items[0].name).toBe('eggs')
    queueOp('u', { kind: 'check', id: 'eggs', checked: true })
    queueOp('u', { kind: 'edit', id: 'eggs', patch: { amount: '18' } })
    const offline = vi.fn(async () => {
      throw new Error('Failed to fetch')
    })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(await flushOps('u', offline)).toBe(2)
    expect(pendingOps('u')).toHaveLength(2)

    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const sent: string[] = []
    expect(
      await flushOps('u', async (op) => {
        sent.push(op.kind)
      }),
    ).toBe(0)
    expect(sent).toEqual(['check', 'edit'])
    expect(pendingOps('u')).toEqual([])
  })

  it('keeps a change through passing failures, and drops only a refused one', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    queueOp('u', { kind: 'check', id: 'bad', checked: true })
    queueOp('u', { kind: 'check', id: 'flaky', checked: true })
    queueOp('u', { kind: 'check', id: 'good', checked: true })
    let flakyLeft = 6
    const sent: string[] = []
    const send = async (op: { kind: string; id?: string }) => {
      if (op.id === 'bad')
        throw { code: '42501', message: 'row-level security' }
      if (op.id === 'flaky' && flakyLeft-- > 0)
        throw new Error('Failed to fetch')
      sent.push(op.id!)
    }
    // The refused change goes at once; the flaky one stays through six
    // failures (more than any retry limit) and is sent in the end.
    for (let i = 0; i < 6; i++) expect(await flushOps('u', send)).toBe(2)
    expect(await flushOps('u', send)).toBe(0)
    expect(sent).toEqual(['flaky', 'good'])
  })

  it('tells refused changes from passing failures', () => {
    expect(isRefused({ code: '42501' })).toBe(true)
    expect(isRefused({ code: '23505' })).toBe(true)
    expect(isRefused({ code: 'PGRST102' })).toBe(true) // a malformed body
    // A schema-cache miss clears after a migration or cache refresh.
    expect(isRefused({ code: 'PGRST204' })).toBe(false)
    expect(isRefused({ code: 'PGRST205' })).toBe(false)
    expect(isRefused({ code: '57014' })).toBe(false) // a timeout
    expect(isRefused(new TypeError('Failed to fetch'))).toBe(false)
    expect(isRefused(null)).toBe(false)
  })
})

describe('sending changes', () => {
  it('sends one at a time, so overlapping sends don’t repeat a change', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const sent: string[] = []
    let release!: () => void
    const slow = new Promise<void>((r) => (release = r))
    const send = vi.fn(async (op: { kind: string; id?: string }) => {
      sent.push(op.id!)
      if (op.id === 'a') await slow
    })
    queueOp('u', { kind: 'check', id: 'a', checked: true })
    const first = flushOps('u', send)
    // Queued while the first send is out; a second flush starts too.
    queueOp('u', { kind: 'check', id: 'b', checked: true })
    const second = flushOps('u', send)
    release()
    expect(await first).toBe(0)
    expect(await second).toBe(0)
    expect(sent).toEqual(['a', 'b'])
    expect(pendingOps('u')).toEqual([])
  })

  it('shows a queued add once, even when the server already has it', () => {
    const add = {
      kind: 'add' as const,
      id: 'c',
      listId: 'list-1',
      name: 'coffee',
      amount: null,
    }
    const once = applyOp(state(item('eggs')), add)
    expect(applyOp(once, add).items).toHaveLength(2)
  })
})

describe('per account', () => {
  it('keeps each account’s list and changes apart, and forgets them on sign-out', () => {
    cacheList('a', state(item('eggs')))
    queueOp('a', { kind: 'check', id: 'eggs', checked: true })
    expect(cachedList('b', WEEK)).toBeNull()
    expect(pendingOps('b')).toEqual([])
    localStorage.setItem('other', 'kept')
    clearListData()
    expect(cachedList('a', WEEK)).toBeNull()
    expect(pendingOps('a')).toEqual([])
    expect(localStorage.getItem('other')).toBe('kept')
  })
})

describe('list calls', () => {
  it('syncs the plan’s items and sends each kind of change', async () => {
    const rpc = vi.fn(async () => ({ data: 'list-1', error: null }))
    const calls: unknown[][] = []
    const chain = {
      update: (v: unknown) => (calls.push(['update', v]), chain),
      delete: () => (calls.push(['delete', null]), chain),
      upsert: async (v: unknown, o: unknown) => (
        calls.push(['upsert', v, o]),
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
        'upsert',
        {
          id: 'c',
          shopping_list_id: 'list-1',
          name: 'coffee',
          amount: null,
          is_manual: true,
          position: 10_000,
        },
        // Sent twice (a reply lost on the way back), it's still one item.
        { onConflict: 'id', ignoreDuplicates: true },
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
    seasons: vi.fn(async () => new Map()),
    ...over,
  } as ListApi & Record<string, ReturnType<typeof vi.fn>>
}

describe('ListPage', () => {
  it('marks what’s in season that week (TYL-70)', async () => {
    const api = listApi({
      seasons: vi.fn(
        async () => new Map([['i-eggs', { name: 'eggs', months: [10] }]]),
      ),
    })
    render(<ListPage api={api} week={WEEK} user="u" />)
    const dairy = await screen.findByRole('list', { name: 'Dairy & eggs' })
    expect(await within(dairy).findByText('· in season')).toBeInTheDocument()
  })

  it('fills the list from the plan and checks things off', async () => {
    const api = listApi()
    render(<ListPage api={api} week={WEEK} user="u" />)
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
    expect(
      cachedList('u', WEEK)?.items.find((i) => i.id === 'eggs')?.checked,
    ).toBe(true)
  })

  it('works from the phone’s copy offline, and sends changes when back', async () => {
    cacheList(
      'u',
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
    render(<ListPage api={api} week={WEEK} user="u" />)
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /rice/ }))
    expect(pendingOps('u')).toEqual([
      { kind: 'check', id: 'rice', checked: true },
    ])

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
    await waitFor(() => expect(pendingOps('u')).toEqual([]))
    expect(api.sendListOp).toHaveBeenLastCalledWith({
      kind: 'check',
      id: 'rice',
      checked: true,
    })
    await waitFor(() => expect(screen.queryByText(/You're offline/)).toBeNull())
    expect(screen.getByText(/1 of 2 in the cart/)).toBeInTheDocument()
  })

  it('says what waits for a choice on the plan (TYL-98)', async () => {
    const api = listApi({
      planCost: vi.fn(async () => ({
        ...COST,
        choices: [
          {
            key: 'almond,milk',
            options: [
              { ingredientId: 'almond', name: 'almond milk', cents: 349 },
              { ingredientId: 'milk', name: 'milk', cents: 429 },
            ],
            chosen: null,
            reason: 'pending' as const,
            recipes: 1,
            fits: true,
          },
        ],
      })),
    })
    render(<ListPage api={api} week={WEEK} user="u" />)
    expect(
      await screen.findByText(/Not on the list until you choose/),
    ).toHaveTextContent('almond milk or milk')
    expect(
      screen.getByRole('link', { name: 'Choose on your plan' }),
    ).toHaveAttribute('href', `/plan/${WEEK}`)
  })

  it('adds anything, edits it, and takes items off and back on', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000001',
    )
    const api = listApi()
    render(<ListPage api={api} week={WEEK} user="u" />)
    await screen.findByRole('list', { name: 'Dairy & eggs' })

    await userEvent.type(screen.getByLabelText('Add an item'), 'paper towels')
    await userEvent.type(screen.getByLabelText('Amount to buy'), '1 pack')
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
    const amount = screen.getByLabelText('Amount to buy (like 2 lb)')
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
    render(<ListPage api={api} week={WEEK} user="u" />)
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
    render(<ListPage api={api} week={WEEK} user="u" />)
    await screen.findByRole('list', { name: 'Dairy & eggs' })
    await userEvent.click(screen.getByRole('button', { name: 'Share list' }))
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('☐ eggs (pack of 12)'),
    )
    expect(await screen.findByText('List copied.')).toBeInTheDocument()
  })

  it('sends offline changes before syncing with the plan, and holds the sync while any are left', async () => {
    const order: string[] = []
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    queueOp('u', { kind: 'check', id: 'rice', checked: true })
    const api = listApi({
      sendListOp: vi.fn(async () => {
        order.push('send')
      }),
      syncList: vi.fn(async () => {
        order.push('sync')
        return 'list-1'
      }),
    })
    const { unmount } = render(<ListPage api={api} week={WEEK} user="u" />)
    await waitFor(() => expect(order).toEqual(['send', 'sync']))
    unmount()

    // Now a change that can't be sent: no sync until it is.
    localStorage.clear()
    queueOp('u', { kind: 'check', id: 'eggs', checked: true })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const stuck = listApi({
      sendListOp: vi.fn(async () => {
        throw new Error('Failed to fetch')
      }),
    })
    render(<ListPage api={stuck} week={WEEK} user="u" />)
    await waitFor(() => expect(stuck.planCost).toHaveBeenCalled())
    expect(stuck.syncList).not.toHaveBeenCalled()
  })

  it('says when there’s nothing yet', async () => {
    const api = listApi({ loadList: vi.fn(async () => null) })
    render(<ListPage api={api} week={WEEK} user="u" />)
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
  meal: null,
  proteins: [],
  cuisines: [],
})

describe('Home', () => {
  const now = new Date('2026-10-14T17:00:00')
  const homeApi = (entries: PlanEntry[]): HomeApi => ({
    plan: vi.fn(async () => entries),
    planCost: vi.fn(async () => COST),
    list: vi.fn(async () => []),
    ...fakeCookedApi(),
  })

  it('marks tonight’s meal cooked, dated today (TYL-68)', async () => {
    const api = homeApi([entry('1', '2026-10-14', 'Red lentil dal')])
    render(<Home api={api} now={now} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Cooked Red lentil dal' }),
    )
    expect(api.markCooked).toHaveBeenCalledWith({
      recipeId: 'r-1',
      planEntryId: '1',
      cookedOn: '2026-10-14',
      scale: 1,
    })
    expect(
      await screen.findByRole('group', { name: 'Rate Red lentil dal' }),
    ).toBeInTheDocument()
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

  it('says so when the cost can’t be worked out', async () => {
    const api = homeApi([entry('1', '2026-10-14', 'Red lentil dal')])
    vi.mocked(api.planCost).mockRejectedValue(new Error('down'))
    render(<Home api={api} now={now} />)
    expect(
      await screen.findByText(/couldn't work out the cost just now/),
    ).toBeInTheDocument()
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
  it('marks the staples you have, and other things used up', async () => {
    const api: PantryApi = {
      pantry: vi.fn(async () => [
        { ingredientId: 'oil', name: 'olive oil', status: 'have' as const },
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
      await screen.findByRole('button', { name: 'olive oil' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'salt' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await userEvent.click(screen.getByRole('button', { name: 'salt' }))
    expect(api.setPantry).toHaveBeenCalledWith('salt', 'have')
    await userEvent.click(screen.getByRole('button', { name: 'olive oil' }))
    expect(api.setPantry).toHaveBeenCalledWith('oil', null)
    await userEvent.click(
      screen.getByRole('button', { name: "I'm out of rice" }),
    )
    expect(api.setPantry).toHaveBeenCalledWith('rice', null)
  })

  it('waits for one save before taking another tap on the same staple', async () => {
    let finish!: () => void
    const api: PantryApi = {
      pantry: vi.fn(async () => []),
      pantryStaples: vi.fn(async () => [{ id: 'salt', name: 'salt' }]),
      setPantry: vi.fn(() => new Promise<void>((r) => (finish = r))),
    }
    render(<PantryPage api={api} />)
    await userEvent.click(await screen.findByRole('button', { name: 'salt' }))
    const salt = screen.getByRole('button', { name: 'salt' })
    expect(salt).toHaveAttribute('aria-pressed', 'true')
    expect(salt).toBeDisabled()
    finish()
    await waitFor(() => expect(salt).toBeEnabled())
  })

  it('keeps the pantry on screen and puts back only what failed to save', async () => {
    const api: PantryApi = {
      pantry: vi.fn(async () => []),
      pantryStaples: vi.fn(async () => [
        { id: 'salt', name: 'salt' },
        { id: 'oil', name: 'olive oil' },
      ]),
      setPantry: vi.fn(async (id: string) => {
        if (id === 'salt') throw new Error('nope')
      }),
    }
    render(<PantryPage api={api} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'olive oil' }),
    )
    await userEvent.click(screen.getByRole('button', { name: 'salt' }))
    expect(
      await screen.findByText("That didn't save. Try again."),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'salt' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByRole('button', { name: 'olive oil' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
})
