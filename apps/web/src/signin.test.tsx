import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Auth } from './auth.ts'
import { SignIn } from './SignIn.tsx'

function fakeAuth(oauthError: Error | null = null) {
  const auth = {
    signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
    verifyOtp: vi.fn(async () => ({ data: {}, error: null })),
    signInWithOAuth: vi.fn(async () => ({ data: {}, error: oauthError })),
  }
  return auth as unknown as Auth & typeof auth
}

describe('Sign in with Google (TYL-48)', () => {
  it('goes to Google and back to this page, with email as the fallback', async () => {
    const auth = fakeAuth()
    render(<SignIn auth={auth} google />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Continue with Google' }),
    )
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
      },
    })
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
  })

  it('says when Google can’t be reached', async () => {
    render(<SignIn auth={fakeAuth(new Error('down'))} google />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Continue with Google' }),
    )
    expect(
      await screen.findByText(/We couldn't reach Google/),
    ).toBeInTheDocument()
  })

  it('isn’t offered until it’s set up', () => {
    render(<SignIn auth={fakeAuth()} google={false} />)
    expect(
      screen.queryByRole('button', { name: 'Continue with Google' }),
    ).toBeNull()
  })
})
