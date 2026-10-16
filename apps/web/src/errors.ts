// Error reporting with Sentry (TYL-74), for the beta: crashes and failed
// calls reach the team without testers having to describe them. Off unless
// VITE_SENTRY_DSN is set, and loaded only then, so the app stays small.

/** Start reporting errors if a Sentry DSN is configured. No personal data:
 *  no IP addresses or cookies, no session replays or traces, and no request
 *  or console breadcrumbs (addresses can carry searches, logs anything). */
export async function startErrorReporting(
  dsn: string | undefined = import.meta.env.VITE_SENTRY_DSN,
): Promise<boolean> {
  if (!dsn) return false
  const Sentry = await import('@sentry/browser')
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0,
    beforeBreadcrumb: keepBreadcrumb,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
  })
  return true
}

/** Breadcrumbs kept with a report: navigation and clicks only, not network
 *  requests (their addresses can hold what the user searched for) or console
 *  output. */
export function keepBreadcrumb<B extends { category?: string }>(
  b: B,
): B | null {
  return b.category === 'fetch' ||
    b.category === 'xhr' ||
    b.category === 'console'
    ? null
    : b
}
