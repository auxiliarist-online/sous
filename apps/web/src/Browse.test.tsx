import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Browse } from './Browse.tsx'
import type { Fit } from './plan.ts'
import type { CatalogRecipe } from './sous.ts'

const DAL: CatalogRecipe = {
  id: 'a',
  title: 'Dal',
  sourceName: 'Wikibooks Cookbook',
  totalMinutes: 40,
}
const SATAY: CatalogRecipe = {
  id: 'b',
  title: 'Chicken satay',
  sourceName: 'Wikibooks Cookbook',
  totalMinutes: null,
}

function fakeApi(fits: Record<string, Fit> = {}) {
  return {
    searchCatalog: vi.fn(async (_q: string) => [DAL, SATAY]),
    recipeFits: vi.fn(async (_ids: string[]) => fits),
  }
}

describe('Browse', () => {
  it('lists catalog recipes with their source, linking to each', async () => {
    render(<Browse api={fakeApi()} />)
    const list = await screen.findByRole('list', { name: 'Recipes found' })
    expect(within(list).getByRole('link', { name: 'Dal' })).toHaveAttribute(
      'href',
      '/recipe/a',
    )
    expect(
      within(list).getByText('Wikibooks Cookbook · 40 min'),
    ).toBeInTheDocument()
  })

  it('leaves out recipes that break the user’s rules', async () => {
    render(<Browse api={fakeApi({ b: 'excluded' })} />)
    const list = await screen.findByRole('list', { name: 'Recipes found' })
    expect(within(list).queryByText('Chicken satay')).toBeNull()
    expect(screen.getByText(/1 recipe left out/)).toBeInTheDocument()
  })

  it('searches as the user types', async () => {
    const api = fakeApi()
    render(<Browse api={api} />)
    await userEvent.type(screen.getByLabelText('Search recipes'), 'dal')
    await waitFor(() =>
      expect(api.searchCatalog).toHaveBeenLastCalledWith('dal'),
    )
  })
})
