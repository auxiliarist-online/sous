import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Feedback } from './Feedback.tsx'

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
})
