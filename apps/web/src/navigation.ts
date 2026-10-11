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

export type Route =
  | { page: 'library' }
  | { page: 'recipe'; id: string }
  | { page: 'new' }
  | { page: 'edit'; id: string }
  | { page: 'settings' }
  | { page: 'plan'; week: string | null }

const UUID = '[0-9a-f-]{36}'

export function route(path: string): Route {
  let m = path.match(new RegExp(`^/recipe/(${UUID})/?$`, 'i'))
  if (m) return { page: 'recipe', id: m[1] }
  m = path.match(new RegExp(`^/edit/(${UUID})/?$`, 'i'))
  if (m) return { page: 'edit', id: m[1] }
  if (/^\/new\/?$/.test(path)) return { page: 'new' }
  if (/^\/settings\/?$/.test(path)) return { page: 'settings' }
  if (/^\/plan\/?$/.test(path)) return { page: 'plan', week: null }
  m = path.match(/^\/plan\/(\d{4}-\d{2}-\d{2})\/?$/)
  if (m) return { page: 'plan', week: m[1] }
  return { page: 'library' }
}
