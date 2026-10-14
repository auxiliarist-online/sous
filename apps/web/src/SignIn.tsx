import { useState, type FormEvent } from 'react'
import type { Auth } from './auth.ts'
import { Link } from './router.tsx'
import { codeError, sendError } from './signInErrors.ts'

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
        ? { state: 'error', message: sendError(error) }
        : { state: 'sent', email: address },
    )
  }

  if (status.state === 'sent') {
    return (
      <EnterCode
        auth={auth}
        email={status.email}
        onBack={() => setStatus({ state: 'idle' })}
      />
    )
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Sign in</h2>
      <p className="muted">We'll email you a code. No password needed.</p>
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
        {status.state === 'sending' ? 'Sending…' : 'Email me a code'}
      </button>
      <Link to="/privacy" className="small">
        What Sous keeps about you
      </Link>
      {status.state === 'error' && (
        <p role="alert" className="error">
          {status.message}
        </p>
      )}
    </form>
  )
}

/** The code from the email signs you in right here, in the installed app.
 *  Tapping the email's link would open the email app's own browser instead. */
function EnterCode({
  auth,
  email,
  onBack,
}: {
  auth: Auth
  email: string
  onBack: () => void
}) {
  const [code, setCode] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function verify(e: FormEvent) {
    e.preventDefault()
    const token = code.replace(/\D/g, '')
    if (token.length < 6) return
    setChecking(true)
    setError(null)
    const { error } = await auth.verifyOtp({ email, token, type: 'email' })
    setChecking(false)
    // On success the session listener in App takes over.
    if (error) setError(codeError(error))
  }

  return (
    <form className="card" onSubmit={verify} aria-live="polite">
      <h2>Check your email</h2>
      <p>
        We sent a code to <strong>{email}</strong>. Enter it here to sign in.
      </p>
      <label htmlFor="code">Code</label>
      <input
        id="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={12}
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <button
        type="submit"
        disabled={checking || code.replace(/\D/g, '').length < 6}
      >
        {checking ? 'Checking…' : 'Sign in'}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p className="muted small">
        The email also has a link. On a phone, the code is better: the link may
        open in your email app instead of Sous.
      </p>
      <button type="button" className="link" onClick={onBack}>
        Use a different email or send a new code
      </button>
    </form>
  )
}
