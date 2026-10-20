import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { filterRecipes, NO_FILTER, type SavedRecipe } from './library.ts'
import { route } from './navigation.ts'
import { weekOf, type Fit, type Scale } from './plan.ts'
import { RecipeForm } from './RecipeForm.tsx'
import { RecipePage } from './RecipePage.tsx'
import { Settings } from './Settings.tsx'
import {
  ingredientLines,
  manualInput,
  NO_PREFERENCES,
  type ManualRecipeInput,
  type Preferences,
  type RecipeDetail,
} from './sous.ts'

const line = (
  lineNo: number,
  rawText: string,
  extra: Record<string, unknown> = {},
) => ({
  lineNo,
  optionNo: 1,
  rawText,
  section: null,
  name: rawText.split(' ').slice(-2).join(' '),
  quantity: null,
  quantityMax: null,
  unit: null,
  preparation: null,
  isOptional: false,
  ...extra,
})

const BURRITOS: RecipeDetail = {
  id: '00000000-0000-0000-0000-000000000001',
  title: 'Bean burritos',
  sourceUrl: 'https://example-blog.com/burritos/',
  sourceName: 'Example Blog',
  sourceNote: null,
  license: null,
  saved: true,
  tags: [],
  servings: 4,
  prepMinutes: null,
  cookMinutes: null,
  totalMinutes: 25,
  instructions: null,
  handTyped: false,
  ingredients: [
    line(0, '1 can refried beans', { name: 'refried beans' }),
    line(1, '8 flour tortillas', { name: 'flour tortillas' }),
    line(1, '8 flour tortillas', { optionNo: 2, name: 'corn tortillas' }),
    line(2, 'Cilantro, to serve', {
      name: 'cilantro',
      isOptional: true,
      section: 'To serve',
    }),
  ],
  diets: [
    {
      slug: 'vegetarian',
      checks: [{ ingredient: 'refried beans', may_contain: ['meat'] }],
    },
  ],
  cuisines: ['mexican'],
}

const SOUP: RecipeDetail = {
  ...BURRITOS,
  id: '00000000-0000-0000-0000-000000000002',
  title: 'Grandma’s soup',
  sourceUrl: null,
  sourceName: null,
  sourceNote: 'Grandma',
  handTyped: true,
  instructions: ['Soften the onion.', 'Simmer.'],
  ingredients: [
    line(0, '1 onion', { name: 'onion', section: 'Soup' }),
    line(1, '1 cup lentils', { name: 'lentils', section: 'Soup' }),
  ],
  diets: [{ slug: 'vegan', checks: [] }],
}

describe('route', () => {
  it.each([
    ['/', { page: 'home' }],
    ['/recipes', { page: 'library' }],
    ['/share', { page: 'library' }],
    ['/list', { page: 'list', week: null }],
    ['/list/2026-10-12', { page: 'list', week: '2026-10-12' }],
    ['/pantry', { page: 'pantry' }],
    [`/recipe/${BURRITOS.id}`, { page: 'recipe', id: BURRITOS.id }],
    [`/edit/${SOUP.id}/`, { page: 'edit', id: SOUP.id }],
    ['/new', { page: 'new' }],
    ['/settings', { page: 'settings' }],
    ['/browse', { page: 'browse' }],
    ['/recipe/not-an-id', { page: 'library' }],
    ['/plan', { page: 'plan', week: null }],
    ['/plan/2026-10-12', { page: 'plan', week: '2026-10-12' }],
  ])('%s', (path, expected) => {
    expect(route(path)).toEqual(expected)
  })
})

describe('RecipePage', () => {
  const api = (r: RecipeDetail | null, fit: Fit = 'fits') => ({
    recipe: vi.fn(async () => r),
    remove: vi.fn(async () => {}),
    saveToLibrary: vi.fn(async (_id: string) => {}),
    addToPlan: vi.fn(async (_week: string, _id: string, _scale?: Scale) => {}),
    recipeFits: vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, fit])),
    ),
    setTags: vi.fn(async (_id: string, _tags: string[]) => {}),
  })

  it('shows where it is from, its labels, and stars the ingredient to check', async () => {
    render(<RecipePage id={BURRITOS.id} api={api(BURRITOS)} />)
    expect(
      await screen.findByRole('heading', { name: 'Bean burritos' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Example Blog · 25 min · serves 4'),
    ).toBeInTheDocument()
    expect(screen.getByText('Vegetarian*')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'View full recipe on Example Blog' }),
    ).toHaveAttribute('href', BURRITOS.sourceUrl)
    const beans = screen.getByText('1 can refried beans').closest('li')!
    expect(within(beans).getByLabelText('check the label')).toBeInTheDocument()
    // alternatives share one line
    expect(screen.getAllByText('8 flour tortillas')).toHaveLength(1)
    expect(screen.getByText('To serve')).toBeInTheDocument()
    expect(screen.getByText('(optional)')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Edit recipe' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Steps' })).toBeNull()
  })

  it('shows steps and Edit for the user’s own recipe', async () => {
    render(<RecipePage id={SOUP.id} api={api(SOUP)} />)
    expect(
      await screen.findByText('From Grandma · 25 min · serves 4'),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Steps' })).toBeInTheDocument()
    expect(screen.getByText('Simmer.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Edit recipe' })).toHaveAttribute(
      'href',
      `/edit/${SOUP.id}`,
    )
    expect(screen.getAllByText('Soup')).toHaveLength(1)
  })

  it('adds the recipe to this week at full size', async () => {
    const fake = api(SOUP)
    render(<RecipePage id={SOUP.id} api={fake} />)
    await userEvent.click(
      await screen.findByRole('button', { name: "Add to this week's plan" }),
    )
    expect(fake.addToPlan).toHaveBeenCalledWith(weekOf(), SOUP.id, 1)
    expect(
      await screen.findByRole('link', { name: 'See the plan' }),
    ).toHaveAttribute('href', '/plan')
  })

  it('adds and removes the user’s own tags on a saved recipe', async () => {
    const fake = api({ ...BURRITOS, tags: ['weeknight'] })
    render(<RecipePage id={BURRITOS.id} api={fake} />)
    const tags = await screen.findByRole('list', { name: 'Your tags' })
    expect(within(tags).getByText('weeknight')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Add a tag'), '  For   guests ')
    await userEvent.click(screen.getByRole('button', { name: 'Add tag' }))
    expect(fake.setTags).toHaveBeenCalledWith(BURRITOS.id, [
      'weeknight',
      'For guests',
    ])
    expect(await within(tags).findByText('For guests')).toBeInTheDocument()
    expect(screen.getByLabelText('Add a tag')).toHaveValue('')
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove tag weeknight' }),
    )
    expect(fake.setTags).toHaveBeenLastCalledWith(BURRITOS.id, ['For guests'])
  })

  it('has no tags for a recipe the user hasn’t saved', async () => {
    render(
      <RecipePage id={BURRITOS.id} api={api({ ...BURRITOS, saved: false })} />,
    )
    await screen.findByRole('heading', { name: 'Bean burritos' })
    expect(screen.queryByLabelText('Add a tag')).toBeNull()
  })

  it('warns before planning a recipe that breaks the user’s rules', async () => {
    const fake = api(BURRITOS, 'excluded')
    render(<RecipePage id={BURRITOS.id} api={fake} />)
    expect(
      await screen.findByText(/doesn't fit your diets or allergies/),
    ).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: "Add to this week's plan anyway" }),
    )
    expect(fake.addToPlan).toHaveBeenCalledWith(weekOf(), BURRITOS.id, 1)
  })

  it('credits an openly licensed recipe and shows its steps', async () => {
    const dal: RecipeDetail = {
      ...SOUP,
      id: '00000000-0000-0000-0000-000000000003',
      title: 'Dal',
      sourceUrl: 'https://en.wikibooks.org/wiki/Cookbook:Dal',
      sourceName: 'Wikibooks Cookbook',
      sourceNote: null,
      handTyped: false,
      instructions: ['Simmer the lentils.'],
      license: {
        name: 'CC BY-SA 4.0',
        url: 'https://creativecommons.org/licenses/by-sa/4.0/',
        attribution: 'Wikibooks contributors',
      },
    }
    render(<RecipePage id={dal.id} api={api(dal)} />)
    expect(await screen.findByText('Simmer the lentils.')).toBeInTheDocument()
    expect(screen.getByText(/by Wikibooks contributors/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-sa/4.0/',
    )
    expect(
      screen.getByRole('link', { name: 'Wikibooks Cookbook' }),
    ).toHaveAttribute('href', dal.sourceUrl)
    expect(screen.queryByRole('link', { name: /View full recipe/ })).toBeNull()
  })

  it('saves a recipe from the catalog to the user’s recipes', async () => {
    const fake = api({ ...BURRITOS, saved: false })
    render(<RecipePage id={BURRITOS.id} api={fake} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Save to my recipes' }),
    )
    expect(fake.saveToLibrary).toHaveBeenCalledWith(BURRITOS.id)
    expect(
      await screen.findByRole('button', { name: 'Remove from my recipes' }),
    ).toBeInTheDocument()
  })

  it('says when a recipe is not found', async () => {
    render(<RecipePage id={SOUP.id} api={api(null)} />)
    expect(
      await screen.findByRole('heading', { name: 'Recipe not found' }),
    ).toBeInTheDocument()
  })

  it('removes after confirming and goes back to the list', async () => {
    const a = api(SOUP)
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    window.history.replaceState(null, '', `/recipe/${SOUP.id}`)
    render(<RecipePage id={SOUP.id} api={a} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove from my recipes' }),
    )
    expect(a.remove).toHaveBeenCalledWith(SOUP.id)
    await waitFor(() => expect(window.location.pathname).toBe('/recipes'))
  })
})

describe('RecipeForm', () => {
  it('saves a new recipe and opens it', async () => {
    const api = {
      recipe: vi.fn(),
      saveManual: vi.fn(async () => SOUP.id),
      readPhotos: vi.fn(),
    }
    render(<RecipeForm api={api} />)
    const save = screen.getByRole('button', { name: 'Save recipe' })
    expect(save).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Title'), 'Lentil soup')
    await userEvent.type(screen.getByLabelText('Ingredients'), '1 cup lentils')
    await userEvent.type(screen.getByLabelText('Serves'), '4')
    await userEvent.click(save)
    expect(api.saveManual).toHaveBeenCalledWith(
      {
        title: 'Lentil soup',
        ingredients: '1 cup lentils',
        instructions: '',
        servings: 4,
        totalMinutes: null,
        sourceNote: '',
      },
      undefined,
    )
    await waitFor(() =>
      expect(window.location.pathname).toBe(`/recipe/${SOUP.id}`),
    )
  })

  it('edits the user’s own recipe, starting from what they typed', async () => {
    const api = {
      recipe: vi.fn(async () => SOUP),
      readPhotos: vi.fn(),
      saveManual: vi.fn(
        async (_input: ManualRecipeInput, _id?: string) => SOUP.id,
      ),
    }
    render(<RecipeForm api={api} recipeId={SOUP.id} />)
    expect(await screen.findByLabelText('Title')).toHaveValue('Grandma’s soup')
    expect(screen.getByLabelText('Ingredients')).toHaveValue(
      'Soup:\n1 onion\n1 cup lentils',
    )
    expect(screen.getByLabelText('Steps')).toHaveValue(
      'Soften the onion.\nSimmer.',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(api.saveManual.mock.calls[0][1]).toBe(SOUP.id)
  })

  it('refuses to edit an imported recipe', async () => {
    const api = {
      recipe: vi.fn(async () => BURRITOS),
      saveManual: vi.fn(),
      readPhotos: vi.fn(),
    }
    render(<RecipeForm api={api} recipeId={BURRITOS.id} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "can't be edited",
    )
  })

  it('shows why a save failed', async () => {
    const api = {
      recipe: vi.fn(),
      readPhotos: vi.fn(),
      saveManual: vi.fn(async () => {
        throw new Error("We couldn't save the recipe. Try again.")
      }),
    }
    render(<RecipeForm api={api} />)
    await userEvent.type(screen.getByLabelText('Title'), 'Soup')
    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("couldn't save")
  })
})

describe('Settings', () => {
  const api = () => ({
    preferences: vi.fn(async () => ({
      ...NO_PREFERENCES,
      diets: ['vegetarian'],
    })),
    savePreferences: vi.fn(async (_p: Preferences) => {}),
    options: vi.fn(async () => ({
      diets: [
        { slug: 'vegan', name: 'Vegan' },
        { slug: 'vegetarian', name: 'Vegetarian' },
      ],
      cuisines: [{ slug: 'thai', name: 'Thai' }],
    })),
    searchIngredients: vi.fn(async (q: string) =>
      q.startsWith('cil') ? [{ id: 'i1', name: 'cilantro' }] : [],
    ),
    storesNear: vi.fn(async (_zip: string) => [
      {
        locationId: '09700181',
        chainSlug: 'harris_teeter',
        name: 'Harris Teeter - Arctic Avenue',
        address: '2800 Arctic Ave',
        city: 'Virginia Beach',
        state: 'VA',
        zip: '23451',
      },
    ]),
    myStore: vi.fn(async () => ({
      name: 'Harris Teeter – Village at Chestnut Street',
      address: null,
    })),
    chooseStore: vi.fn(async (_id: string) => {}),
    exportMyData: vi.fn(async () => '{"profile": null}'),
    deleteMyAccount: vi.fn(async () => {}),
  })

  it('lets the household size be cleared and retyped', async () => {
    const a = api()
    render(
      <Settings
        api={a}
        email="cook@example.com"
        onSaved={vi.fn()}
        onSignOut={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    const size = await screen.findByLabelText('People you cook for')
    await userEvent.clear(size)
    expect(size).toHaveValue(null)
    await userEvent.type(size, '4')
    expect(size).toHaveValue(4)
    await userEvent.clear(size)
    await userEvent.type(size, '0')
    await userEvent.tab()
    expect(size).toHaveValue(4) // out of range: back to the last good size
    await userEvent.click(
      screen.getByRole('button', { name: 'Save preferences' }),
    )
    expect(a.savePreferences.mock.calls[0][0].householdSize).toBe(4)
  })

  it('loads, changes and saves preferences', async () => {
    const a = api()
    const onSaved = vi.fn()
    render(
      <Settings
        api={a}
        email="cook@example.com"
        onSaved={onSaved}
        onSignOut={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    const diets = within(await screen.findByRole('group', { name: 'Diets' }))
    expect(diets.getByRole('button', { name: 'Vegetarian' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await userEvent.click(diets.getByRole('button', { name: 'Vegan' }))
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Allergies' })).getByRole(
        'button',
        {
          name: 'Peanuts',
        },
      ),
    )
    await userEvent.click(
      within(
        screen.getByRole('group', { name: 'Favorite cuisines' }),
      ).getByRole('button', {
        name: 'Thai',
      }),
    )
    await userEvent.type(
      screen.getByLabelText(
        'Find an ingredient to add to disliked ingredients',
      ),
      'cil',
    )
    await userEvent.click(
      await screen.findByRole('button', { name: '+ cilantro' }),
    )
    await userEvent.type(
      screen.getByLabelText('Weekly grocery budget ($)'),
      '120',
    )
    await userEvent.click(
      screen.getByLabelText(/only fit with the right brand/),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Save preferences' }),
    )
    const saved = a.savePreferences.mock.calls[0][0]
    expect(saved).toMatchObject({
      saved: true,
      diets: ['vegetarian', 'vegan'],
      allergens: ['peanut'],
      favoriteCuisines: ['thai'],
      dislikedIngredients: [{ id: 'i1', name: 'cilantro' }],
      weeklyBudgetCents: 12000,
      strictMayContain: true,
    })
    expect(onSaved).toHaveBeenCalledWith(saved)
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
  })

  it('says when saving fails', async () => {
    const a = api()
    a.savePreferences.mockRejectedValueOnce(new Error('nope'))
    render(
      <Settings
        api={a}
        email="x"
        onSaved={vi.fn()}
        onSignOut={vi.fn()}
        onDeleted={vi.fn()}
      />,
    )
    await userEvent.click(
      await screen.findByRole('button', { name: 'Save preferences' }),
    )
    expect(
      await screen.findByText(/couldn't save your preferences/),
    ).toBeInTheDocument()
  })
})

describe('helpers', () => {
  it('keeps one line per ingredient and rebuilds the typed text', () => {
    expect(ingredientLines(BURRITOS.ingredients).map((l) => l.rawText)).toEqual(
      ['1 can refried beans', '8 flour tortillas', 'Cilantro, to serve'],
    )
    expect(manualInput(SOUP)).toMatchObject({
      ingredients: 'Soup:\n1 onion\n1 cup lentils',
      instructions: 'Soften the onion.\nSimmer.',
      sourceNote: 'Grandma',
    })
  })

  const r = (over: Partial<SavedRecipe>): SavedRecipe => ({
    id: 'x',
    title: 'Red lentil dal',
    sourceUrl: null,
    sourceName: null,
    sourceNote: null,
    totalMinutes: 35,
    savedAt: '',
    diets: [],
    ingredients: [],
    tags: [],
    cuisines: [],
    ...over,
  })

  it('filters by words, diets and time', () => {
    const dal = r({
      ingredients: ['red lentils', 'spinach'],
      diets: [{ slug: 'vegan', checks: [] }],
    })
    const tacos = r({
      title: 'Fish tacos',
      totalMinutes: 20,
      ingredients: ['cod'],
    })
    const all = [dal, tacos]
    expect(filterRecipes(all, NO_FILTER)).toEqual(all)
    expect(filterRecipes(all, { ...NO_FILTER, query: 'lent spin' })).toEqual([
      dal,
    ])
    expect(filterRecipes(all, { ...NO_FILTER, query: 'COD' })).toEqual([tacos])
    expect(filterRecipes(all, { ...NO_FILTER, diets: ['vegan'] })).toEqual([
      dal,
    ])
    expect(filterRecipes(all, { ...NO_FILTER, maxMinutes: 30 })).toEqual([
      tacos,
    ])
  })
})
