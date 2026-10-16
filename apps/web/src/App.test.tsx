import type { Session } from '@supabase/supabase-js'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import type { SousApi } from './App.tsx'
import { NO_PREFERENCES, type Preferences } from './sous.ts'
import type { Auth } from './auth.ts'

type Listener = (event: string, session: Session | null) => void

function fakeAuth(initial: Session | null = null) {
  let listener: Listener = () => {}
  const auth = {
    getSession: vi.fn(async () => ({
      data: { session: initial },
      error: null,
    })),
    onAuthStateChange: vi.fn((cb: Listener) => {
      listener = cb
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    }),
    signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
    verifyOtp: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
  }
  return {
    auth: auth as unknown as Auth & typeof auth,
    emit: (s: Session | null) => listener('SIGNED_IN', s),
  }
}

const session = {
  access_token: 't',
  user: { email: 'cook@example.com' },
} as Session

const library = (
  prefs: Preferences = { ...NO_PREFERENCES, saved: true },
): SousApi => ({
  list: vi.fn(async () => []),
  save: vi.fn(),
  savePage: vi.fn(),
  saveText: vi.fn(),
  remove: vi.fn(),
  recipe: vi.fn(async () => null),
  saveManual: vi.fn(),
  readPhotos: vi.fn(),
  preferences: vi.fn(async () => prefs),
  savePreferences: vi.fn(async () => {}),
  options: vi.fn(async () => ({ diets: [], cuisines: [] })),
  searchIngredients: vi.fn(async () => []),
  storesNear: vi.fn(async () => []),
  myStore: vi.fn(async () => null),
  chooseStore: vi.fn(async () => {}),
  exportMyData: vi.fn(async () => '{}'),
  deleteMyAccount: vi.fn(async () => {}),
  pantryStaples: vi.fn(async () => []),
  syncList: vi.fn(async () => 'list-1'),
  loadList: vi.fn(async () => null),
  sendListOp: vi.fn(async () => {}),
  places: vi.fn(async () => []),
  addPlace: vi.fn(async (name: string) => ({ id: 'p', name })),
  pantry: vi.fn(async () => []),
  sendFeedback: vi.fn(async () => {}),
  plan: vi.fn(async () => []),
  addToPlan: vi.fn(async () => {}),
  updateEntry: vi.fn(async () => {}),
  removeEntry: vi.fn(async () => {}),
  removeEntries: vi.fn(async () => {}),
  copyPlan: vi.fn(async () => 0),
  planCost: vi.fn(async () => ({
    budgetCents: null,
    totalCents: 0,
    estimated: false,
    unpriced: 0,
    items: [],
    storeName: null,
    storeId: null,
    entryCents: {},
  })),
  addedCosts: vi.fn(async () => ({
    budgetCents: null,
    totalCents: 0,
    recipes: {},
  })),
  setMyPrice: vi.fn(async () => {}),
  favoriteCuisines: vi.fn(async () => []),
  clearMyPrice: vi.fn(async () => {}),
  recipeFits: vi.fn(async () => ({})),
  setPantry: vi.fn(async () => {}),
  searchCatalog: vi.fn(async () => []),
  saveToLibrary: vi.fn(async () => {}),
  setTags: vi.fn(async () => {}),
})

describe('App', () => {
  it('renders the app name', () => {
    render(<App auth={null} />)
    expect(screen.getByRole('heading', { name: 'Sous' })).toBeInTheDocument()
  })

  it('says so when sign-in is not configured', () => {
    render(<App auth={null} />)
    expect(screen.getByRole('alert')).toHaveTextContent('VITE_SUPABASE_URL')
  })

  it('emails a magic link that returns to this page', async () => {
    const { auth } = fakeAuth()
    render(<App auth={auth} />)
    await userEvent.type(
      await screen.findByLabelText('Email'),
      ' cook@example.com ',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Email me a code' }),
    )
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'cook@example.com',
      options: {
        emailRedirectTo: window.location.origin + window.location.pathname,
      },
    })
    expect(
      await screen.findByRole('heading', { name: 'Check your email' }),
    ).toBeInTheDocument()
  })

  it.each([
    [
      { code: 'over_email_send_rate_limit', status: 429 },
      'as many sign-in emails',
    ],
    [{ code: 'email_address_invalid', status: 400 }, 'valid email address'],
    [{ status: 0 }, "couldn't reach the sign-in service"],
    [{ code: 'unexpected_failure', status: 500 }, "couldn't send the link"],
  ])('explains why the link was not sent (%o)', async (error, text) => {
    const { auth } = fakeAuth()
    auth.signInWithOtp.mockResolvedValueOnce({ data: {}, error } as never)
    render(<App auth={auth} />)
    await userEvent.type(
      await screen.findByLabelText('Email'),
      'cook@example.com',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Email me a code' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
  })

  it('signs in with the code from the email, without leaving the app', async () => {
    const { auth, emit } = fakeAuth()
    auth.verifyOtp.mockImplementationOnce(async () => {
      emit(session)
      return { data: {}, error: null }
    })
    render(<App auth={auth} libraryApi={() => library()} />)
    await userEvent.type(
      await screen.findByLabelText('Email'),
      'cook@example.com',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Email me a code' }),
    )
    const signIn = await screen.findByRole('button', { name: 'Sign in' })
    expect(signIn).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Code'), '123 456')
    await userEvent.click(signIn)
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: 'cook@example.com',
      token: '123456',
      type: 'email',
    })
    expect(
      await screen.findByRole('heading', { name: 'This week' }),
    ).toBeInTheDocument()
  })

  it('explains a wrong or expired code', async () => {
    const { auth } = fakeAuth()
    auth.verifyOtp.mockResolvedValueOnce({
      data: {},
      error: { code: 'otp_expired', status: 403 },
    } as never)
    render(<App auth={auth} />)
    await userEvent.type(
      await screen.findByLabelText('Email'),
      'cook@example.com',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Email me a code' }),
    )
    await userEvent.type(await screen.findByLabelText('Code'), '000000')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That code didn't work",
    )
  })

  it('shows who is signed in on the preferences page, and signs out', async () => {
    const { auth } = fakeAuth(session)
    render(<App auth={auth} libraryApi={() => library()} />)
    await userEvent.click(
      await screen.findByRole('link', { name: 'Preferences' }),
    )
    expect(await screen.findByText('cook@example.com')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(auth.signOut).toHaveBeenCalled()
  })

  it('sets up a new user step by step, then goes to their recipes', async () => {
    window.history.replaceState(null, '', '/plan')
    const { auth } = fakeAuth(session)
    const api = library(NO_PREFERENCES)
    render(<App auth={auth} libraryApi={() => api} />)
    expect(
      await screen.findByRole('heading', { name: 'How do you eat?' }),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/welcome')
    expect(screen.getByText('Step 1 of 7')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(
      screen.getByRole('heading', { name: 'Anything you can’t or won’t eat?' }),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Skip the rest/ }))
    await waitFor(() =>
      expect(api.savePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ saved: true }),
      ),
    )
    expect(
      await screen.findByRole('heading', { name: 'This week' }),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })

  it('doesn’t send anyone to setup when preferences fail to load', async () => {
    window.history.replaceState(null, '', '/')
    const { auth } = fakeAuth(session)
    const api = library()
    vi.mocked(api.preferences).mockRejectedValue(new Error('down'))
    render(<App auth={auth} libraryApi={() => api} />)
    expect(
      await screen.findByRole('heading', { name: 'This week' }),
    ).toBeInTheDocument()
    await waitFor(() => expect(api.preferences).toHaveBeenCalled())
    expect(window.location.pathname).toBe('/')
  })

  it('doesn’t route a newly signed-in account by the last one’s setup', async () => {
    window.history.replaceState(null, '', '/')
    const { auth, emit } = fakeAuth(null)
    const first = { ...session, user: { id: 'a', email: 'a@x' } } as Session
    const second = { ...session, user: { id: 'b', email: 'b@x' } } as Session
    const newUser = library(NO_PREFERENCES)
    const other = library()
    // The second account's preferences are still loading.
    vi.mocked(other.preferences).mockImplementation(() => new Promise(() => {}))
    render(
      <App
        auth={auth}
        libraryApi={(s) => (s.user.id === 'a' ? newUser : other)}
      />,
    )
    await screen.findByLabelText('Email')
    act(() => emit(first))
    await screen.findByRole('heading', { name: 'How do you eat?' })
    act(() => emit(null))
    window.history.replaceState(null, '', '/plan')
    act(() => emit(second))
    await waitFor(() => expect(other.preferences).toHaveBeenCalled())
    expect(window.location.pathname).toBe('/plan')
    window.history.replaceState(null, '', '/')
  })

  it('has a tab bar for the week, recipes, list and pantry', async () => {
    window.history.replaceState(null, '', '/')
    const { auth } = fakeAuth(session)
    render(<App auth={auth} libraryApi={() => library()} />)
    const tabs = await screen.findByRole('navigation', { name: 'Main' })
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Week', '/'],
      ['Recipes', '/recipes'],
      ['List', '/list'],
      ['Pantry', '/pantry'],
    ])
    expect(within(tabs).getByRole('link', { name: 'Week' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await userEvent.click(within(tabs).getByRole('link', { name: 'Recipes' }))
    expect(
      await screen.findByRole('heading', { name: 'Your recipes' }),
    ).toBeInTheDocument()
    expect(within(tabs).getByRole('link', { name: 'Recipes' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: 'Preferences' })).toHaveAttribute(
      'href',
      '/settings',
    )
    window.history.replaceState(null, '', '/')
  })

  it('shows the privacy page signed out', async () => {
    window.history.replaceState(null, '', '/privacy')
    const { auth } = fakeAuth(null)
    render(<App auth={auth} libraryApi={() => library()} />)
    expect(
      await screen.findByRole('heading', { name: 'What Sous keeps about you' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).toBeNull()
    window.history.replaceState(null, '', '/')
  })

  it('follows sign-in from the emailed link', async () => {
    const { auth, emit } = fakeAuth()
    render(<App auth={auth} libraryApi={() => library()} />)
    await screen.findByLabelText('Email')
    act(() => emit(session))
    expect(
      await screen.findByRole('heading', { name: 'This week' }),
    ).toBeInTheDocument()
  })
})
