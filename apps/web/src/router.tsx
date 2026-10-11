import type { MouseEvent, ReactNode } from 'react'
import { navigate } from './navigation.ts'

/** An in-app link: a real <a href>, so it can be opened in a new tab. */
export function Link({
  to,
  className,
  children,
}: {
  to: string
  className?: string
  children: ReactNode
}) {
  function click(e: MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
      return
    e.preventDefault()
    navigate(to)
  }
  return (
    <a href={to} className={className} onClick={click}>
      {children}
    </a>
  )
}
