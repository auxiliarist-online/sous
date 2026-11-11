import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CookMode } from './CookMode.tsx'
import { fakeCookedApi } from './cookedFake.ts'
import { RecipePage, type RecipePageApi } from './RecipePage.tsx'
import type { IngredientLine, RecipeDetail } from './sous.ts'
import { swapText, type Swap, type SwapFit } from './swaps.ts'
import type { PantryEntry } from './pantry.ts'

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
  extraIds: ['i-lemon'],
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
  extraIds: [],
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
  extraIds: ['i-water'],
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

const have = (ingredientId: string): PantryEntry => ({
  ingredientId,
  name: ingredientId,
  status: 'have',
  kind: 'on_hand',
  group: null,
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
    pantry: vi.fn(async () => []),
    ...fakeCookedApi(),
    ...over,
  } as unknown as RecipePageApi & Record<string, ReturnType<typeof vi.fn>>
}

describe('swaps on the recipe page (TYL-77)', () => {
  it('offers swaps for a line, and keeps the one chosen', async () => {
    // The pantry has yogurt, which the recipe doesn't use.
    const api = recipeApi({
      pantry: vi.fn(async () => [have('i-yogurt')]),
    })
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
      swapFit: vi
        .fn()
        .mockResolvedValueOnce({
          count: 1,
          fixes: { 'i-eggs': ['s3'] },
          chosen: false,
        })
        .mockResolvedValue({
          count: 1,
          fixes: { 'i-eggs': ['s3'] },
          chosen: true,
        }),
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

describe('swaps on the recipe page, carefully (TYL-77)', () => {
  it('trusts the server on fit: a swap that brings something back doesn’t pass', async () => {
    const api = recipeApi({
      recipeFits: vi.fn(async () => ({ [PANCAKES.id]: 'excluded' as const })),
      // The fixing swap is chosen, but another swap brought something back.
      recipeSwaps: vi.fn(async () => ({ 'i-eggs': 's3' })),
      swapFit: vi.fn(async () => ({
        count: 1,
        fixes: { 'i-eggs': ['s3'] },
        chosen: false,
      })),
    })
    render(<RecipePage id={PANCAKES.id} api={api} />)
    expect(
      await screen.findByText(/Fits your diets and allergies with 1 swap/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: "Add to this week's plan anyway" }),
    ).toBeInTheDocument()
  })

  it('reloads the cost after a swap, and puts a swapped line by what’s in the pantry', async () => {
    const api = recipeApi({
      onHandIn: vi.fn(async () => [
        { ingredientId: 'i-buttermilk', name: 'buttermilk' },
      ]),
      pantry: vi.fn(async () => [have('i-buttermilk')]),
    } as Partial<RecipePageApi>)
    render(<RecipePage id={PANCAKES.id} api={api} />)
    await screen.findByText('You have (1)')
    await userEvent.click(
      await screen.findByRole('button', { name: 'Swap buttermilk' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: /1 cup whole milk/ }),
    )
    // No milk at home: it's to buy now.
    await waitFor(() =>
      expect(screen.queryByText('You have (1)')).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(api.addedCosts).toHaveBeenCalledTimes(2))
  })

  it('keeps a swap chosen while the saved ones load', async () => {
    let answer: (c: Record<string, string>) => void = () => {}
    const api = recipeApi({
      recipeSwaps: vi.fn(
        () => new Promise<Record<string, string>>((r) => (answer = r)),
      ),
    })
    render(<RecipePage id={PANCAKES.id} api={api} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Swap buttermilk' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: /1 cup whole milk/ }),
    )
    answer({ 'i-eggs': 's3' })
    expect(await screen.findByText(/→ 2 tbsp flaxseed/)).toBeInTheDocument()
    expect(screen.getByText(/→ 1 cup whole milk/)).toBeInTheDocument()
  })

  it('goes back to the saved swap when an early choice fails', async () => {
    let answer: (c: Record<string, string>) => void = () => {}
    const api = recipeApi({
      recipeSwaps: vi.fn(
        () => new Promise<Record<string, string>>((r) => (answer = r)),
      ),
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
    await waitFor(() => expect(api.setRecipeSwap).toHaveBeenCalled())
    // The saved swap arrives after the failed choice: it's what shows.
    answer({ 'i-buttermilk': 's2' })
    expect(await screen.findByText(/→ ¾ cup plain yogurt/)).toBeInTheDocument()
    expect(screen.queryByText(/→ 1 cup whole milk/)).not.toBeInTheDocument()
  })

  it('undoes only the swap that failed, back to what’s saved', async () => {
    let fail: () => void = () => {}
    const api = recipeApi({
      recipeSwaps: vi.fn(async () => ({ 'i-buttermilk': 's2' })),
      setRecipeSwap: vi.fn(async (_r: string, from: string) => {
        if (from === 'i-buttermilk')
          await new Promise<void>(
            (_, reject) => (fail = () => reject(new Error('down'))),
          )
      }),
    })
    render(<RecipePage id={PANCAKES.id} api={api} />)
    expect(await screen.findByText(/→ ¾ cup plain yogurt/)).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Swap buttermilk' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: /1 cup whole milk/ }),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Swap eggs' }))
    await userEvent.click(
      screen.getByRole('button', { name: /2 tbsp flaxseed/ }),
    )
    fail()
    // Buttermilk goes back to the saved yogurt; the eggs' swap stays.
    expect(await screen.findByText(/→ ¾ cup plain yogurt/)).toBeInTheDocument()
    expect(screen.getByText(/→ 2 tbsp flaxseed/)).toBeInTheDocument()
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

  it('says when a swap couldn’t be saved, keeps it here, and tries again', async () => {
    const api = {
      ...cookApi(),
      setRecipeSwap: vi
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValue(undefined),
    }
    render(<CookMode api={api} id={PANCAKES.id} scale={1} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Out of buttermilk?' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: /1 cup whole milk/ }),
    )
    expect(
      await screen.findByText(/they're only in cook mode for now/),
    ).toBeInTheDocument()
    expect(screen.getByText(/→ 1 cup whole milk/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() =>
      expect(
        screen.queryByText(/they're only in cook mode for now/),
      ).not.toBeInTheDocument(),
    )
    expect(api.setRecipeSwap).toHaveBeenCalledTimes(2)
  })

  it('keeps saying a swap wasn’t saved during the steps', async () => {
    let fail: () => void = () => {}
    const api = {
      ...cookApi(),
      setRecipeSwap: vi.fn(
        () =>
          new Promise<void>(
            (_, reject) => (fail = () => reject(new Error('down'))),
          ),
      ),
    }
    render(<CookMode api={api} id={PANCAKES.id} scale={1} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Out of buttermilk?' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: /1 cup whole milk/ }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Start the steps' }),
    )
    fail()
    expect(
      await screen.findByText(/they're only in cook mode for now/),
    ).toBeInTheDocument()
  })
})
