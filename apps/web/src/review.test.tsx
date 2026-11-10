import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PantryEntry } from './pantry.ts'
import type { PlanCost, PlanEntry } from './plan.ts'
import { PendingNotice, ReviewSheet, type ReviewApi } from './Review.tsx'
import type { IngredientLine, RecipeDetail } from './sous.ts'

const WEEK = '2026-11-09'

const entry = (id: string, title: string, reviewed = false): PlanEntry => ({
  id,
  recipeId: `r-${id}`,
  title,
  scale: 1,
  recipeServings: 4,
  day: null,
  position: 0,
  meal: null,
  proteins: [],
  cuisines: [],
  styles: [],
  reviewed,
})

const line = (
  lineNo: number,
  name: string,
  ingredientId: string,
  quantity: number | null = null,
  unit: string | null = null,
): IngredientLine => ({
  lineNo,
  optionNo: 1,
  rawText: `${quantity ?? ''} ${unit ?? ''} ${name}`.trim(),
  section: null,
  name,
  quantity,
  quantityMax: null,
  unit,
  preparation: null,
  isOptional: false,
  ingredientId,
})

const SALAD: RecipeDetail = {
  id: 'r-a',
  title: 'Beet salad',
  sourceUrl: null,
  sourceName: null,
  sourceNote: null,
  license: null,
  saved: true,
  tags: [],
  favorite: null,
  servings: 4,
  prepMinutes: null,
  cookMinutes: null,
  totalMinutes: null,
  instructions: null,
  handTyped: true,
  ingredients: [
    line(0, 'beets', 'beets', 4),
    line(1, 'walnuts', 'walnuts', 0.5, 'cup'),
    line(2, 'sherry vinegar', 'vinegar', 2, 'tbsp'),
  ],
  diets: [],
  cuisines: [],
  cuisinesCorrected: false,
}

const cost = (cents: Record<string, number>, total = 4000): PlanCost => ({
  budgetCents: 9000,
  totalCents: total,
  estimated: true,
  unpriced: 0,
  storeName: null,
  storeId: null,
  storeStatus: 'not_chosen',
  homeZip: null,
  entryCents: {},
  choices: [],
  items: Object.entries(cents).map(([id, c]) => ({
    ingredientId: id,
    name: id,
    aisle: null,
    quantity: 1,
    unit: 'each',
    amountUnknown: false,
    soldBy: 'package',
    packageQuantity: 1,
    packageUnit: 'each',
    packages: 1,
    leftover: 0,
    staple: false,
    pantry: null,
    buy: true,
    cents: c,
    estimated: true,
    priceSource: 'estimate',
    onSale: false,
    saleEnds: null,
    regularCents: null,
  })),
})

function reviewApi(pantry: PantryEntry[] = []) {
  return {
    recipe: vi.fn(async () => SALAD),
    planCost: vi.fn(async () =>
      cost({ beets: 349, walnuts: 429, vinegar: 499 }),
    ),
    listCost: vi.fn(async () => cost({}, 4000)),
    pantry: vi.fn(async () => pantry),
    setPantry: vi.fn(async () => {}),
    updateEntry: vi.fn(async () => {}),
  } satisfies ReviewApi
}

const VINEGAR: PantryEntry = {
  ingredientId: 'vinegar',
  name: 'sherry vinegar',
  status: 'have',
  kind: 'staple',
  group: null,
}

describe('PendingNotice (TYL-150)', () => {
  it('names what isn’t on the list yet, and opens the review', async () => {
    const onReview = vi.fn()
    render(
      <PendingNotice
        entries={[entry('a', 'Beet salad'), entry('b', 'Soup')]}
        onReview={onReview}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Not on the list yet: Beet salad; Soup. Check what you already have.',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onReview).toHaveBeenCalled()
  })

  it('says nothing when everything is reviewed', () => {
    const { container } = render(
      <PendingNotice entries={[]} onReview={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ReviewSheet (TYL-150)', () => {
  it('ticks what the pantry has, and adds only what’s needed', async () => {
    const api = reviewApi([VINEGAR])
    const onDone = vi.fn()
    render(
      <ReviewSheet
        api={api}
        week={WEEK}
        entries={[entry('a', 'Beet salad')]}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    )
    const group = await screen.findByRole('region', { name: 'Beet salad' })
    expect(
      within(group).getByRole('button', { name: 'Sherry vinegar: have it' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(group).getByRole('button', { name: 'Beets: need it' }),
    ).toBeInTheDocument()
    // The list grows by what's needed and not on it yet.
    expect(
      await screen.findByRole('button', {
        name: 'Add 2 to the list · +$7.78',
      }),
    ).toBeInTheDocument()

    // Have the walnuts after all.
    await userEvent.click(
      within(group).getByRole('button', { name: 'Walnuts: need it' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Add 1 to the list · +$3.49' }),
    )
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    // Walnuts are on hand now; the vinegar stays a staple; the entry's done.
    expect(api.setPantry).toHaveBeenCalledWith('walnuts', 'have', 'on_hand')
    expect(api.setPantry).toHaveBeenCalledTimes(1)
    expect(api.updateEntry).toHaveBeenCalledWith('a', { reviewed: true })
  })

  it('marks a staple out when the user needs it after all', async () => {
    const api = reviewApi([VINEGAR])
    render(
      <ReviewSheet
        api={api}
        week={WEEK}
        entries={[entry('a', 'Beet salad')]}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    )
    await userEvent.click(
      await screen.findByRole('button', { name: 'Sherry vinegar: have it' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: /^Add 3 to the list/ }),
    )
    await waitFor(() =>
      expect(api.setPantry).toHaveBeenCalledWith('vinegar', 'out', 'staple'),
    )
  })

  it('says when there’s nothing to buy', async () => {
    const api = reviewApi(
      ['beets', 'walnuts', 'vinegar'].map((id) => ({
        ...VINEGAR,
        ingredientId: id,
      })),
    )
    render(
      <ReviewSheet
        api={api}
        week={WEEK}
        entries={[entry('a', 'Beet salad')]}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    )
    expect(
      await screen.findByRole('button', { name: 'Nothing to buy · done' }),
    ).toBeInTheDocument()
  })

  it('keeps the sheet open with a message when saving fails', async () => {
    const api = reviewApi()
    api.updateEntry.mockRejectedValueOnce(new Error('down'))
    const onDone = vi.fn()
    render(
      <ReviewSheet
        api={api}
        week={WEEK}
        entries={[entry('a', 'Beet salad')]}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    )
    await userEvent.click(
      await screen.findByRole('button', { name: /^Add 3 to the list/ }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't save that.",
    )
    expect(onDone).not.toHaveBeenCalled()
  })
})
