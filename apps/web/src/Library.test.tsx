import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Library, type LibraryApi } from './Library.tsx'
import { ImportError, type ImportResult, type SavedRecipe } from './library.ts'

const DAL: SavedRecipe = {
  id: 'r1',
  title: 'Red lentil dal',
  sourceUrl: 'https://www.example-blog.com/dal/',
  sourceName: null,
  totalMinutes: 35,
  savedAt: '2026-10-09T00:00:00Z',
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
  remove: ReturnType<typeof vi.fn>
} {
  return {
    list: vi.fn(async () => recipes),
    save: vi.fn(async () => SAVED),
    savePage: vi.fn(async () => SAVED),
    remove: vi.fn(async () => {}),
  }
}

describe('Library', () => {
  it('lists saved recipes with their source and time', async () => {
    render(<Library api={fakeApi([DAL])} />)
    const link = await screen.findByRole('link', { name: 'Red lentil dal' })
    expect(link).toHaveAttribute('href', DAL.sourceUrl)
    expect(screen.getByText('example-blog.com · 35 min')).toBeInTheDocument()
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
      new ImportError('blocked', 'This site blocks automated imports.'),
    )
    render(<Library api={api} />)
    await userEvent.type(
      screen.getByLabelText('Recipe link'),
      'https://x.example/',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This site blocks automated imports.',
    )
  })

  it('fills in a shared link but saves it only when the user taps Save', async () => {
    const api = fakeApi()
    render(<Library api={api} sharedUrl={SAVED.source_url} />)
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

  it('opens the Save to Sous help when a site blocks Sous', async () => {
    const api = fakeApi()
    api.save.mockRejectedValueOnce(
      new ImportError('blocked', 'This site blocks automated imports.'),
    )
    render(<Library api={api} />)
    const help = screen
      .getByText('Recipe from a site that blocks Sous?')
      .closest('details')!
    expect(help).not.toHaveAttribute('open')
    await userEvent.type(
      screen.getByLabelText('Recipe link'),
      'https://x.example/',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Save to Sous')
    expect(help).toHaveAttribute('open')
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
