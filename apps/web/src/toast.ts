// A short message at the top of the screen (TYL-148), from any page: "Saved
// to your recipes.", "4 items added to your list." One shows at a time.
import { useEffect, useState } from 'react'

const EVENT = 'sous:toast'
export const TOAST_MS = 2400

/** Show a message for a moment. */
export function showToast(message: string): void {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: message }))
}

/** The message showing now, or null; each new one restarts the timer. */
export function useToast(): string | null {
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const show = (e: Event) => {
      setMessage((e as CustomEvent<string>).detail)
      clearTimeout(timer)
      timer = setTimeout(() => setMessage(null), TOAST_MS)
    }
    window.addEventListener(EVENT, show)
    return () => {
      window.removeEventListener(EVENT, show)
      clearTimeout(timer)
    }
  }, [])
  return message
}
