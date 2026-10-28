import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Browse } from './Browse.tsx'
import { clearBrowseCache } from './browseCache.ts'
import type { CatalogRecipe } from './sous.ts'
import { weekOf, type Fit } from './plan.ts'

const FRITTATA: CatalogRecipe = {
  id: 'a',
  title: 'Frittata',
  sourceName: 'Wikibooks Cookbook',
  totalMinutes: 25,
  fit: 'fits',
  why: ['a main ingredient'],
}
const PIE: CatalogRecipe = {
  id: 'b',
  title: 'Egg pie',
  sourceName: 'Wikibooks Cookbook',
  totalMinutes: null,
  fit: 'unknown',
  why: ['not every ingredient could be checked'],
}

function fakeApi(pages: CatalogRecipe[][] = [[FRITTATA, PIE]]) {
  return {
    searchCatalog: vi.fn(async (_q: string, offset = 0) =>
      offset === 0 ? pages[0] : (pages[1] ?? []),
    ),
    addToPlan: vi.fn(async () => {}),
    recipeFits: vi.fn(async (): Promise<Record<string, Fit>> => ({})),
  }
}

afterEach(() => {
  clearBrowseCache()
  sessionStorage.clear()
})

describe('Browse', () => {
  it('shows results with their source, time and why they rank', async () => {
    render(<Browse api={fakeApi()} />)
    const list = await screen.findByRole('list', { name: 'Recipes found' })
    expect(
      within(list).getByRole('link', { name: 'Frittata' }),
    ).toHaveAttribute('href', '/recipe/a')
    expect(
      within(list).getByText('Wikibooks Cookbook · 25 min · a main ingredient'),
    ).toBeInTheDocument()
    expect(
      within(list).getByText(/not every ingredient could be checked/),
    ).toBeInTheDocument()
  })

  it('keeps the search in the address, and shows it again on Back', async () => {
    const api = fakeApi()
    const { unmount } = render(<Browse api={api} />)
    await userEvent.type(screen.getByLabelText('Search recipes'), 'eggs')
    await waitFor(() =>
      expect(api.searchCatalog).toHaveBeenLastCalledWith('eggs', 0),
    )
    expect(window.location.search).toBe('?q=eggs')
    await screen.findByRole('link', { name: 'Frittata' })
    unmount()

    // Back: the same search, results at once, no new request.
    const calls = api.searchCatalog.mock.calls.length
    render(<Browse api={api} />)
    expect(screen.getByLabelText('Search recipes')).toHaveValue('eggs')
    expect(screen.getByRole('link', { name: 'Frittata' })).toBeInTheDocument()
    expect(api.searchCatalog.mock.calls.length).toBe(calls)
  })

  it('remembers the scroll position when a recipe is opened', async () => {
    render(<Browse api={fakeApi()} />)
    await userEvent.click(await screen.findByRole('link', { name: 'Frittata' }))
    expect(
      JSON.parse(sessionStorage.getItem('sous:browse-scroll')!),
    ).toMatchObject({
      q: '',
    })
  })

  it('shows more results on request', async () => {
    const full = Array.from({ length: 30 }, (_, i) => ({
      ...FRITTATA,
      id: `r${i}`,
      title: `Recipe ${i}`,
    }))
    const api = fakeApi([full, [PIE]])
    render(<Browse api={api} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show more' }),
    )
    expect(
      await screen.findByRole('link', { name: 'Egg pie' }),
    ).toBeInTheDocument()
    expect(api.searchCatalog).toHaveBeenLastCalledWith('', 30)
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('explains an empty result', async () => {
    render(
      <Browse api={{ ...fakeApi(), searchCatalog: vi.fn(async () => []) }} />,
    )
    await userEvent.type(screen.getByLabelText('Search recipes'), 'chicken')
    expect(
      await screen.findByText(
        /Nothing that fits your preferences matches “chicken”/,
      ),
    ).toBeInTheDocument()
  })

  it('adds a recipe to this week from the results (TYL-119)', async () => {
    const api = fakeApi()
    render(<Browse api={api} />)
    await userEvent.click(
      await screen.findByRole('button', {
        name: "Add Frittata to this week's plan",
      }),
    )
    expect(api.addToPlan).toHaveBeenCalledWith(weekOf(), 'a', 1)
    expect(await screen.findByRole('status')).toHaveTextContent('Planned')
  })

  it('asks before planning a recipe that breaks your diets', async () => {
    const api = fakeApi()
    api.recipeFits.mockResolvedValue({ a: 'excluded' })
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<Browse api={api} />)
    await userEvent.click(
      await screen.findByRole('button', {
        name: "Add Frittata to this week's plan",
      }),
    )
    expect(ask).toHaveBeenCalled()
    expect(api.addToPlan).not.toHaveBeenCalled()
    ask.mockRestore()
  })

  it('offers a retry when adding fails', async () => {
    const api = fakeApi()
    api.addToPlan.mockRejectedValueOnce(new Error('down'))
    render(<Browse api={api} />)
    await userEvent.click(
      await screen.findByRole('button', {
        name: "Add Frittata to this week's plan",
      }),
    )
    await userEvent.click(
      await screen.findByRole('button', {
        name: "Couldn't add Frittata. Try again",
      }),
    )
    expect(api.addToPlan).toHaveBeenCalledTimes(2)
    expect(await screen.findByRole('status')).toHaveTextContent('Planned')
  })
})
