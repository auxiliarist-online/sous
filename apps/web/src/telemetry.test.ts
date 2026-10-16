import { describe, expect, it, vi } from 'vitest'
import { replayUrl, startTelemetry } from './telemetry.ts'

const { init } = vi.hoisted(() => ({ init: vi.fn() }))
vi.mock('posthog-js', () => ({
  default: { init, get_session_replay_url: () => 'https://us.posthog.com/r' },
}))

describe('startTelemetry', () => {
  it('stays off without a key', async () => {
    expect(await startTelemetry('')).toBe(false)
    expect(init).not.toHaveBeenCalled()
    expect(replayUrl()).toBeNull()
  })

  it('hides all text, typed or shown, in replays and clicks', async () => {
    expect(await startTelemetry('phc_test')).toBe(true)
    expect(init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        mask_all_text: true,
        mask_all_element_attributes: true,
        session_recording: expect.objectContaining({
          maskAllInputs: true,
          maskTextSelector: '*',
          recordBody: false,
          recordHeaders: false,
        }),
      }),
    )
    expect(replayUrl()).toBe('https://us.posthog.com/r')
  })
})
