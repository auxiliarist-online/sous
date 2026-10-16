import { useState } from 'react'
import { FeedbackLimitError, type FeedbackKind } from './feedback.ts'

export interface FeedbackApi {
  /** Send a problem or an idea to the team, with the page it was sent from
   *  (a problem is filed as a bug, with the session's replay). */
  sendFeedback(
    message: string,
    page: string,
    kind: FeedbackKind,
  ): Promise<unknown>
}

const PROMPTS: Record<FeedbackKind, string> = {
  problem: 'What went wrong? What did you expect to happen?',
  idea: "What's missing, or what would make Sous better?",
}

const MAX = 2000

/** "Report a problem" and "Suggest something", at the foot of every
 *  signed-in page: a short form for beta testers to say what's broken or
 *  missing, from where they are. */
export function Feedback({ api, page }: { api: FeedbackApi; page: string }) {
  const [open, setOpen] = useState<FeedbackKind | null>(null)
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>(
    'idle',
  )
  const [error, setError] = useState('')

  // Send the message; on the daily limit, say so rather than "try again".
  async function send() {
    setStatus('sending')
    try {
      await api.sendFeedback(message, page, open ?? 'idea')
      setMessage('')
      setOpen(null)
      setStatus('sent')
    } catch (err) {
      setError(
        err instanceof FeedbackLimitError
          ? err.message
          : "That didn't send. Try again.",
      )
      setStatus('error')
    }
  }

  if (!open) {
    return (
      <footer className="feedback">
        {status === 'sent' && (
          <p role="status" className="muted small">
            Thanks! We read every one.
          </p>
        )}
        {(['problem', 'idea'] as const).map((kind, i) => (
          <span key={kind}>
            {i > 0 && <span className="muted small"> · </span>}
            <button
              type="button"
              className="link small"
              onClick={() => {
                setOpen(kind)
                setStatus('idle')
              }}
            >
              {kind === 'problem' ? 'Report a problem' : 'Suggest something'}
            </button>
          </span>
        ))}
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
        <label htmlFor="feedback-message">{PROMPTS[open]}</label>
        <textarea
          id="feedback-message"
          rows={4}
          maxLength={MAX}
          value={message}
          onChange={(e) => {
            setMessage(e.target.value)
            if (status === 'error') setStatus('idle')
          }}
        />
        <p className="muted small">
          {open === 'problem'
            ? "Sent with the page you're on, your phone and browser, and a replay of where you tapped (with all text hidden). "
            : "Sent with the page you're on. "}
          We can see it's from you, so we can write back.
        </p>
        {status === 'error' && (
          <p role="alert" className="error small">
            {error}
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
            onClick={() => setOpen(null)}
          >
            Cancel
          </button>
        </div>
      </form>
    </footer>
  )
}
