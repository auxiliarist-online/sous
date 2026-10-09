import type { Session } from '@supabase/supabase-js'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import type { LibraryApi } from './Library.tsx'
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

const library = (): LibraryApi => ({
  list: vi.fn(async () => []),
  save: vi.fn(),
  savePage: vi.fn(),
  remove: vi.fn(),
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
      screen.getByRole('button', { name: 'Email me a link' }),
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

  it('shows a friendly error when the link cannot be sent', async () => {
    const { auth } = fakeAuth()
    auth.signInWithOtp.mockResolvedValueOnce({
      data: {},
      error: new Error('rate limit'),
    } as never)
    render(<App auth={auth} />)
    await userEvent.type(
      await screen.findByLabelText('Email'),
      'cook@example.com',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Email me a link' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "couldn't send the link",
    )
  })

  it('shows who is signed in and signs out', async () => {
    const { auth } = fakeAuth(session)
    render(<App auth={auth} libraryApi={library} />)
    expect(await screen.findByText('cook@example.com')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(auth.signOut).toHaveBeenCalled()
  })

  it('follows sign-in from the emailed link', async () => {
    const { auth, emit } = fakeAuth()
    render(<App auth={auth} libraryApi={library} />)
    await screen.findByLabelText('Email')
    act(() => emit(session))
    expect(await screen.findByText('cook@example.com')).toBeInTheDocument()
  })
})
