import type { Session } from '@supabase/supabase-js'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import type { SousApi } from './App.tsx'
import { NO_PREFERENCES } from './sous.ts'
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

const library = (): SousApi => ({
  list: vi.fn(async () => []),
  save: vi.fn(),
  savePage: vi.fn(),
  remove: vi.fn(),
  recipe: vi.fn(async () => null),
  saveManual: vi.fn(),
  preferences: vi.fn(async () => NO_PREFERENCES),
  savePreferences: vi.fn(async () => {}),
  options: vi.fn(async () => ({ diets: [], cuisines: [] })),
  searchIngredients: vi.fn(async () => []),
  plan: vi.fn(async () => []),
  addToPlan: vi.fn(async () => {}),
  updateEntry: vi.fn(async () => {}),
  removeEntry: vi.fn(async () => {}),
  copyPlan: vi.fn(async () => 0),
  planCost: vi.fn(async () => ({
    budgetCents: null,
    totalCents: 0,
    estimated: false,
    unpricedLines: 0,
    entries: {},
  })),
  recipeFits: vi.fn(async () => ({})),
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
    render(<App auth={auth} libraryApi={library} />)
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
      await screen.findByRole('heading', { name: 'Your recipes' }),
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
    render(<App auth={auth} libraryApi={library} />)
    await userEvent.click(
      await screen.findByRole('link', { name: 'Preferences' }),
    )
    expect(await screen.findByText('cook@example.com')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(auth.signOut).toHaveBeenCalled()
  })

  it('asks a new user to set preferences, once', async () => {
    const { auth } = fakeAuth(session)
    render(<App auth={auth} libraryApi={library} />)
    expect(
      await screen.findByRole('heading', { name: 'Tell Sous how you eat' }),
    ).toBeInTheDocument()
  })

  it('follows sign-in from the emailed link', async () => {
    const { auth, emit } = fakeAuth()
    render(<App auth={auth} libraryApi={library} />)
    await screen.findByLabelText('Email')
    act(() => emit(session))
    expect(
      await screen.findByRole('heading', { name: 'Your recipes' }),
    ).toBeInTheDocument()
  })
})
