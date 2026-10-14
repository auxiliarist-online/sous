import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Settings } from './Settings.tsx'
import { StorePicker, type StoreApi } from './StorePicker.tsx'
import { NO_PREFERENCES } from './sous.ts'
import {
  chooseStore,
  deleteMyAccount,
  exportMyData,
  myStore,
  storesNear,
  type NearbyStore,
} from './stores.ts'
import { Welcome, type WelcomeApi } from './Welcome.tsx'

const ARCTIC: NearbyStore = {
  locationId: '09700181',
  chainSlug: 'harris_teeter',
  name: 'Harris Teeter - Arctic Avenue',
  address: '2800 Arctic Ave',
  city: 'Virginia Beach',
  state: 'VA',
  zip: '23451',
}

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe('store calls', () => {
  it('finds stores near a zip and reads them', async () => {
    const send = reply(200, [
      {
        location_id: '09700181',
        chain_slug: 'harris_teeter',
        name: ARCTIC.name,
        address: ARCTIC.address,
        city: ARCTIC.city,
        state: 'VA',
        zip: '23451',
      },
    ])
    expect(await storesNear({} as Session, '23451', send)).toEqual([ARCTIC])
    expect(send).toHaveBeenCalledWith({}, '/stores/nearby?zip=23451')
  })

  it('reads the user’s store, or the default', async () => {
    const send = reply(200, {
      store: {
        name: 'Harris Teeter – Village at Chestnut Street',
        address: null,
      },
      default: true,
    })
    expect(await myStore({} as Session, send)).toEqual({
      name: 'Harris Teeter – Village at Chestnut Street',
      address: null,
      isDefault: true,
    })
    expect(
      await myStore({} as Session, reply(200, { store: null, default: true })),
    ).toBeNull()
  })

  it('chooses a store, and passes on the API’s reason when it can’t', async () => {
    const send = reply(200, { store: {}, default: false })
    await chooseStore({} as Session, '09700181', send)
    expect(send).toHaveBeenCalledWith({}, '/stores/mine', {
      method: 'PUT',
      body: JSON.stringify({ location_id: '09700181' }),
    })
    await expect(
      chooseStore(
        {} as Session,
        '1',
        reply(404, { detail: "Kroger doesn't know that store." }),
      ),
    ).rejects.toThrow("Kroger doesn't know that store.")
  })

  it('exports and deletes through the database', async () => {
    const rpc = vi.fn(async (name: string) => ({
      data:
        name === 'export_my_data' ? { profile: { household_size: 2 } } : null,
      error: null,
    }))
    const db = { rpc } as unknown as SupabaseClient
    expect(JSON.parse(await exportMyData(db))).toEqual({
      profile: { household_size: 2 },
    })
    await deleteMyAccount(db)
    expect(rpc).toHaveBeenLastCalledWith('delete_my_account')
  })
})

function storeApi(over: Partial<StoreApi> = {}): StoreApi & {
  storesNear: ReturnType<typeof vi.fn>
  chooseStore: ReturnType<typeof vi.fn>
} {
  return {
    storesNear: vi.fn(async (_zip: string) => [ARCTIC]),
    myStore: vi.fn(async () => ({
      name: 'Harris Teeter – Village at Chestnut Street',
      address: null,
      isDefault: true,
    })),
    chooseStore: vi.fn(async (_id: string) => {}),
    ...over,
  } as StoreApi & {
    storesNear: ReturnType<typeof vi.fn>
    chooseStore: ReturnType<typeof vi.fn>
  }
}

describe('StorePicker', () => {
  it('finds stores by zip code and makes one the user’s store', async () => {
    const api = storeApi()
    const onZip = vi.fn()
    render(<StorePicker api={api} zip={null} onZip={onZip} />)
    expect(await screen.findByText(/Sous's default/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Your zip code'), '23451{Enter}')
    expect(api.storesNear).toHaveBeenCalledWith('23451')
    expect(onZip).toHaveBeenCalledWith('23451')
    const list = await screen.findByRole('list', { name: 'Stores near you' })
    await userEvent.click(
      within(list).getByRole('button', {
        name: 'Shop at Harris Teeter - Arctic Avenue',
      }),
    )
    expect(api.chooseStore).toHaveBeenCalledWith('09700181')
    expect(
      screen.getByText('Harris Teeter - Arctic Avenue'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Sous's default/)).toBeNull()
  })

  it('checks the zip code, and says when no store is near', async () => {
    const api = storeApi({ storesNear: vi.fn(async () => []) })
    render(<StorePicker api={api} zip="99501" onZip={vi.fn()} />)
    const zip = await screen.findByLabelText('Your zip code')
    expect(zip).toHaveValue('99501')
    await userEvent.clear(zip)
    await userEvent.type(zip, '123')
    await userEvent.click(screen.getByRole('button', { name: 'Find stores' }))
    expect(screen.getByText('Enter a five-digit zip code.')).toBeInTheDocument()
    expect(api.storesNear).not.toHaveBeenCalled()
    await userEvent.type(zip, '45')
    await userEvent.click(screen.getByRole('button', { name: 'Find stores' }))
    expect(
      await screen.findByText(/No Kroger-family stores within 15 miles/),
    ).toBeInTheDocument()
  })
})

function welcomeApi(): WelcomeApi & Record<string, ReturnType<typeof vi.fn>> {
  return {
    ...storeApi(),
    preferences: vi.fn(async () => NO_PREFERENCES),
    savePreferences: vi.fn(async () => {}),
    options: vi.fn(async () => ({
      diets: [{ slug: 'vegetarian', name: 'Vegetarian' }],
      cuisines: [{ slug: 'thai', name: 'Thai' }],
    })),
    searchIngredients: vi.fn(async () => []),
    exportMyData: vi.fn(async () => '{"profile": null}'),
    deleteMyAccount: vi.fn(async () => {}),
    pantryStaples: vi.fn(async () => [
      { id: 'salt', name: 'salt' },
      { id: 'oil', name: 'olive oil' },
    ]),
    setPantry: vi.fn(async () => {}),
  } as unknown as WelcomeApi & Record<string, ReturnType<typeof vi.fn>>
}

describe('Welcome', () => {
  it('walks through setup and saves it all at the end', async () => {
    const api = welcomeApi()
    const onDone = vi.fn()
    render(<Welcome api={api} onDone={onDone} />)
    const next = async () =>
      userEvent.click(screen.getByRole('button', { name: 'Next' }))

    await userEvent.click(
      await screen.findByRole('button', { name: 'Vegetarian' }),
    )
    await next() // allergies
    await next() // cuisines
    await userEvent.click(screen.getByRole('button', { name: 'Thai' }))
    await next() // ingredients
    await next() // household
    await userEvent.type(
      screen.getByLabelText('Weekly grocery budget ($)'),
      '120',
    )
    await next() // store
    await userEvent.type(screen.getByLabelText('Your zip code'), '23451{Enter}')
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Shop at Harris Teeter - Arctic Avenue',
      }),
    )
    await next() // pantry
    expect(screen.getByText('Step 7 of 7')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'olive oil' }))
    expect(
      screen.getByRole('button', { name: 'Out of olive oil' }),
    ).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Finish' }))

    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(api.savePreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        saved: true,
        diets: ['vegetarian'],
        favoriteCuisines: ['thai'],
        weeklyBudgetCents: 12000,
        homeZip: '23451',
      }),
    )
    expect(api.setPantry).toHaveBeenCalledWith('oil', 'out')
    expect(api.setPantry).toHaveBeenCalledTimes(1)
    expect(api.chooseStore).toHaveBeenCalledWith('09700181')
  })

  it('goes back a step, and says when saving fails', async () => {
    const api = welcomeApi()
    vi.mocked(api.savePreferences).mockRejectedValueOnce(new Error('nope'))
    render(<Welcome api={api} onDone={vi.fn()} />)
    await screen.findByRole('heading', { name: 'How do you eat?' })
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(
      screen.getByRole('heading', { name: 'How do you eat?' }),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Skip the rest/ }))
    expect(
      await screen.findByText("We couldn't save. Try again."),
    ).toBeInTheDocument()
  })
})

describe('Settings: store and account', () => {
  it('downloads the user’s data and deletes the account after confirming', async () => {
    const api = welcomeApi()
    const onDeleted = vi.fn()
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    render(
      <Settings
        api={api}
        email="cook@example.com"
        onSaved={vi.fn()}
        onSignOut={vi.fn()}
        onDeleted={onDeleted}
      />,
    )
    expect(await screen.findByText(/Sous's default/)).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'What Sous keeps about you' }),
    ).toHaveAttribute('href', '/privacy')

    await userEvent.click(
      screen.getByRole('button', { name: 'Download my data' }),
    )
    expect(api.exportMyData).toHaveBeenCalled()
    await waitFor(() => expect(click).toHaveBeenCalled())

    await userEvent.click(
      screen.getByRole('button', { name: 'Delete my account' }),
    )
    expect(api.deleteMyAccount).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Keep my account' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Delete my account' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Delete everything' }),
    )
    expect(api.deleteMyAccount).toHaveBeenCalled()
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    click.mockRestore()
  })
})
