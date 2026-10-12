import { afterEach, describe, expect, it } from 'vitest'
import { clearShare, pendingShare } from './share.ts'

afterEach(() => {
  clearShare()
  window.history.replaceState(null, '', '/')
})

describe('pendingShare', () => {
  it('takes the link Android shares in text, and tidies the address bar', () => {
    window.history.replaceState(
      null,
      '',
      '/share?title=Dal&text=Dal%20https%3A%2F%2Fblog.example%2Fdal%2F',
    )
    expect(pendingShare()).toEqual({
      url: 'https://blog.example/dal/',
      ingredients: null,
    })
    expect(window.location.pathname + window.location.search).toBe('/')
  })

  it('keeps the link until sign-in is done', () => {
    window.history.replaceState(
      null,
      '',
      '/share?url=https%3A%2F%2Fblog.example%2Fsoup%2F',
    )
    pendingShare()
    expect(pendingShare()?.url).toBe('https://blog.example/soup/')
    clearShare()
    expect(pendingShare()).toBeNull()
  })

  it('keeps a shared selection of ingredients, without the highlight link', () => {
    const text =
      '“1 can coconut milk\n2 tbsp green curry paste”\nhttps://blog.example/curry/#:~:text=1%20can'
    window.history.replaceState(
      null,
      '',
      `/share?text=${encodeURIComponent(text)}`,
    )
    expect(pendingShare()).toEqual({
      url: 'https://blog.example/curry/',
      ingredients: '1 can coconut milk\n2 tbsp green curry paste',
    })
    // Kept through sign-in too.
    expect(pendingShare()?.ingredients).toContain('green curry paste')
  })

  it('reads a link kept by an older version', () => {
    window.localStorage.setItem('sous:shared-url', 'https://blog.example/old/')
    expect(pendingShare()).toEqual({
      url: 'https://blog.example/old/',
      ingredients: null,
    })
  })

  it('ignores a normal visit', () => {
    expect(pendingShare()).toBeNull()
  })
})
