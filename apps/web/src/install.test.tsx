import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InstallOffer } from './InstallOffer.tsx'
import { isIos, listenForInstall, promptInstall } from './install.ts'

beforeEach(() => localStorage.clear())

describe('InstallOffer', () => {
  it('installs with the browser’s prompt where there is one', async () => {
    listenForInstall()
    const prompt = vi.fn(async () => {})
    const event = Object.assign(new Event('beforeinstallprompt'), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    })
    window.dispatchEvent(event)
    render(<InstallOffer signedIn />)
    await userEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(prompt).toHaveBeenCalled()
    expect(await promptInstall()).toBe(false) // used up
  })

  it('shows the two taps on an iPhone, and to install before signing in', () => {
    render(<InstallOffer signedIn={false} way="ios" />)
    expect(screen.getByText('Add to Home Screen')).toBeInTheDocument()
    expect(
      screen.getByText(/Install it first, then sign in/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })

  it('stays away once put off, and where it can’t install', async () => {
    const { unmount } = render(<InstallOffer signedIn way="ios" />)
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByLabelText('Install Sous')).toBeNull()
    unmount()
    render(<InstallOffer signedIn way="ios" />)
    expect(screen.queryByLabelText('Install Sous')).toBeNull()
    localStorage.clear()
    render(<InstallOffer signedIn way={null} />)
    expect(screen.queryByLabelText('Install Sous')).toBeNull()
  })
})

describe('isIos', () => {
  it('knows iPhones and iPads (which say they’re Macs)', () => {
    expect(
      isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5),
    ).toBe(true)
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(
      true,
    )
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(
      false,
    )
    expect(isIos('Mozilla/5.0 (Linux; Android 15; Pixel 9)', 5)).toBe(false)
  })
})
