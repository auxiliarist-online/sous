import { afterEach, describe, expect, it, vi } from 'vitest'
import { bookmarklet, MAX_LD_BLOCKS } from './bookmarklet.ts'

const RECIPE = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Dal',
}

/** Runs the bookmarklet on the current test document; returns the URL it opens. */
function run(): string | null {
  const opened = vi.spyOn(window, 'open').mockReturnValue({} as Window)
  const code = bookmarklet('https://sous.example').slice('javascript:'.length)
  new Function(code)()
  return (opened.mock.calls[0]?.[0] as string | undefined) ?? null
}

function payload(url: string) {
  const [, raw] = url.split('#import=')
  return JSON.parse(decodeURIComponent(raw))
}

afterEach(() => {
  document.head.innerHTML = ''
  vi.restoreAllMocks()
})

describe('Save to Sous bookmarklet', () => {
  it('is one line of javascript', () => {
    const code = bookmarklet('https://sous.example')
    expect(code.startsWith('javascript:')).toBe(true)
    expect(code).not.toContain('\n')
  })

  it('opens Sous with the page’s recipe data, canonical URL and site name', () => {
    document.head.innerHTML = `
      <link rel="canonical" href="https://blog.example/dal/">
      <meta property="og:site_name" content="Blog">
      <script type="application/ld+json">${JSON.stringify({ '@type': 'Organization' })}</script>
      <script type="application/ld+json">${JSON.stringify(RECIPE)}</script>`
    const url = run()!
    expect(url.startsWith('https://sous.example/#import=')).toBe(true)
    expect(payload(url)).toEqual({
      url: 'https://blog.example/dal/',
      site: 'Blog',
      ld: [JSON.stringify(RECIPE)],
    })
  })

  it('says so when the page has no recipe data, and opens nothing', () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    expect(run()).toBeNull()
    expect(alert).toHaveBeenCalledWith(
      "Sous couldn't find a recipe on this page.",
    )
  })

  it('sends at most the API’s block limit', () => {
    document.head.innerHTML = Array.from(
      { length: MAX_LD_BLOCKS + 5 },
      () =>
        `<script type="application/ld+json">${JSON.stringify(RECIPE)}</script>`,
    ).join('')
    expect(payload(run()!).ld).toHaveLength(MAX_LD_BLOCKS)
  })
})
