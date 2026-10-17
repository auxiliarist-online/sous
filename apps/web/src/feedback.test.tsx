import type { Session } from '@supabase/supabase-js'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Feedback } from './Feedback.tsx'
import { FeedbackLimitError, sendFeedback } from './feedback.ts'

describe('Feedback', () => {
  it('reports a problem with the page it came from', async () => {
    const api = { sendFeedback: vi.fn(async () => true) }
    render(<Feedback api={api} page="/plan" />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Report a problem' }),
    )
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    expect(screen.getByText(/a replay of where you tapped/)).toBeInTheDocument()
    await userEvent.type(
      screen.getByLabelText(/What went wrong/),
      'The salt is on my list twice',
    )
    await userEvent.click(send)
    expect(api.sendFeedback).toHaveBeenCalledWith(
      'The salt is on my list twice',
      '/plan',
      'problem',
    )
    expect(await screen.findByRole('status')).toHaveTextContent('Thanks!')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('sends a suggestion, without a replay', async () => {
    const api = { sendFeedback: vi.fn(async () => false) }
    render(<Feedback api={api} page="/" />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Suggest something' }),
    )
    expect(screen.queryByText(/a replay/)).toBeNull()
    await userEvent.type(screen.getByLabelText(/What's missing/), 'Desserts')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(api.sendFeedback).toHaveBeenCalledWith('Desserts', '/', 'idea')
  })

  it('keeps the message when it can’t send', async () => {
    const api = {
      sendFeedback: vi.fn(async () => {
        throw new Error('offline')
      }),
    }
    render(<Feedback api={api} page="/" />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Report a problem' }),
    )
    await userEvent.type(screen.getByRole('textbox'), 'Hello')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That didn't send",
    )
    expect(screen.getByRole('textbox')).toHaveValue('Hello')
  })

  it('says when the day’s limit is reached, and clears the alert on edit', async () => {
    const api = {
      sendFeedback: vi.fn(async () => {
        throw new FeedbackLimitError('That’s the most feedback for today.')
      }),
    }
    render(<Feedback api={api} page="/" />)
    await userEvent.click(
      screen.getByRole('button', { name: 'Suggest something' }),
    )
    await userEvent.type(screen.getByRole('textbox'), 'One more')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'most feedback for today',
    )
    await userEvent.type(screen.getByRole('textbox'), '!')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('sendFeedback', () => {
  const session = {} as Session
  /** A stand-in database: the insert's answer, and what was inserted. */
  function db(error: unknown, id = 7) {
    const inserted: unknown[] = []
    const client = {
      from: () => ({
        insert: (row: unknown) => {
          inserted.push(row)
          return {
            select: () => ({
              single: async () => ({ data: error ? null : { id }, error }),
            }),
          }
        },
      }),
    } as unknown as Parameters<typeof sendFeedback>[0]
    return { client, inserted }
  }
  const filed = (ok: boolean) =>
    vi.fn(async () => new Response(JSON.stringify({ filed: ok })))

  it('saves a problem with its device and replay, then files it', async () => {
    const { client, inserted } = db(null)
    const send = filed(true)
    const report = {
      message: ' Blank list ',
      page: '/list',
      kind: 'problem' as const,
      device: 'iPhone',
      replayUrl: 'https://us.posthog.com/replay/abc',
    }
    expect(await sendFeedback(client, session, report, send)).toBe(true)
    expect(inserted).toEqual([
      {
        message: 'Blank list',
        page: '/list',
        kind: 'problem',
        device: 'iPhone',
        replay_url: 'https://us.posthog.com/replay/abc',
      },
    ])
    expect(send).toHaveBeenCalledWith(session, '/feedback/7/file', {
      method: 'POST',
    })
  })

  it('keeps a saved problem when filing fails, and files no ideas', async () => {
    const { client } = db(null)
    const down = vi.fn(async () => {
      throw new Error('offline')
    })
    const problem = { message: 'x', page: '/', kind: 'problem' as const }
    expect(await sendFeedback(client, session, problem, down)).toBe(false)
    const send = filed(true)
    const idea = { ...problem, kind: 'idea' as const }
    expect(await sendFeedback(client, session, idea, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('turns the daily limit into its own error', async () => {
    const report = { message: 'x', page: '/', kind: 'idea' as const }
    await expect(
      sendFeedback(db({ code: '54000' }).client, session, report),
    ).rejects.toBeInstanceOf(FeedbackLimitError)
    await expect(
      sendFeedback(db({ code: '42501' }).client, session, report),
    ).rejects.not.toBeInstanceOf(FeedbackLimitError)
  })
})
