import { useState, type FormEvent } from 'react'
import type { Auth } from './auth.ts'

type Status =
  | { state: 'idle' }
  | { state: 'sending' }
  | { state: 'sent'; email: string }
  | { state: 'error'; message: string }

export function SignIn({ auth }: { auth: Auth }) {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>({ state: 'idle' })

  async function submit(e: FormEvent) {
    e.preventDefault()
    const address = email.trim()
    if (!address) return
    setStatus({ state: 'sending' })
    const { error } = await auth.signInWithOtp({
      email: address,
      // The link in the email brings you back to the page you started on.
      options: {
        emailRedirectTo: window.location.origin + window.location.pathname,
      },
    })
    setStatus(
      error
        ? {
            state: 'error',
            message: "We couldn't send the link. Try again in a minute.",
          }
        : { state: 'sent', email: address },
    )
  }

  if (status.state === 'sent') {
    return (
      <section className="card" aria-live="polite">
        <h2>Check your email</h2>
        <p>
          We sent a sign-in link to <strong>{status.email}</strong>. Open it on
          this device.
        </p>
        <button
          type="button"
          className="link"
          onClick={() => setStatus({ state: 'idle' })}
        >
          Use a different email
        </button>
      </section>
    )
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Sign in</h2>
      <p className="muted">We'll email you a link. No password needed.</p>
      <label htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button type="submit" disabled={status.state === 'sending'}>
        {status.state === 'sending' ? 'Sending…' : 'Email me a link'}
      </button>
      {status.state === 'error' && (
        <p role="alert" className="error">
          {status.message}
        </p>
      )}
    </form>
  )
}
