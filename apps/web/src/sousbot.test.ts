import { describe, expect, it } from 'vitest'
import page from '../public/sousbot.html?raw'

// The public crawler page (TYL-36). Site owners rely on it to block or contact us.
describe('SousBot page', () => {
  it('has a real contact address', () => {
    expect(page).not.toContain('SOUSBOT_CONTACT_EMAIL')
    expect(page).toMatch(/href="mailto:[^"@\s]+@[^"\s]+"/)
  })

  it('shows how to block SousBot in robots.txt', () => {
    expect(page).toContain('User-agent: SousBot\nDisallow: /')
  })
})
