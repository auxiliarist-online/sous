/**
 * Links to recipe sites from the installed app on Android open in the user's
 * default browser (Chrome, Brave, Firefox, Samsung Internet...), not the
 * Chrome tab Android uses for an installed app's links. That tab has no ad or
 * script blocking of its own, so sites whose ad-block checks trip on a VPN's
 * blocking ("There was a problem loading the page") work as they do when
 * browsing normally (TYL-82).
 *
 * An intent: link names no app, so Android hands it to the default browser
 * (or asks, if none is set). Anywhere else the link is left alone: in a
 * browser tab it already opens in that browser.
 */

export interface Env {
  userAgent: string
  /** True when running as the installed app, not in a browser tab. */
  installed: boolean
}

export function currentEnv(): Env {
  const installed =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    ['standalone', 'minimal-ui', 'fullscreen'].some(
      (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
    )
  return {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    installed,
  }
}

export function externalHref(url: string, env: Env = currentEnv()): string {
  if (!env.installed || !/\bAndroid\b/.test(env.userAgent)) return url
  const m = /^(https?):\/\/(.+)$/i.exec(url)
  if (!m) return url
  const [, scheme, full] = m
  // "#Intent" starts the intent's own fragment, so the page's is dropped.
  const rest = full.split('#')[0]
  return (
    `intent://${rest}#Intent;scheme=${scheme.toLowerCase()};` +
    'action=android.intent.action.VIEW;' +
    'category=android.intent.category.BROWSABLE;' +
    `S.browser_fallback_url=${encodeURIComponent(url)};end`
  )
}
