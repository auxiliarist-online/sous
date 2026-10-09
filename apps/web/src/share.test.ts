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
    expect(pendingShare()).toBe('https://blog.example/dal/')
    expect(window.location.pathname + window.location.search).toBe('/')
  })

  it('keeps the link until sign-in is done', () => {
    window.history.replaceState(
      null,
      '',
      '/share?url=https%3A%2F%2Fblog.example%2Fsoup%2F',
    )
    pendingShare()
    expect(pendingShare()).toBe('https://blog.example/soup/')
    clearShare()
    expect(pendingShare()).toBeNull()
  })

  it('ignores a normal visit', () => {
    expect(pendingShare()).toBeNull()
  })
})
