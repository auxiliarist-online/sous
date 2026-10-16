import { describe, expect, it, vi } from 'vitest'
import { keepBreadcrumb, startErrorReporting } from './errors.ts'

const { init } = vi.hoisted(() => ({ init: vi.fn() }))
vi.mock('@sentry/browser', () => ({ init }))

describe('startErrorReporting', () => {
  it('stays off without a DSN', async () => {
    expect(await startErrorReporting('')).toBe(false)
    expect(init).not.toHaveBeenCalled()
  })

  it('starts Sentry, without traces, when there is one', async () => {
    expect(await startErrorReporting('https://k@o1.ingest.sentry.io/1')).toBe(
      true,
    )
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://k@o1.ingest.sentry.io/1',
        tracesSampleRate: 0,
        beforeBreadcrumb: keepBreadcrumb,
      }),
    )
  })
})

describe('keepBreadcrumb', () => {
  it('drops requests and console output, keeps navigation and clicks', () => {
    expect(keepBreadcrumb({ category: 'fetch' })).toBeNull()
    expect(keepBreadcrumb({ category: 'xhr' })).toBeNull()
    expect(keepBreadcrumb({ category: 'console' })).toBeNull()
    expect(keepBreadcrumb({ category: 'navigation' })).toEqual({
      category: 'navigation',
    })
  })
})
