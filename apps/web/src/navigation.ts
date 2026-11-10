// Page addresses without a routing library: real URLs, so the back gesture
// and reloading work. The <Link> component lives in router.tsx.
import { useEffect, useState } from 'react'

const EVENT = 'sous:navigate'

export function navigate(to: string, replace = false): void {
  if (replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  window.dispatchEvent(new Event(EVENT))
  window.scrollTo?.(0, 0)
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname)
  useEffect(() => {
    const update = () => setPath(window.location.pathname)
    window.addEventListener('popstate', update)
    window.addEventListener(EVENT, update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener(EVENT, update)
    }
  }, [])
  return path
}

/** Whether the user has moved since the app opened: any in-app navigation
 *  (even to the page they're on, like tapping Week while on "/") or Back. */
export function useNavigated(): boolean {
  const [moved, setMoved] = useState(false)
  useEffect(() => {
    const update = () => setMoved(true)
    window.addEventListener('popstate', update)
    window.addEventListener(EVENT, update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener(EVENT, update)
    }
  }, [])
  return moved
}

/** Cook mode's address for a recipe, at a planned size and entry (TYL-75). */
export function cookPath(
  recipeId: string,
  scale: number = 1,
  entryId: string | null = null,
): string {
  const q = new URLSearchParams()
  if (scale !== 1) q.set('scale', String(scale))
  if (entryId) q.set('entry', entryId)
  const qs = q.toString()
  return `/cook/${recipeId}${qs ? `?${qs}` : ''}`
}

/** The size and plan entry from the address: /cook/<id>?scale=2&entry=<id>. */
export function cookParams(search: string): {
  scale: 0.5 | 1 | 2
  entryId: string | null
} {
  const q = new URLSearchParams(search)
  const n = Number(q.get('scale'))
  return {
    scale: n === 0.5 || n === 2 ? n : 1,
    entryId: q.get('entry'),
  }
}

export type Route =
  | { page: 'home' }
  | { page: 'library' }
  | { page: 'pantry' }
  | { page: 'recipe'; id: string }
  | { page: 'cook'; id: string }
  | { page: 'new' }
  | { page: 'edit'; id: string }
  | { page: 'settings' }
  | { page: 'browse' }
  | { page: 'plan'; week: string | null }
  | { page: 'welcome' }
  | { page: 'list'; week: string | null }
  | { page: 'privacy' }
  | { page: 'history' }

const UUID = '[0-9a-f-]{36}'

/** Which page an address shows: "/" is the week (TYL-72); anything unknown
 *  (like /share, from Android's share sheet) is the library. */
export function route(path: string): Route {
  let m = path.match(new RegExp(`^/recipe/(${UUID})/?$`, 'i'))
  if (m) return { page: 'recipe', id: m[1] }
  m = path.match(new RegExp(`^/cook/(${UUID})/?$`, 'i'))
  if (m) return { page: 'cook', id: m[1] }
  m = path.match(new RegExp(`^/edit/(${UUID})/?$`, 'i'))
  if (m) return { page: 'edit', id: m[1] }
  if (path === '/' || path === '') return { page: 'home' }
  if (/^\/recipes\/?$/.test(path)) return { page: 'library' }
  if (/^\/pantry\/?$/.test(path)) return { page: 'pantry' }
  if (/^\/new\/?$/.test(path)) return { page: 'new' }
  if (/^\/settings\/?$/.test(path)) return { page: 'settings' }
  if (/^\/browse\/?$/.test(path)) return { page: 'browse' }
  if (/^\/welcome\/?$/.test(path)) return { page: 'welcome' }
  if (/^\/list\/?$/.test(path)) return { page: 'list', week: null }
  m = path.match(/^\/list\/(\d{4}-\d{2}-\d{2})\/?$/)
  if (m) return { page: 'list', week: m[1] }
  if (/^\/privacy\/?$/.test(path)) return { page: 'privacy' }
  if (/^\/history\/?$/.test(path)) return { page: 'history' }
  if (/^\/plan\/?$/.test(path)) return { page: 'plan', week: null }
  m = path.match(/^\/plan\/(\d{4}-\d{2}-\d{2})\/?$/)
  if (m) return { page: 'plan', week: m[1] }
  return { page: 'library' }
}
