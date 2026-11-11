import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CookMode } from './CookMode.tsx'
import { fakeCookedApi } from './cookedFake.ts'
import { RecipePage, type RecipePageApi } from './RecipePage.tsx'
import type { IngredientLine, RecipeDetail } from './sous.ts'
import { swapText, type Swap, type SwapFit } from './swaps.ts'

const line = (
  lineNo: number,
  rawText: string,
  extra: Partial<IngredientLine> = {},
): IngredientLine => ({
  lineNo,
  optionNo: 1,
  rawText,
  section: null,
  name: null,
  quantity: null,
  quantityMax: null,
  unit: null,
  preparation: null,
  isOptional: false,
  ingredientId: null,
  ...extra,
})

const BUTTERMILK = line(0, '1 cup buttermilk', {
  name: 'buttermilk',
  quantity: 1,
  unit: 'cup',
  ingredientId: 'i-buttermilk',
})
const EGGS = line(1, '2 eggs', {
  name: 'eggs',
  quantity: 2,
  ingredientId: 'i-eggs',
})

const swap = (over: Partial<Swap>): Swap => ({
  id: 's1',
  fromId: 'i-buttermilk',
  toId: 'i-milk',
  toName: 'whole milk',
  factor: 1,
  toUnit: null,
  perUnit: null,
  extras: ['lemon juice'],
  uses: 'any',
  quality: 'good',
  note: 'Stir 1 tbsp lemon juice into each cup of milk.',
  ...over,
})
const MILK = swap({})
const YOGURT = swap({
  id: 's2',
  toId: 'i-yogurt',
  toName: 'plain yogurt',
  factor: 0.75,
  extras: [],
  quality: 'pinch',
  note: 'Thin it with milk.',
})
const FLAX = swap({
  id: 's3',
  fromId: 'i-eggs',
  toId: 'i-flax',
  toName: 'flaxseed',
  toUnit: 'tbsp',
  perUnit: 'each',
  extras: ['water'],
  uses: 'baking',
  note: 'Per egg: 1 tbsp ground flaxseed and 3 tbsp water.',
})

const PANCAKES: RecipeDetail = {
  id: '00000000-0000-0000-0000-000000000077',
  title: 'Buttermilk pancakes',
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
  instructions: ['Mix and fry.'],
  handTyped: true,
  ingredients: [BUTTERMILK, EGGS],
  diets: [],
  cuisines: [],
  cuisinesCorrected: false,
}

describe('swap text (TYL-77)', () => {
  it('works out the amount where the units allow', () => {
    expect(swapText(BUTTERMILK, MILK)).toBe('1 cup whole milk + lemon juice')
    expect(swapText(BUTTERMILK, YOGURT)).toBe('¾ cup plain yogurt')
    expect(swapText(EGGS, FLAX)).toBe('2 tbsp flaxseed + water')
    // Cups of something swapped per egg: no amount to work out.
    expect(swapText(BUTTERMILK, { ...FLAX, extras: [] })).toBe('flaxseed')
    expect(swapText({ ...BUTTERMILK, quantity: null }, MILK)).toBe(
      'whole milk + lemon juice',
    )
  })
})

function recipeApi(
  over: Partial<RecipePageApi> = {},
): RecipePageApi & Record<string, ReturnType<typeof vi.fn>> {
  return {
    recipe: vi.fn(async () => PANCAKES),
    remove: vi.fn(async () => {}),
    saveToLibrary: vi.fn(async () => {}),
    addToPlan: vi.fn(async () => {}),
    recipeFits: vi.fn(async () => ({ [PANCAKES.id]: 'fits' as const })),
    setTags: vi.fn(async () => {}),
    options: vi.fn(async () => ({ cuisines: [] })),
    setMyCuisines: vi.fn(async () => {}),
    addedCosts: vi.fn(async () => ({
      budgetCents: null,
      totalCents: 0,
      recipes: {},
    })),
    swapsFor: vi.fn(async () => [MILK, YOGURT, FLAX]),
    recipeSwaps: vi.fn(async () => ({})),
    setRecipeSwap: vi.fn(async () => {}),
    swapFit: vi.fn(async (): Promise<SwapFit | null> => null),
    ...fakeCookedApi(),
    ...over,
  } as unknown as RecipePageApi & Record<string, ReturnType<typeof vi.fn>>
}

describe('swaps on the recipe page (TYL-77)', () => {
  it('offers swaps for a line, and keeps the one chosen', async () => {
    const api = recipeApi({
      onHandIn: vi.fn(async () => [
        { ingredientId: 'i-yogurt', name: 'plain yogurt' },
      ]),
    } as Partial<RecipePageApi>)
    render(<RecipePage id={PANCAKES.id} api={api} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Swap buttermilk' }),
    )
    const sheet = screen.getByRole('dialog', { name: 'Swap buttermilk' })
    const options = within(sheet).getAllByRole('button', { pressed: false })
    // What they have comes first.
    expect(options[0]).toHaveTextContent('¾ cup plain yogurt')
    expect(options[0]).toHaveTextContent('You have it')
    expect(options[0]).toHaveTextContent('In a pinch')
    await userEvent.click(
      within(sheet).getByRole('button', {
        name: /1 cup whole milk \+ lemon juice/,
      }),
    )
    expect(api.setRecipeSwap).toHaveBeenCalledWith(
      PANCAKES.id,
      'i-buttermilk',
      's1',
    )
    expect(
      screen.getByText(/→ 1 cup whole milk \+ lemon juice/),
    ).toBeInTheDocument()
    // And back to the recipe's.
    await userEvent.click(
      screen.getByRole('button', { name: 'Swap buttermilk' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Keep the recipe’s' }),
    )
    expect(api.setRecipeSwap).toHaveBeenLastCalledWith(
      PANCAKES.id,
      'i-buttermilk',
      null,
    )
    expect(screen.queryByText(/→ 1 cup whole milk/)).not.toBeInTheDocument()
  })

  it('says how many swaps make it fit, and marks those lines', async () => {
    const api = recipeApi({
      recipeFits: vi.fn(async () => ({ [PANCAKES.id]: 'excluded' as const })),
      swapFit: vi.fn(async () => ({ count: 1, fixes: { 'i-eggs': ['s3'] } })),
    })
    render(<RecipePage id={PANCAKES.id} api={api} />)
    expect(
      await screen.findByText(
        'Fits your diets and allergies with 1 swap: tap Swap on the marked line.',
      ),
    ).toBeInTheDocument()
    const eggs = screen.getByText('2 eggs').closest('li')!
    expect(within(eggs).getByText('swap to fit')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Swap eggs' }))
    expect(screen.getByText('Fits your diet')).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: /2 tbsp flaxseed \+ water/ }),
    )
    expect(
      await screen.findByText('Fits your diets and allergies with your swaps.'),
    ).toBeInTheDocument()
    expect(within(eggs).queryByText('swap to fit')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: "Add to this week's plan" }),
    ).toBeInTheDocument()
  })

  it('undoes a swap that can’t be saved', async () => {
    const api = recipeApi({
      setRecipeSwap: vi.fn(async () => {
        throw new Error('down')
      }),
    })
    render(<RecipePage id={PANCAKES.id} api={api} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Swap buttermilk' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: /1 cup whole milk/ }),
    )
    await waitFor(() =>
      expect(screen.queryByText(/→ 1 cup whole milk/)).not.toBeInTheDocument(),
    )
  })
})

describe('swaps in cook mode (TYL-77)', () => {
  const cookApi = (chosen: Record<string, string> = {}) => ({
    recipe: vi.fn(async () => PANCAKES),
    recipeSwaps: vi.fn(async () => chosen),
    swapsFor: vi.fn(async () => [MILK, YOGURT, FLAX]),
    setRecipeSwap: vi.fn(async () => {}),
    ...fakeCookedApi(),
  })

  it('shows the chosen swaps at the planned size', async () => {
    const api = cookApi({ 'i-eggs': 's3' })
    render(<CookMode api={api} id={PANCAKES.id} scale={2} />)
    expect(
      await screen.findByText(/→ 4 tbsp flaxseed \+ water/),
    ).toBeInTheDocument()
    expect(api.swapsFor).toHaveBeenCalledWith(['i-buttermilk', 'i-eggs'])
  })

  it('offers swaps for something you’re out of, and keeps the one chosen', async () => {
    const api = cookApi()
    render(<CookMode api={api} id={PANCAKES.id} scale={2} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Out of buttermilk?' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: /2 cups whole milk \+ lemon juice/ }),
    )
    expect(api.setRecipeSwap).toHaveBeenCalledWith(
      PANCAKES.id,
      'i-buttermilk',
      's1',
    )
    expect(
      screen.getByText(/→ 2 cups whole milk \+ lemon juice/),
    ).toBeInTheDocument()
  })
})
