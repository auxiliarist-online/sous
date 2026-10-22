import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Library, type LibraryApi } from './Library.tsx'
import { ImportError, type ImportResult, type SavedRecipe } from './library.ts'

const DAL: SavedRecipe = {
  id: 'r1',
  title: 'Red lentil dal',
  sourceUrl: 'https://www.example-blog.com/dal/',
  sourceName: null,
  sourceNote: null,
  ingredients: ['red lentils', 'spinach'],
  tags: [],
  cuisines: [],
  favorite: null,
  totalMinutes: 35,
  savedAt: '2026-10-09T00:00:00Z',
  diets: [
    { slug: 'vegetarian', checks: [] },
    { slug: 'vegan', checks: [] },
    { slug: 'gluten_free', checks: [] },
  ],
}

const SAVED: ImportResult = {
  recipe_id: 'r2',
  created: true,
  title: 'Black bean tacos',
  source_name: 'Example Blog',
  source_url: 'https://example-blog.com/tacos/',
  visibility: 'private',
  status: 'needs_review',
}

function fakeApi(recipes: SavedRecipe[] = []): LibraryApi & {
  list: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  savePage: ReturnType<typeof vi.fn>
  saveText: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  return {
    list: vi.fn(async () => recipes),
    save: vi.fn(async () => SAVED),
    savePage: vi.fn(async () => SAVED),
    saveText: vi.fn(async () => SAVED),
    remove: vi.fn(async () => {}),
    seasons: vi.fn(async () => new Map()),
  }
}

describe('Library', () => {
  it('lists saved recipes with their source and time', async () => {
    render(<Library api={fakeApi([DAL])} />)
    const link = await screen.findByRole('link', { name: 'Red lentil dal' })
    expect(link).toHaveAttribute('href', '/recipe/r1')
    const list = within(screen.getByRole('list', { name: 'Your recipes' }))
    expect(list.getByText('example-blog.com · 35 min')).toBeInTheDocument()
    expect(list.getByText('Vegan')).toBeInTheDocument()
    expect(list.getByText('Gluten-free')).toBeInTheDocument()
    expect(list.queryByText('Vegetarian')).toBeNull()
    expect(screen.getByText(/always check the packaging/)).toBeInTheDocument()
  })

  it('says how to start when nothing is saved', async () => {
    render(<Library api={fakeApi()} />)
    expect(await screen.findByText(/Nothing saved yet/)).toBeInTheDocument()
  })

  it('saves a pasted link and points to the full recipe on the source', async () => {
    const api = fakeApi()
    render(<Library api={api} />)
    await userEvent.type(
      screen.getByLabelText('Recipe link'),
      'example-blog.com/tacos/',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(api.save).toHaveBeenCalledWith('https://example-blog.com/tacos/')
    const view = await screen.findByRole('link', {
      name: 'View full recipe on Example Blog',
    })
    expect(view).toHaveAttribute('href', SAVED.source_url)
    expect(
      screen.getByText('Only you can see this recipe.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Recipe link')).toHaveValue('')
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
  })

  it("shows the API's explanation when a recipe can't be saved", async () => {
    const api = fakeApi()
    api.save.mockRejectedValueOnce(
      new ImportError(
        'not_a_recipe',
        "We couldn't find a recipe on that page.",
      ),
    )
    render(<Library api={api} />)
    await userEvent.type(
      screen.getByLabelText('Recipe link'),
      'https://x.example/',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't find a recipe on that page.",
    )
  })

  it('fills in a shared link but saves it only when the user taps Save', async () => {
    const api = fakeApi()
    render(
      <Library
        api={api}
        shared={{ url: SAVED.source_url, ingredients: null }}
      />,
    )
    expect(
      screen.getByRole('heading', { name: 'Save the recipe you shared?' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Recipe link')).toHaveValue(SAVED.source_url)
    await screen.findByText(/Nothing saved yet/)
    expect(api.save).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(api.save).toHaveBeenCalledWith(SAVED.source_url)
    expect(await screen.findByText('Black bean tacos')).toBeInTheDocument()
  })

  it('saves a page from Save to Sous only when the user taps Save', async () => {
    const api = fakeApi()
    const page = {
      url: 'https://blocked.example/chana/',
      siteName: 'Blocked Blog',
      ld: [JSON.stringify({ '@type': 'Recipe', name: 'Chana masala' })],
    }
    render(<Library api={api} sharedPage={page} />)
    expect(
      screen.getByRole('heading', {
        name: 'Save the recipe from Blocked Blog?',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('Chana masala')).toBeInTheDocument()
    expect(api.savePage).not.toHaveBeenCalled()

    const saves = screen.getAllByRole('button', { name: 'Save recipe' })
    await userEvent.click(saves[saves.length - 1])
    expect(api.savePage).toHaveBeenCalledWith(page)
    expect(await screen.findByText('Black bean tacos')).toBeInTheDocument()
    expect(screen.queryByText('Save the recipe from Blocked Blog?')).toBeNull()
  })

  it('lets the user dismiss a page from Save to Sous', async () => {
    const api = fakeApi()
    const page = {
      url: 'https://blocked.example/x/',
      siteName: null,
      ld: ['{}'],
    }
    render(<Library api={api} sharedPage={page} />)
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText(/Save the recipe from/)).toBeNull()
    expect(api.savePage).not.toHaveBeenCalled()
  })

  it.each([
    ['blocked', 'This site blocks automated imports.'],
    ['robots_disallowed', 'This site asks apps not to read its pages.'],
  ])(
    'offers to paste the ingredients when a site turns Sous away (%s)',
    async (code, message) => {
      const api = fakeApi()
      api.save.mockRejectedValueOnce(new ImportError(code, message))
      render(<Library api={api} />)
      await userEvent.type(
        screen.getByLabelText('Recipe link'),
        'https://www.seriouseats.com/the-best-chili-recipe-5089384',
      )
      await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
      expect(
        await screen.findByRole('heading', {
          name: "seriouseats.com doesn't let apps read its recipes",
        }),
      ).toBeInTheDocument()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByLabelText('Name')).toHaveValue('The Best Chili Recipe')
      expect(
        screen.getByRole('link', {
          name: 'Open the recipe on seriouseats.com',
        }),
      ).toHaveAttribute(
        'href',
        'https://www.seriouseats.com/the-best-chili-recipe-5089384',
      )

      // Pasting the whole page keeps only the ingredients.
      await userEvent.click(screen.getByLabelText('Ingredients'))
      await userEvent.paste(
        'The Best Chili\nIngredients\n▢ 2 lb ground beef\n• 1 onion, diced\nDirections\nBrown the beef.',
      )
      expect(screen.getByLabelText('Ingredients')).toHaveValue(
        '2 lb ground beef\n1 onion, diced',
      )
      await userEvent.click(
        screen.getByRole('button', { name: 'Save to my recipes' }),
      )
      expect(api.saveText).toHaveBeenCalledWith({
        url: 'https://www.seriouseats.com/the-best-chili-recipe-5089384',
        title: 'The Best Chili Recipe',
        ingredients: ['2 lb ground beef', '1 onion, diced'],
      })
      expect(await screen.findByText('Black bean tacos')).toBeInTheDocument()
      expect(screen.queryByLabelText('Ingredients')).toBeNull()
    },
  )

  it('offers to paste the ingredients when saving from a link fails on our side', async () => {
    const api = fakeApi()
    api.save.mockRejectedValueOnce(
      new ImportError('error', 'Something went wrong saving that recipe.'),
    )
    render(<Library api={api} />)
    await userEvent.type(
      screen.getByLabelText('Recipe link'),
      'https://www.easycheesyvegetarian.com/simple-stuffed-mushrooms/',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(
      await screen.findByRole('heading', {
        name: "We couldn't save that recipe from easycheesyvegetarian.com",
      }),
    ).toBeInTheDocument()
    expect(screen.getByText(/it's been reported/)).toBeInTheDocument()
    expect(screen.getByLabelText('Ingredients')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows other failures as they are, without the paste form', async () => {
    const api = fakeApi()
    api.save.mockRejectedValueOnce(new Error('Load failed'))
    render(<Library api={api} />)
    await userEvent.type(
      screen.getByLabelText('Recipe link'),
      'https://example-blog.com/tacos/',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Load failed')
    expect(screen.queryByLabelText('Ingredients')).toBeNull()
  })

  it('can save just the link when nothing is pasted', async () => {
    const api = fakeApi()
    api.save.mockRejectedValueOnce(new ImportError('blocked', 'Blocked.'))
    render(<Library api={api} />)
    await userEvent.type(
      screen.getByLabelText('Recipe link'),
      'https://blocked.example/soup/',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    await userEvent.click(
      await screen.findByRole('button', { name: 'Save the link for now' }),
    )
    expect(api.saveText).toHaveBeenCalledWith({
      url: 'https://blocked.example/soup/',
      title: 'Soup',
      ingredients: [],
    })
  })

  it('saves a shared selection of ingredients only when the user taps Save', async () => {
    const api = fakeApi()
    render(
      <Library
        api={api}
        shared={{
          url: 'https://blocked.example/green-curry/',
          ingredients: '1 can coconut milk\n2 tbsp green curry paste',
        }}
      />,
    )
    expect(
      screen.getByRole('heading', { name: 'Save the ingredients you shared?' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Ingredients')).toHaveValue(
      '1 can coconut milk\n2 tbsp green curry paste',
    )
    expect(screen.getByText(/2 ingredients/)).toBeInTheDocument()
    expect(api.saveText).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Save to my recipes' }),
    )
    expect(api.saveText).toHaveBeenCalledWith({
      url: 'https://blocked.example/green-curry/',
      title: 'Green Curry',
      ingredients: ['1 can coconut milk', '2 tbsp green curry paste'],
    })
  })

  it('keeps the Save to Sous bookmark for computers', () => {
    render(<Library api={fakeApi()} />)
    expect(
      screen.getByText('On a computer? Add the Save to Sous bookmark'),
    ).toBeInTheDocument()
    expect(screen.getByText('Save to Sous', { selector: 'a' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^javascript:/),
    )
  })

  it('removes a recipe after confirming', async () => {
    const api = fakeApi([DAL])
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    render(<Library api={api} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove Red lentil dal' }),
    )
    expect(api.remove).toHaveBeenCalledWith('r1')
  })
})
