// Usage, errors and session replays with PostHog, for the beta: what testers
// did when something broke, without them having to describe it. Off unless
// VITE_POSTHOG_KEY is set, and loaded only then, so the app stays small.
import type { PostHog } from 'posthog-js'

let client: PostHog | null = null

/** Start PostHog if a project key is configured. Replays hide everything
 *  typed; requests' addresses and bodies aren't recorded; people are known
 *  by their account id, never their email. */
export async function startTelemetry(
  key: string | undefined = import.meta.env.VITE_POSTHOG_KEY,
): Promise<boolean> {
  if (!key) return false
  const { default: posthog } = await import('posthog-js')
  posthog.init(key, {
    api_host: 'https://us.i.posthog.com',
    // Sous moves between pages without reloading.
    capture_pageview: 'history_change',
    capture_exceptions: true,
    person_profiles: 'identified_only',
    session_recording: {
      maskAllInputs: true,
      recordHeaders: false,
      recordBody: false,
    },
  })
  client = posthog
  return true
}

/** Link this session to the signed-in account (by id), or forget it. */
export function identify(userId: string | null): void {
  if (!client) return
  if (userId) client.identify(userId)
  else client.reset()
}

/** A link to this session's replay, to attach to a bug report. */
export function replayUrl(): string | null {
  return client?.get_session_replay_url({ withTimestamp: true }) ?? null
}
