// Error reporting with Sentry (TYL-74), for the beta: crashes and failed
// calls reach the team without testers having to describe them. Off unless
// VITE_SENTRY_DSN is set, and loaded only then, so the app stays small.

/** Start reporting errors if a Sentry DSN is configured. The browser SDK
 *  sends no personal data by default (no IP addresses, cookies or what was
 *  typed), and there are no session replays or performance traces. */
export async function startErrorReporting(
  dsn: string | undefined = import.meta.env.VITE_SENTRY_DSN,
): Promise<boolean> {
  if (!dsn) return false
  const Sentry = await import('@sentry/browser')
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0,
  })
  return true
}
