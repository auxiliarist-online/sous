import type { MouseEvent, ReactNode } from 'react'
import { navigate } from './navigation.ts'

/** An in-app link: a real <a href>, so it can be opened in a new tab. */
export function Link({
  to,
  className,
  children,
  onNavigate,
  current,
  label,
}: {
  to: string
  className?: string
  children: ReactNode
  /** The page the user is on (a tab bar's current tab). */
  current?: boolean
  /** An accessible name, when the text alone isn't one (an icon). */
  label?: string
  /** Runs just before navigating (e.g. to remember the scroll position). */
  onNavigate?: () => void
}) {
  function click(e: MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
      return
    e.preventDefault()
    onNavigate?.()
    navigate(to)
  }
  return (
    <a
      href={to}
      className={className}
      onClick={click}
      aria-current={current ? 'page' : undefined}
      aria-label={label}
    >
      {children}
    </a>
  )
}
