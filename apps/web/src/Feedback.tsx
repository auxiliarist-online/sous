import { useState } from 'react'

export interface FeedbackApi {
  /** Send a message to the team, with the page it was sent from. */
  sendFeedback(message: string, page: string): Promise<void>
}

const MAX = 2000

/** "Send feedback", at the foot of every signed-in page: a short form for
 *  beta testers to say what's broken or missing, from where they are. */
export function Feedback({ api, page }: { api: FeedbackApi; page: string }) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>(
    'idle',
  )

  async function send() {
    setStatus('sending')
    try {
      await api.sendFeedback(message, page)
      setMessage('')
      setOpen(false)
      setStatus('sent')
    } catch {
      setStatus('error')
    }
  }

  if (!open) {
    return (
      <footer className="feedback">
        {status === 'sent' && (
          <p role="status" className="muted small">
            Thanks! We read every message.
          </p>
        )}
        <button
          type="button"
          className="link small"
          onClick={() => {
            setOpen(true)
            setStatus('idle')
          }}
        >
          Send feedback
        </button>
      </footer>
    )
  }

  return (
    <footer className="feedback">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <label htmlFor="feedback-message">
          What's working, what's broken, what's missing?
        </label>
        <textarea
          id="feedback-message"
          rows={4}
          maxLength={MAX}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <p className="muted small">
          Sent with the page you're on. We can see it's from you, so we can
          write back.
        </p>
        {status === 'error' && (
          <p role="alert" className="error small">
            That didn't send. Try again.
          </p>
        )}
        <div className="actions">
          <button
            type="submit"
            disabled={status === 'sending' || !message.trim()}
          >
            {status === 'sending' ? 'Sending…' : 'Send'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        </div>
      </form>
    </footer>
  )
}
