import type { Session } from '@supabase/supabase-js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SavedRecipe } from './library.ts'
import { PlanPage, type PlanApi } from './Plan.tsx'
import {
  addDays,
  formatQuantity,
  isMonday,
  planCost,
  scaledLine,
  weekDays,
  weekLabel,
  weekOf,
  type Fit,
  type PlanCost,
  type PlanEntry,
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

describe('planCost', () => {
  it('reads the API’s estimate', async () => {
    const send = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            budget_cents: 8000,
            total_cents: 1234,
            estimated: true,
            unpriced_lines: 2,
            entries: [{ id: 'e-1', cents: 1234 }],
          }),
        ),
    )
    const cost = await planCost({} as Session, '2026-10-12', send)
    expect(send).toHaveBeenCalledWith({}, '/plans/2026-10-12/cost')
    expect(cost).toEqual({
      budgetCents: 8000,
      totalCents: 1234,
      estimated: true,
      unpricedLines: 2,
      entries: { 'e-1': 1234 },
    })
  })

  it('throws when the API fails', async () => {
    const send = vi.fn(async () => new Response('', { status: 502 }))
    await expect(planCost({} as Session, '2026-10-12', send)).rejects.toThrow()
  })
})

const WEEK = '2026-10-12'

const saved = (id: string, title: string): SavedRecipe => ({
  id,
  title,
  sourceUrl: null,
  sourceName: null,
  sourceNote: null,
  totalMinutes: null,
  savedAt: '2026-10-01',
  diets: [],
  ingredients: [],
})

const entry = (id: string, extra: Partial<PlanEntry> = {}): PlanEntry => ({
  id,
  recipeId: `r-${id}`,
  title: `Recipe ${id}`,
  servings: 2,
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

function fakeApi({
  entries = [] as PlanEntry[],
  cost = {
    budgetCents: 5000,
    totalCents: 1200,
    estimated: true,
    unpricedLines: 1,
    entries: { '1': 1200 },
  } as PlanCost,
  recipes = [] as SavedRecipe[],
  fits = {} as Record<string, Fit>,
  copied = 0,
} = {}) {
  let current = entries
  const api = {
    list: vi.fn(async () => recipes),
    recipe: vi.fn(async () => DETAIL),
    plan: vi.fn(async () => current),
    addToPlan: vi.fn(
      async (_w: string, id: string, servings: number) =>
        void (current = [...current, entry('new', { recipeId: id, servings })]),
    ),
    updateEntry: vi.fn(
      async (_id: string, _patch: { servings?: number; day?: string | null }) =>
        void 0,
    ),
    removeEntry: vi.fn(async (_id: string) => void 0),
    copyPlan: vi.fn(async (_from: string, _to: string) => copied),
    planCost: vi.fn(async () => cost),
    recipeFits: vi.fn(async () => fits),
  } satisfies PlanApi
  return api
}

describe('PlanPage', () => {
  it('groups the week by day and shows the cost against the budget', async () => {
    const api = fakeApi({
      entries: [entry('1', { day: '2026-10-14' }), entry('2', { position: 1 })],
    })
    render(<PlanPage api={api} week={WEEK} householdSize={2} />)
    const wednesday = (
      await screen.findByRole('heading', { name: 'Wednesday' })
    ).closest('section')!
    expect(within(wednesday).getByText('Recipe 1')).toBeInTheDocument()
    expect(within(wednesday).getByText('~$12.00')).toBeInTheDocument()
    const anyDay = screen
      .getByRole('heading', { name: 'Any day this week' })
      .closest('section')!
    expect(within(anyDay).getByText('Recipe 2')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Monday' })).toBeNull()
    expect(
      await screen.findByText('~$12.00', { selector: 'strong' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/of your \$50\.00 budget/)).toBeInTheDocument()
    expect(screen.getByText(/1 ingredient not priced yet/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Previous' })).toHaveAttribute(
      'href',
      '/plan/2026-10-05',
    )
  })

  it('says when the week is over budget, or offers to set one', async () => {
    const over = fakeApi({
      entries: [entry('1')],
      cost: {
        budgetCents: 1000,
        totalCents: 1200,
        estimated: false,
        unpricedLines: 0,
        entries: {},
      },
    })
    const { unmount } = render(
      <PlanPage api={over} week={WEEK} householdSize={2} />,
    )
    expect(await screen.findByText(/over budget/)).toBeInTheDocument()
    unmount()
    const none = fakeApi({
      entries: [entry('1')],
      cost: {
        budgetCents: null,
        totalCents: 500,
        estimated: false,
        unpricedLines: 0,
        entries: {},
      },
    })
    render(<PlanPage api={none} week={WEEK} householdSize={2} />)
    expect(
      await screen.findByRole('link', { name: 'Set a weekly budget' }),
    ).toHaveAttribute('href', '/settings')
  })

  it('changes servings and days, and removes recipes', async () => {
    const api = fakeApi({ entries: [entry('1')] })
    render(<PlanPage api={api} week={WEEK} householdSize={2} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'More servings of Recipe 1' }),
    )
    expect(api.updateEntry).toHaveBeenCalledWith('1', { servings: 3 })
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

  it('shows ingredients scaled to the servings planned', async () => {
    const api = fakeApi({ entries: [entry('1', { recipeId: 'r-1' })] })
    render(<PlanPage api={api} week={WEEK} householdSize={2} />)
    await userEvent.click(await screen.findByText('Ingredients for 2'))
    expect(await screen.findByText('1 cup rice')).toBeInTheDocument()
  })

  it('adds only recipes that fit the user’s rules', async () => {
    const api = fakeApi({
      recipes: [saved('a', 'Lentil soup'), saved('b', 'Peanut noodles')],
      fits: { a: 'fits', b: 'excluded' },
    })
    render(<PlanPage api={api} week={WEEK} householdSize={3} />)
    const list = await screen.findByRole('list', {
      name: 'Recipes you can add',
    })
    expect(within(list).queryByText('Peanut noodles')).toBeNull()
    expect(screen.getByText(/1 recipe left out/)).toBeInTheDocument()
    await userEvent.click(
      within(list).getByRole('button', { name: 'Add Lentil soup' }),
    )
    expect(api.addToPlan).toHaveBeenCalledWith(WEEK, 'a', 3)
    await waitFor(() => expect(api.plan).toHaveBeenCalledTimes(2))
  })

  it('copies last week into an empty week', async () => {
    const api = fakeApi({ copied: 0 })
    render(<PlanPage api={api} week={WEEK} householdSize={2} />)
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
    render(<PlanPage api={api} week={WEEK} householdSize={2} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't load your plan.",
    )
  })
})
