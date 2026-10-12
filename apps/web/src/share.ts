// Recipes shared to Sous from another app arrive as /share?title=&text=&url=
// (Web Share Target, set in the PWA manifest). What was shared is kept until
// the user is signed in, so it survives the sign-in round trip.
import { firstUrl } from './library.ts'
import { sharedIngredients, withoutTextFragment } from './paste.ts'

const KEY = 'sous:shared-url'

/** A shared link, and the ingredient list when the user shared a text
 *  selection from the page (Chrome adds the page's link to the text). */
export interface Shared {
  url: string
  ingredients: string | null
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function stored(): Shared | null {
  const raw = storage()?.getItem(KEY)
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as Partial<Shared>
    if (typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) {
      return {
        url: s.url,
        ingredients: typeof s.ingredients === 'string' ? s.ingredients : null,
      }
    }
  } catch {
    // Older versions kept the bare link.
    if (/^https?:\/\//i.test(raw)) return { url: raw, ingredients: null }
  }
  return null
}

/** Reads what was shared from the address bar (then tidies the address), or
 *  what was kept from before sign-in. */
export function pendingShare(): Shared | null {
  const params = new URLSearchParams(window.location.search)
  const url = firstUrl(
    params.get('url'),
    params.get('text'),
    params.get('title'),
  )
  if (url) {
    const shared: Shared = {
      url: withoutTextFragment(url),
      ingredients: sharedIngredients(params.get('text')),
    }
    window.history.replaceState(null, '', '/')
    try {
      storage()?.setItem(KEY, JSON.stringify(shared))
    } catch {
      // Private mode or storage disabled: we still have it for this visit.
    }
    return shared
  }
  return stored()
}

export function clearShare(): void {
  try {
    storage()?.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}
