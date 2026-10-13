import { describe, expect, it } from 'vitest'
import { externalHref } from './externalLink.ts'

const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) Chrome/141.0 Mobile'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari'
const URL = 'https://www.101cookbooks.com/scallion-chive-panade/?x=1#top'

describe('externalHref', () => {
  it('hands the installed Android app’s links to the default browser', () => {
    const href = externalHref(URL, { userAgent: ANDROID, installed: true })
    expect(href).toBe(
      'intent://www.101cookbooks.com/scallion-chive-panade/?x=1#Intent;' +
        'scheme=https;action=android.intent.action.VIEW;' +
        'category=android.intent.category.BROWSABLE;' +
        `S.browser_fallback_url=${encodeURIComponent(URL)};end`,
    )
    // No package: Android picks the default browser, whichever it is.
    expect(href).not.toContain('package=')
  })

  it.each([
    ['in an Android browser tab', ANDROID, false],
    ['installed on iPhone', IPHONE, true],
    [
      'on a desktop browser',
      'Mozilla/5.0 (X11; Linux x86_64) Firefox/131',
      false,
    ],
  ])('leaves links alone %s', (_, userAgent, installed) => {
    expect(externalHref(URL, { userAgent, installed })).toBe(URL)
  })

  it('only rewrites web links', () => {
    const env = { userAgent: ANDROID, installed: true }
    expect(externalHref('mailto:hi@example.com', env)).toBe(
      'mailto:hi@example.com',
    )
  })
})
