import type { Session } from '@supabase/supabase-js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SavedRecipe } from './library.ts'
import { PlanPage, type PlanApi } from './Plan.tsx'
import {
  addDays,
  addedCosts,
  parseDollars,
  priceBasis,
  buyText,
  formatQuantity,
  isMonday,
  planCost,
  scaledLine,
  weekDays,
  weekLabel,
  weekOf,
  type AddedCosts,
  type BuyItem,
  type Fit,
  type PlanCost,
  type PlanEntry,
  type Scale,
} from './plan.ts'
import type { IngredientLine, RecipeDetail } from './sous.ts'

describe('weeks', () => {
  it('starts on Monday', () => {
    expect(weekOf(new Date(2026, 9, 14))).toBe('2026-10-12') // Wednesday
    expect(weekOf(new Date(2026, 9, 18, 23, 30))).toBe('2026-10-12') // Sunday night
    expect(weekOf(new Date(2026, 9, 12))).toBe('2026-10-12')
    expect(isMonday('2026-10-12')).toBe(true)
    expect(isMonday('2026-10-13')).toBe(false)
    expect(isMonday('nope')).toBe(false)
  })

  it('counts days across months', () => {
    expect(addDays('2026-09-28', 7)).toBe('2026-10-05')
    expect(weekDays('2026-10-12')).toHaveLength(7)
    expect(weekLabel('2026-10-12')).toBe('Oct 12 – 18')
    expect(weekLabel('2026-09-28')).toBe('Sep 28 – Oct 4')
  })
})

const ingredient = (
  rawText: string,
  extra: Partial<IngredientLine> = {},
): IngredientLine => ({
  lineNo: 0,
  optionNo: 1,
  rawText,
  section: null,
  name: null,
  quantity: null,
  quantityMax: null,
  unit: null,
  preparation: null,
  isOptional: false,
  ...extra,
})

describe('scaling', () => {
  it.each([
    [1.5, '1½'],
    [0.333, '⅓'],
    [2, '2'],
    [0.125, '⅛'],
    [2.97, '3'],
    [2.4, '2.4'],
  ])('formats %s as %s', (n, text) => {
    expect(formatQuantity(n)).toBe(text)
  })

  it('scales amounts and keeps the rest of the line', () => {
    const rice = ingredient('2 cups rice, rinsed', {
      name: 'rice',
      quantity: 2,
      unit: 'cup',
      preparation: 'rinsed',
    })
    expect(scaledLine(rice, 1.5)).toBe('3 cups rice, rinsed')
    expect(scaledLine(rice, 0.25)).toBe('½ cup rice, rinsed')
    expect(scaledLine(rice, 1)).toBe('2 cups rice, rinsed')
    const eggs = ingredient('2-3 eggs', {
      name: 'eggs',
      quantity: 2,
      quantityMax: 3,
      unit: 'each',
    })
    expect(scaledLine(eggs, 2)).toBe('4–6 eggs')
    const garlic = ingredient('1 clove garlic', {
      name: 'garlic',
      quantity: 1,
      unit: 'clove',
    })
    expect(scaledLine(garlic, 2)).toBe('2 cloves garlic')
    const salt = ingredient('salt to taste', { name: 'salt' })
    expect(scaledLine(salt, 2)).toBe('salt to taste')
  })
})

const item = (name: string, extra: Partial<BuyItem> = {}): BuyItem => ({
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

describe('planCost', () => {
  it('reads the API’s shopping estimate', async () => {
    const send = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            budget_cents: 8000,
            total_cents: 400,
            estimated: true,
            unpriced: 0,
            items: [
              {
                ingredient_id: 'rice',
                name: 'white rice',
                aisle: 'pantry',
                quantity: 1.02,
                unit: 'lb',
                amount_unknown: false,
                sold_by: 'package',
                package_quantity: 2,
                package_unit: 'lb',
                packages: 1,
                leftover: 0.98,
                staple: false,
                pantry: null,
                buy: true,
                cents: 400,
              },
            ],
          }),
        ),
    )
    const cost = await planCost({} as Session, '2026-10-12', send)
    expect(send).toHaveBeenCalledWith({}, '/plans/2026-10-12/cost')
    expect(cost).toMatchObject({ budgetCents: 8000, totalCents: 400 })
    expect(cost.items[0]).toMatchObject({
      name: 'white rice',
      packages: 1,
      packageUnit: 'lb',
      cents: 400,
      estimated: false,
      onSale: false,
      saleEnds: null,
      regularCents: null,
    })
    expect(cost.storeName).toBeNull()
    expect(cost.storeId).toBeNull()
    expect(cost.entryCents).toEqual({})
    expect(cost.items[0].priceSource).toBeNull()
  })

  it('reads where prices came from, the store, and each recipe’s share', async () => {
    const send = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            budget_cents: null,
            total_cents: 0,
            estimated: false,
            unpriced: 0,
            items: [],
            store_name: 'Harris Teeter',
            store_id: 'ht',
            entries: [
              { entry_id: 'e-1', cents: 640 },
              { entry_id: 'e-2', cents: 0 },
            ],
          }),
        ),
    )
    const cost = await planCost({} as Session, '2026-10-12', send)
    expect(cost.storeId).toBe('ht')
    expect(cost.entryCents).toEqual({ 'e-1': 640, 'e-2': 0 })
  })

  it('throws when the API fails', async () => {
    const send = vi.fn(async () => new Response('', { status: 502 }))
    await expect(planCost({} as Session, '2026-10-12', send)).rejects.toThrow()
  })
})

describe('addedCosts', () => {
  it('asks what each recipe would add, by recipe', async () => {
    const send = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            budget_cents: 5000,
            total_cents: 4200,
            recipes: [
              {
                recipe_id: 'a',
                cents: 650,
                unpriced: false,
                estimated: true,
                staples_cents: 130,
              },
            ],
          }),
        ),
    )
    const added = await addedCosts({} as Session, WEEK, ['a', 'b'], send)
    expect(send).toHaveBeenCalledWith({}, `/plans/${WEEK}/added`, {
      method: 'POST',
      body: JSON.stringify({ recipe_ids: ['a', 'b'] }),
    })
    expect(added).toEqual({
      budgetCents: 5000,
      totalCents: 4200,
      recipes: {
        a: { cents: 650, unpriced: false, estimated: true, staplesCents: 130 },
      },
    })
  })
})

describe('addedCosts in batches', () => {
  it('asks 100 at a time and merges the answers', async () => {
    const ids = Array.from({ length: 150 }, (_, n) => `r${n}`)
    const send = vi.fn(
      async (_s: Session, _path: string, init?: RequestInit) => {
        const asked = JSON.parse(String(init!.body)).recipe_ids as string[]
        return new Response(
          JSON.stringify({
            budget_cents: 5000,
            total_cents: 4200,
            recipes: asked.map((id) => ({
              recipe_id: id,
              cents: 100,
              unpriced: false,
              estimated: false,
            })),
          }),
        )
      },
    )
    const added = await addedCosts({} as Session, WEEK, ids, send)
    expect(
      send.mock.calls.map(
        (c) => JSON.parse(String(c[2]!.body)).recipe_ids.length,
      ),
    ).toEqual([100, 50])
    expect(Object.keys(added.recipes)).toHaveLength(150)
    expect(added.totalCents).toBe(4200)
  })
})

describe('own prices', () => {
  it.each([
    ['2.49', 249],
    ['$2', 200],
    ['2,5', 250],
    ['.99', 99],
    ['0', 0],
    ['', null],
    ['abc', null],
    ['2.499', null],
    ['-1', null],
    ['5000', null],
  ])('reads %j as %s cents', (text, cents) => {
    expect(parseDollars(text)).toBe(cents)
  })

  it('prices a package as the list buys it, or a pound of what is loose', () => {
    expect(
      priceBasis(item('tofu', { packageQuantity: 14, packageUnit: 'oz' })),
    ).toEqual({ quantity: 14, unit: 'oz', label: '14 oz' })
    expect(
      priceBasis(
        item('cilantro', { packageQuantity: 1, packageUnit: 'bunch' }),
      ),
    ).toEqual({ quantity: 1, unit: 'bunch', label: '1 bunch' })
    expect(
      priceBasis(item('eggs', { packageQuantity: 12, packageUnit: 'each' })),
    ).toEqual({ quantity: 12, unit: 'each', label: 'a pack of 12' })
    expect(
      priceBasis(item('carrots', { soldBy: 'loose', unit: 'lb' })),
    ).toEqual({ quantity: 1, unit: 'lb', label: '1 lb' })
  })
})

describe('buyText', () => {
  it.each([
    [{ packages: 1, packageQuantity: 2, packageUnit: 'lb' }, '2 lb'],
    [{ packages: 2, packageQuantity: 15, packageUnit: 'oz' }, '2 × 15 oz'],
    [
      { packages: 2, packageQuantity: 12, packageUnit: 'each' },
      '2 × pack of 12',
    ],
    [{ packages: 3, packageQuantity: 1, packageUnit: 'each' }, '3'],
    [{ soldBy: 'loose' as const, quantity: 1.5, unit: 'lb' }, '1½ lb'],
    [{ soldBy: 'loose' as const, amountUnknown: true }, null],
  ])('%o → %s', (extra, text) => {
    expect(buyText(item('x', extra))).toBe(text)
  })
})

const WEEK = '2026-10-12'

const saved = (
  id: string,
  title: string,
  cuisines: string[] = [],
): SavedRecipe => ({
  id,
  title,
  sourceUrl: null,
  sourceName: null,
  sourceNote: null,
  totalMinutes: null,
  savedAt: '2026-10-01',
  diets: [],
  ingredients: [],
  tags: [],
  cuisines,
})

const entry = (id: string, extra: Partial<PlanEntry> = {}): PlanEntry => ({
  id,
  recipeId: `r-${id}`,
  title: `Recipe ${id}`,
  scale: 1,
  recipeServings: 4,
  day: null,
  position: 0,
  ...extra,
})

const DETAIL: RecipeDetail = {
  id: 'r-1',
  title: 'Recipe 1',
  sourceUrl: null,
  sourceName: null,
  sourceNote: null,
  license: null,
  saved: true,
  tags: [],
  servings: 4,
  prepMinutes: null,
  cookMinutes: null,
  totalMinutes: null,
  instructions: null,
  handTyped: true,
  ingredients: [
    ingredient('2 cups rice', { name: 'rice', quantity: 2, unit: 'cup' }),
  ],
  diets: [],
  cuisines: [],
}

const COST: PlanCost = {
  budgetCents: 5000,
  totalCents: 1200,
  estimated: true,
  unpriced: 1,
  storeName: null,
  storeId: null,
  storeStatus: 'not_chosen' as const,
  homeZip: null,
  entryCents: {},
  items: [
    item('white rice', {
      quantity: 1,
      unit: 'lb',
      packages: 1,
      packageQuantity: 2,
      packageUnit: 'lb',
      leftover: 1,
      cents: 400,
    }),
    item('carrots', {
      aisle: 'produce',
      soldBy: 'loose',
      quantity: 1.5,
      unit: 'lb',
      cents: 800,
    }),
    item('mystery', { amountUnknown: true, soldBy: 'loose' }),
    item('salt', {
      aisle: 'spices',
      staple: true,
      buy: false,
      packages: 1,
      packageQuantity: 26,
      packageUnit: 'oz',
    }),
  ],
}

function fakeApi({
  entries = [] as PlanEntry[],
  cost = COST,
  recipes = [] as SavedRecipe[],
  fits = {} as Record<string, Fit>,
  favorites = [] as string[],
  added = { budgetCents: null, totalCents: 0, recipes: {} } as AddedCosts,
  copied = 0,
} = {}) {
  let current = entries
  const api = {
    list: vi.fn(async () => recipes),
    recipe: vi.fn(async () => DETAIL),
    plan: vi.fn(async () => current),
    addToPlan: vi.fn(
      async (_w: string, id: string, scale: Scale = 1) =>
        void (current = [...current, entry('new', { recipeId: id, scale })]),
    ),
    updateEntry: vi.fn(
      async (_id: string, _patch: { scale?: Scale; day?: string | null }) =>
        void 0,
    ),
    removeEntry: vi.fn(async (_id: string) => void 0),
    removeEntries: vi.fn(async (ids: string[]) => {
      current = current.filter((e) => !ids.includes(e.id))
    }),
    copyPlan: vi.fn(async (_from: string, _to: string) => copied),
    planCost: vi.fn(async () => cost),
    recipeFits: vi.fn(async () => fits),
    addedCosts: vi.fn(async (_w: string, _ids: string[]) => added),
    favoriteCuisines: vi.fn(async () => favorites),
    setPantry: vi.fn(
      async (_id: string, _status: 'have' | 'out' | null) => void 0,
    ),
    setMyPrice: vi.fn(
      async (
        _id: string,
        _store: string | null,
        _cents: number,
        _basis: { quantity: number; unit: string },
      ) => void 0,
    ),
    clearMyPrice: vi.fn(async (_id: string, _store: string | null) => void 0),
  } satisfies PlanApi
  return api
}

describe('PlanPage', () => {
  it('groups the week by day and shows the cost against the budget', async () => {
    const api = fakeApi({
      entries: [entry('1', { day: '2026-10-14' }), entry('2', { position: 1 })],
    })
    render(<PlanPage api={api} week={WEEK} />)
    const wednesday = (
      await screen.findByRole('heading', { name: 'Wednesday' })
    ).closest('section')!
    expect(within(wednesday).getByText('Recipe 1')).toBeInTheDocument()
    const anyDay = screen
      .getByRole('heading', { name: 'Any day this week' })
      .closest('section')!
    expect(within(anyDay).getByText('Recipe 2')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Monday' })).toBeNull()
    expect(
      await screen.findByText('~$12.00', { selector: 'strong' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/of your \$50\.00 budget/)).toBeInTheDocument()
    expect(screen.getByText(/1 item not priced yet/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Previous' })).toHaveAttribute(
      'href',
      '/plan/2026-10-05',
    )
  })

  it('says where prices come from, and why not from a store', async () => {
    const show = async (cost: PlanCost, text: RegExp) => {
      const { unmount } = render(
        <PlanPage api={fakeApi({ entries: [entry('1')], cost })} week={WEEK} />,
      )
      expect(await screen.findByText(text)).toBeInTheDocument()
      return unmount
    }
    let done = await show(
      COST,
      /for today's shelf prices\. Prices marked ~ are estimates/,
    )
    expect(
      screen.getByRole('link', { name: 'Choose your store' }),
    ).toHaveAttribute('href', '/settings')
    done()
    done = await show(
      { ...COST, storeStatus: 'none_nearby', homeZip: '02139' },
      /there isn't one near 02139\. Prices marked ~/,
    )
    done()
    // All the user's own prices: nothing is called an estimate.
    done = await show(
      {
        ...COST,
        storeStatus: 'none_nearby',
        homeZip: '02139',
        estimated: false,
      },
      /there isn't one near 02139\. Use/,
    )
    expect(screen.queryByText(/estimates/)).toBeNull()
    done()
    done = await show(
      { ...COST, storeName: 'Kroger - Holland Road', storeStatus: 'store' },
      /Prices from Kroger - Holland Road, today/,
    )
    done()
  })

  it('lists what to buy, by the package or by the amount, and what’s on hand', async () => {
    render(<PlanPage api={fakeApi({ entries: [entry('1')] })} week={WEEK} />)
    await userEvent.click(await screen.findByText(/What you'll buy \(3\)/))
    const toBuy = screen.getByRole('list', { name: 'To buy' })
    const rice = within(toBuy).getByText('white rice').closest('li')!
    expect(rice).toHaveTextContent('2 lb')
    expect(rice).toHaveTextContent('$4.00')
    expect(rice).toHaveTextContent('½ of a package left over')
    expect(within(toBuy).getByText('carrots').closest('li')).toHaveTextContent(
      '1½ lb',
    )
    expect(within(toBuy).getByText('mystery').closest('li')).toHaveTextContent(
      'amount not given',
    )
  })

  it('shows what’s on hand in plain view, off the list', async () => {
    render(<PlanPage api={fakeApi({ entries: [entry('1')] })} week={WEEK} />)
    expect(await screen.findByText('On hand, not on your list')).toBeVisible()
    const onHand = screen.getByRole('list', { name: 'On hand' })
    expect(within(onHand).getByText('salt')).toBeVisible()
  })

  it('updates the pantry from the list', async () => {
    const api = fakeApi({ entries: [entry('1')] })
    render(<PlanPage api={api} week={WEEK} />)
    await userEvent.click(await screen.findByText(/What you'll buy/))
    await userEvent.click(
      screen.getByRole('button', { name: 'I need salt, put it on the list' }),
    )
    expect(api.setPantry).toHaveBeenCalledWith('i-salt', null)
    await userEvent.click(
      screen.getByRole('button', { name: 'I have white rice already' }),
    )
    expect(api.setPantry).toHaveBeenCalledWith('i-white rice', 'have')
    await waitFor(() => expect(api.planCost).toHaveBeenCalledTimes(3))
  })

  it('shows live store prices, sales and estimates', async () => {
    const api = fakeApi({
      entries: [entry('1')],
      cost: {
        ...COST,
        storeName: 'Harris Teeter',
        items: [
          item('eggs', {
            cents: 199,
            onSale: true,
            saleEnds: '2026-10-13',
            regularCents: 279,
          }),
          item('saffron', { cents: 900, estimated: true }),
        ],
      },
    })
    render(<PlanPage api={api} week={WEEK} />)
    expect(
      await screen.findByText(
        /Prices from Harris Teeter, today\. Prices marked ~/,
      ),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByText(/What you'll buy/))
    const list = screen.getByRole('list', { name: 'To buy' })
    expect(
      within(list).getByText(/Sale until Tue, Oct 13 · was \$2\.79/),
    ).toBeInTheDocument()
    expect(within(list).getByText(/~\$9\.00/)).toBeInTheDocument()
  })

  it('shows each recipe’s share of the week', async () => {
    const api = fakeApi({
      entries: [entry('1')],
      cost: { ...COST, entryCents: { '1': 640 } },
    })
    render(<PlanPage api={api} week={WEEK} />)
    expect(
      await screen.findByLabelText("This recipe's share"),
    ).toHaveTextContent('~$6.40')
  })

  it('says where each price is from, and saves the user’s own', async () => {
    const api = fakeApi({
      entries: [entry('1')],
      cost: {
        ...COST,
        storeName: 'Harris Teeter',
        storeId: 'ht',
        items: [
          item('tofu', {
            cents: 299,
            priceSource: 'store',
            packages: 1,
            packageQuantity: 14,
            packageUnit: 'oz',
          }),
          item('eggs', { cents: 300, priceSource: 'user' }),
          item('saffron', {
            cents: 900,
            estimated: true,
            priceSource: 'estimate',
          }),
        ],
      },
    })
    render(<PlanPage api={api} week={WEEK} />)
    await userEvent.click(await screen.findByText(/What you'll buy/))
    const list = screen.getByRole('list', { name: 'To buy' })
    expect(within(list).getByText('Harris Teeter')).toBeInTheDocument()
    expect(within(list).getByText('your price')).toBeInTheDocument()
    expect(within(list).getByText('estimate')).toBeInTheDocument()

    await userEvent.click(
      within(list).getByRole('button', { name: 'Set your price for tofu' }),
    )
    const field = within(list).getByLabelText(
      'Your price at Harris Teeter for 14 oz tofu',
    )
    const save = within(list).getByRole('button', { name: 'Save' })
    await userEvent.type(field, 'two')
    expect(save).toBeDisabled()
    await userEvent.clear(field)
    await userEvent.type(field, '2.49')
    await userEvent.click(save)
    expect(api.setMyPrice).toHaveBeenCalledWith('i-tofu', 'ht', 249, {
      quantity: 14,
      unit: 'oz',
      label: '14 oz',
    })
    await waitFor(() => expect(api.planCost).toHaveBeenCalledTimes(2))

    await userEvent.click(
      within(list).getByRole('button', { name: 'Set your price for eggs' }),
    )
    await userEvent.click(
      within(list).getByRole('button', { name: 'Use the usual price' }),
    )
    expect(api.clearMyPrice).toHaveBeenCalledWith('i-eggs', 'ht')
  })

  it('says when the week is over budget, or offers to set one', async () => {
    const over = fakeApi({
      entries: [entry('1')],
      cost: { ...COST, budgetCents: 1000, estimated: false, unpriced: 0 },
    })
    const { unmount } = render(<PlanPage api={over} week={WEEK} />)
    expect(await screen.findByText(/over budget/)).toBeInTheDocument()
    unmount()
    const none = fakeApi({
      entries: [entry('1')],
      cost: { ...COST, budgetCents: null },
    })
    render(<PlanPage api={none} week={WEEK} />)
    expect(
      await screen.findByRole('link', { name: 'Set a weekly budget' }),
    ).toHaveAttribute('href', '/settings')
  })

  it('sets the size and day, and removes recipes', async () => {
    const api = fakeApi({ entries: [entry('1')] })
    render(<PlanPage api={api} week={WEEK} />)
    const size = await screen.findByRole('group', { name: 'Size of Recipe 1' })
    expect(within(size).getByRole('button', { name: 'Full' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByText('serves 4')).toBeInTheDocument()
    await userEvent.click(within(size).getByRole('button', { name: 'Double' }))
    expect(api.updateEntry).toHaveBeenCalledWith('1', { scale: 2 })
    await userEvent.selectOptions(
      screen.getByLabelText('Day for Recipe 1'),
      'Friday',
    )
    expect(api.updateEntry).toHaveBeenCalledWith('1', { day: '2026-10-16' })
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Recipe 1 from the plan' }),
    )
    expect(api.removeEntry).toHaveBeenCalledWith('1')
  })

  it('clears the week, but only after asking', async () => {
    const api = fakeApi({ entries: [entry('1'), entry('2')] })
    render(<PlanPage api={api} week={WEEK} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Clear this week' }),
    )
    expect(
      screen.getByText('Take all 2 recipes off this week?'),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Keep them' }))
    expect(api.removeEntries).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Clear this week' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Clear the week' }),
    )
    expect(api.removeEntries).toHaveBeenCalledWith(['1', '2'])
    expect(
      await screen.findByText('Nothing planned for this week yet.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear this week' })).toBeNull()
  })

  it('shows ingredients at the planned size', async () => {
    const api = fakeApi({
      entries: [entry('1', { recipeId: 'r-1', scale: 0.5 })],
    })
    render(<PlanPage api={api} week={WEEK} />)
    expect(await screen.findByText('serves 2')).toBeInTheDocument()
    await userEvent.click(screen.getByText('Ingredients, halved'))
    expect(await screen.findByText('1 cup rice')).toBeInTheDocument()
  })

  it('adds a recipe at full size', async () => {
    const api = fakeApi({
      recipes: [saved('a', 'Lentil soup'), saved('b', 'Peanut noodles')],
      fits: { a: 'fits', b: 'excluded' },
    })
    render(<PlanPage api={api} week={WEEK} />)
    const list = await screen.findByRole('list', {
      name: 'Recipes you can add',
    })
    await userEvent.click(
      within(list).getByRole('button', { name: 'Add Lentil soup' }),
    )
    expect(api.addToPlan).toHaveBeenCalledWith(WEEK, 'a', 1)
    await waitFor(() => expect(api.plan).toHaveBeenCalledTimes(2))
  })

  it('says how much of a recipe’s cost is staples not marked in the pantry', async () => {
    const api = fakeApi({
      recipes: [saved('a', 'Lentil soup')],
      added: {
        budgetCents: 5000,
        totalCents: 1200,
        recipes: {
          a: {
            cents: 650,
            unpriced: false,
            estimated: true,
            staplesCents: 130,
          },
        },
      },
    })
    render(<PlanPage api={api} week={WEEK} />)
    const list = await screen.findByRole('list', {
      name: 'Recipes you can add',
    })
    expect(
      await within(list).findByText(/incl\. \$1\.30 of staples/),
    ).toHaveAttribute('title', expect.stringContaining('pantry'))
  })

  it('shows what each recipe would add, and adds one that fits straight away', async () => {
    const api = fakeApi({
      recipes: [saved('a', 'Lentil soup')],
      added: {
        budgetCents: 5000,
        totalCents: 1200,
        recipes: {
          a: { cents: 650, unpriced: true, estimated: true, staplesCents: 0 },
        },
      },
    })
    render(<PlanPage api={api} week={WEEK} />)
    const list = await screen.findByRole('list', {
      name: 'Recipes you can add',
    })
    expect(
      await within(list).findByLabelText('Adds to this week'),
    ).toHaveTextContent('+~$6.50 or more')
    expect(api.addedCosts).toHaveBeenCalledWith(WEEK, ['a'])
    await userEvent.click(
      within(list).getByRole('button', { name: 'Add Lentil soup' }),
    )
    expect(api.addToPlan).toHaveBeenCalledWith(WEEK, 'a', 1)
    // The plan changed, so what each would add is worked out again.
    await waitFor(() => expect(api.addedCosts).toHaveBeenCalledTimes(2))
  })

  it('asks before going over budget, and suggests cheaper picks that fit', async () => {
    const api = fakeApi({
      recipes: [
        saved('steak', 'Steak frites'),
        saved('beans', 'Rice and beans'),
        saved('dal', 'Red lentil dal'),
        saved('noodles', 'Peanut noodles'),
      ],
      fits: { noodles: 'excluded' },
      added: {
        budgetCents: 5000,
        totalCents: 4500,
        recipes: {
          steak: {
            cents: 2400,
            unpriced: false,
            estimated: false,
            staplesCents: 0,
          },
          beans: {
            cents: 300,
            unpriced: false,
            estimated: false,
            staplesCents: 0,
          },
          dal: {
            cents: 450,
            unpriced: false,
            estimated: false,
            staplesCents: 0,
          },
          noodles: {
            cents: 100,
            unpriced: false,
            estimated: false,
            staplesCents: 0,
          },
        },
      },
    })
    render(<PlanPage api={api} week={WEEK} />)
    const list = await screen.findByRole('list', {
      name: 'Recipes you can add',
    })
    await within(list).findByText('+$24.00')
    expect(within(list).getByText(/over budget/)).toBeInTheDocument()
    await userEvent.click(
      within(list).getByRole('button', { name: 'Add Steak frites' }),
    )
    expect(api.addToPlan).not.toHaveBeenCalled()
    expect(within(list).getByRole('alert')).toHaveTextContent(
      'Adding it (+$24.00) puts the week at $69.00, $19.00 over your $50.00 budget.',
    )
    // Cheapest first, and never one that breaks the user's rules.
    const picks = within(list).getByRole('list', { name: 'Cheaper picks' })
    expect(
      within(picks)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Rice and beans +$3.00', 'Red lentil dal +$4.50'])
    await userEvent.click(within(picks).getByText(/Rice and beans/))
    expect(api.addToPlan).toHaveBeenCalledWith(WEEK, 'beans', 1)
  })

  it('suggests favorite cuisines first', async () => {
    const api = fakeApi({
      recipes: [
        saved('steak', 'Steak frites'),
        saved('beans', 'Rice and beans'),
        saved('dal', 'Red lentil dal', ['indian']),
      ],
      favorites: ['indian'],
      added: {
        budgetCents: 5000,
        totalCents: 4500,
        recipes: {
          steak: {
            cents: 2400,
            unpriced: false,
            estimated: false,
            staplesCents: 0,
          },
          beans: {
            cents: 300,
            unpriced: false,
            estimated: false,
            staplesCents: 0,
          },
          dal: {
            cents: 450,
            unpriced: false,
            estimated: false,
            staplesCents: 0,
          },
        },
      },
    })
    render(<PlanPage api={api} week={WEEK} />)
    const list = await screen.findByRole('list', {
      name: 'Recipes you can add',
    })
    await within(list).findByText('+$24.00')
    await waitFor(() => expect(api.favoriteCuisines).toHaveBeenCalled())
    await userEvent.click(
      within(list).getByRole('button', { name: 'Add Steak frites' }),
    )
    const picks = within(list).getByRole('list', { name: 'Cheaper picks' })
    expect(
      within(picks)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Red lentil dal +$4.50', 'Rice and beans +$3.00'])
  })

  it('adds anyway when the user says so, over budget', async () => {
    const api = fakeApi({
      recipes: [saved('steak', 'Steak frites')],
      added: {
        budgetCents: 5000,
        totalCents: 4500,
        recipes: {
          steak: {
            cents: 2400,
            unpriced: false,
            estimated: false,
            staplesCents: 0,
          },
        },
      },
    })
    render(<PlanPage api={api} week={WEEK} />)
    const list = await screen.findByRole('list', {
      name: 'Recipes you can add',
    })
    await within(list).findByText('+$24.00')
    await userEvent.click(
      within(list).getByRole('button', { name: 'Add Steak frites' }),
    )
    expect(
      within(list).queryByRole('list', { name: 'Cheaper picks' }),
    ).toBeNull()
    await userEvent.click(
      within(list).getByRole('button', { name: 'Add anyway' }),
    )
    expect(api.addToPlan).toHaveBeenCalledWith(WEEK, 'steak', 1)
  })

  it('warns before adding a recipe that breaks the user’s rules', async () => {
    const api = fakeApi({
      recipes: [saved('b', 'Peanut noodles')],
      fits: { b: 'excluded' },
    })
    render(<PlanPage api={api} week={WEEK} />)
    const list = await screen.findByRole('list', {
      name: 'Recipes you can add',
    })
    expect(
      within(list).getByText("Doesn't fit your diets or allergies"),
    ).toBeInTheDocument()
    await userEvent.click(
      within(list).getByRole('button', { name: 'Add Peanut noodles' }),
    )
    expect(api.addToPlan).not.toHaveBeenCalled()
    expect(within(list).getByRole('alert')).toHaveTextContent(
      "Peanut noodles doesn't fit your diets or allergies.",
    )
    await userEvent.click(
      within(list).getByRole('button', { name: "Don't add Peanut noodles" }),
    )
    expect(within(list).queryByRole('alert')).toBeNull()
    await userEvent.click(
      within(list).getByRole('button', { name: 'Add Peanut noodles' }),
    )
    await userEvent.click(
      within(list).getByRole('button', { name: 'Add anyway' }),
    )
    expect(api.addToPlan).toHaveBeenCalledWith(WEEK, 'b', 1)
  })

  it('copies last week into an empty week', async () => {
    const api = fakeApi({ copied: 0 })
    render(<PlanPage api={api} week={WEEK} />)
    expect(
      await screen.findByText('Nothing planned for this week yet.'),
    ).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: "Copy last week's plan" }),
    )
    expect(api.copyPlan).toHaveBeenCalledWith('2026-10-05', WEEK)
    expect(
      await screen.findByText('Nothing was planned last week.'),
    ).toBeInTheDocument()
  })

  it('says when the plan cannot be loaded', async () => {
    const api = fakeApi()
    api.plan.mockRejectedValueOnce(new Error('down'))
    render(<PlanPage api={api} week={WEEK} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't load your plan.",
    )
  })
})
