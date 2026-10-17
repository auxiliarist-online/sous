// Installing Sous on a phone's home screen, for beta testers who arrive from
// a link: Android browsers can show their own install prompt; on an iPhone
// it takes two taps the person has to be told about.
import { useEffect, useState } from 'react'

/** Chrome's install prompt event (not in TypeScript's DOM types). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** The prompt the browser offered, held until the person taps "Install". */
let deferred: InstallPromptEvent | null = null
const listeners = new Set<() => void>()

/** Whether this is an Android phone or tablet: where Sous offers its own
 *  install button. A desktop browser keeps its usual install icon. */
export function isAndroid(ua = navigator.userAgent): boolean {
  return /Android/i.test(ua)
}

/** Catch an Android browser's install prompt as the page loads (it fires
 *  once, early), so the app can offer it with its own button later. */
export function listenForInstall(android = isAndroid()): void {
  if (!android) return
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
    listeners.forEach((l) => l())
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    listeners.forEach((l) => l())
  })
}

/** Whether Sous is running installed (from the home screen). */
export function isInstalled(): boolean {
  return (
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as { standalone?: boolean }).standalone === true
  )
}

/** Whether this is an iPhone or iPad, where installing is done by hand
 *  (iPads say they're Macs, but have a touch screen). */
export function isIos(
  ua = navigator.userAgent,
  touch = navigator.maxTouchPoints,
): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1)
}

/** How Sous can be installed here: with the browser's prompt, by hand on
 *  an iPhone, or not at all (installed already, or a desktop browser). */
export type InstallWay = 'prompt' | 'ios' | null

/** The way to install, kept current as the browser offers its prompt. */
export function useInstallWay(): InstallWay {
  const [, refresh] = useState(0)
  useEffect(() => {
    const update = () => refresh((n) => n + 1)
    listeners.add(update)
    return () => {
      listeners.delete(update)
    }
  }, [])
  if (isInstalled()) return null
  if (deferred) return 'prompt'
  return isIos() ? 'ios' : null
}

/** Show the browser's install prompt; true if the person installed. */
export async function promptInstall(): Promise<boolean> {
  const prompt = deferred
  if (!prompt) return false
  await prompt.prompt()
  const { outcome } = await prompt.userChoice
  deferred = null
  listeners.forEach((l) => l())
  return outcome === 'accepted'
}
