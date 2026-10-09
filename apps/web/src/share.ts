// Recipes shared to Sous from another app arrive as /share?title=&text=&url=
// (Web Share Target, set in the PWA manifest). The link is kept until the
// user is signed in, so it survives the magic-link round trip.
import { firstUrl } from './library.ts'

const KEY = 'sous:shared-url'

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Reads a shared link from the address bar (then tidies the address) or a
 *  link kept from before sign-in. */
export function pendingShare(): string | null {
  const params = new URLSearchParams(window.location.search)
  const shared = firstUrl(
    params.get('url'),
    params.get('text'),
    params.get('title'),
  )
  if (shared) {
    window.history.replaceState(null, '', '/')
    try {
      storage()?.setItem(KEY, shared)
    } catch {
      // Private mode or storage disabled: we still have it for this visit.
    }
    return shared
  }
  return storage()?.getItem(KEY) ?? null
}

export function clearShare(): void {
  try {
    storage()?.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}
