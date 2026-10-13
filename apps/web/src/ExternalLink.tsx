import type { AnchorHTMLAttributes } from 'react'
import { externalHref } from './externalLink.ts'

/** A link to another site, opened in the user's own browser (TYL-82). */
export function ExternalLink({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const target = externalHref(href)
  // An intent: link leaves the app by itself; a new tab would stay blank.
  const newTab = target === href
  return (
    <a
      {...rest}
      href={target}
      {...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  )
}
