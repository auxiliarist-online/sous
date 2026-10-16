import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Feedback } from './Feedback.tsx'
import { FeedbackLimitError, sendFeedback } from './feedback.ts'

describe('Feedback', () => {
  it('sends a message with the page it came from', async () => {
    const api = { sendFeedback: vi.fn(async () => {}) }
    render(<Feedback api={api} page="/plan" />)
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    await userEvent.type(
      screen.getByLabelText(/what's missing/),
      'The salt is on my list twice',
    )
    await userEvent.click(send)
    expect(api.sendFeedback).toHaveBeenCalledWith(
      'The salt is on my list twice',
      '/plan',
    )
    expect(await screen.findByRole('status')).toHaveTextContent('Thanks!')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('keeps the message when it can’t send', async () => {
    const api = {
      sendFeedback: vi.fn(async () => {
        throw new Error('offline')
      }),
    }
    render(<Feedback api={api} page="/" />)
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
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
    await userEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
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
  const db = (error: unknown) =>
    ({
      from: () => ({ insert: async () => ({ error }) }),
    }) as unknown as Parameters<typeof sendFeedback>[0]

  it('turns the daily limit into its own error', async () => {
    await expect(
      sendFeedback(db({ code: '54000', message: 'too much' }), 'x', '/'),
    ).rejects.toBeInstanceOf(FeedbackLimitError)
    await expect(
      sendFeedback(db({ code: '42501', message: 'nope' }), 'x', '/'),
    ).rejects.not.toBeInstanceOf(FeedbackLimitError)
    await expect(sendFeedback(db(null), 'x', '/')).resolves.toBeUndefined()
  })
})
