import { afterEach, describe, expect, it } from 'vitest'
import { clearPage, pendingPage } from './page.ts'

const DATA = {
  url: 'https://blog.example/dal/',
  site: 'Blog',
  ld: ['{"@type":"Recipe"}'],
}

function arrive(data: unknown) {
  window.history.replaceState(
    null,
    '',
    '/#import=' + encodeURIComponent(JSON.stringify(data)),
  )
}

afterEach(() => {
  clearPage()
  window.history.replaceState(null, '', '/')
})

describe('pendingPage', () => {
  it('reads a page from the address and tidies it away', () => {
    arrive(DATA)
    expect(pendingPage()).toEqual({
      url: DATA.url,
      siteName: 'Blog',
      ld: DATA.ld,
    })
    expect(window.location.hash).toBe('')
  })

  it('keeps the page until sign-in is done', () => {
    arrive(DATA)
    pendingPage()
    expect(pendingPage()?.url).toBe(DATA.url)
    clearPage()
    expect(pendingPage()).toBeNull()
  })

  it.each([
    ['a non-web address', { ...DATA, url: 'javascript:alert(1)' }],
    ['no data blocks', { ...DATA, ld: [] }],
    ['too many blocks', { ...DATA, ld: Array(21).fill('{}') }],
    ['blocks that are not text', { ...DATA, ld: [{}] }],
  ])('ignores %s', (_, data) => {
    arrive(data)
    expect(pendingPage()).toBeNull()
  })

  it('ignores a broken fragment', () => {
    window.history.replaceState(null, '', '/#import=%E0%A4%A')
    expect(pendingPage()).toBeNull()
  })
})
