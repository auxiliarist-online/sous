// A recipe page sent by the "Save to Sous" bookmarklet arrives as
// /#import=<JSON>. The fragment never reaches a server. Like a shared link,
// it's kept until the user is signed in, and saving it takes their tap.
import { MAX_LD_BLOCKS } from './bookmarklet.ts'
import type { PageData } from './library.ts'

const KEY = 'sous:shared-page'
const PREFIX = '#import='

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function parse(raw: string | null | undefined): PageData | null {
  if (!raw) return null
  try {
    const d = JSON.parse(raw) as { url?: unknown; site?: unknown; ld?: unknown }
    if (typeof d.url !== 'string' || !/^https?:\/\//i.test(d.url)) return null
    if (!Array.isArray(d.ld) || !d.ld.length || d.ld.length > MAX_LD_BLOCKS)
      return null
    if (!d.ld.every((b) => typeof b === 'string')) return null
    return {
      url: d.url,
      siteName: typeof d.site === 'string' && d.site ? d.site : null,
      ld: d.ld as string[],
    }
  } catch {
    return null
  }
}

export function pendingPage(): PageData | null {
  const hash = window.location.hash
  if (hash.startsWith(PREFIX)) {
    let raw: string | null = null
    try {
      raw = decodeURIComponent(hash.slice(PREFIX.length))
    } catch {
      raw = null
    }
    window.history.replaceState(null, '', window.location.pathname)
    const page = parse(raw)
    if (page) {
      try {
        storage()?.setItem(
          KEY,
          JSON.stringify({ url: page.url, site: page.siteName, ld: page.ld }),
        )
      } catch {
        // Storage full or disabled: we still have it for this visit.
      }
    }
    return page
  }
  return parse(storage()?.getItem(KEY))
}

export function clearPage(): void {
  try {
    storage()?.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}
