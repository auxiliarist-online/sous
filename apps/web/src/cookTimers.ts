// Cook mode's timers and screen wake lock (TYL-75). Timers live outside any
// page, so they keep running (and alert) when the user moves around the app.
import { useEffect, useState, useSyncExternalStore } from 'react'

export interface Timer {
  id: string
  /** What it's for: the words around the time in the step. */
  label: string
  seconds: number
  /** When it ends (epoch ms). */
  endsAt: number
  /** Finished and alerted, until dismissed. */
  done: boolean
}

/** A time found in a step: "simmer 20 minutes" -> 1200 s. */
export interface StepTime {
  /** The words as written ("20 minutes"). */
  text: string
  seconds: number
}

const UNITS: [RegExp, number][] = [
  [/^h(ou)?rs?$/i, 3600],
  [/^min(ute)?s?$/i, 60],
  [/^sec(ond)?s?$/i, 1],
]

/** The times in a step, each as a possible timer. A range ("25 to 30
 *  minutes") is timed to its low end, to check early. */
export function stepTimes(step: string): StepTime[] {
  const out: StepTime[] = []
  const re =
    /\b(\d+(?:\.\d+)?|an?|one|half an?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/gi
  for (const m of step.matchAll(re)) {
    const unit = UNITS.find(([u]) => u.test(m[3]))
    if (!unit) continue
    const word = m[1].toLowerCase()
    const n =
      word === 'a' || word === 'an' || word === 'one'
        ? 1
        : word.startsWith('half')
          ? 0.5
          : Number(word)
    const seconds = Math.round(n * unit[1])
    if (seconds > 0 && seconds <= 24 * 3600)
      out.push({ text: m[0].trim(), seconds })
  }
  return out
}

/** "20:00", "1:05:00". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

// The running timers, shared by every page.
let timers: Timer[] = []
const listeners = new Set<() => void>()
const handles = new Map<string, ReturnType<typeof setTimeout>>()

// Tell every page showing the timers that they changed.
function emit() {
  for (const l of listeners) l()
}

/** Ring, buzz and notify when a timer ends; each is best effort. */
function alert(t: Timer) {
  try {
    navigator.vibrate?.([400, 200, 400, 200, 400])
  } catch {
    // No vibration on this device.
  }
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (Ctx) {
      const ctx = new Ctx()
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator()
        osc.frequency.value = 880
        osc.connect(ctx.destination)
        osc.start(ctx.currentTime + i * 0.5)
        osc.stop(ctx.currentTime + i * 0.5 + 0.3)
        // Let the sound go once the last beep ends.
        if (i === 2) osc.onended = () => void ctx.close()
      }
    }
  } catch {
    // No sound: the banner and notification still show.
  }
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      // Android Chrome only notifies through the service worker; desktop
      // browsers can from the page.
      const options = { body: t.label, tag: t.id, vibrate: [400, 200, 400] }
      void navigator.serviceWorker?.ready
        .then((reg) => reg.showNotification("Time's up", options))
        .catch(() => new Notification("Time's up", options))
    }
  } catch {
    // Not supported here: the banner and sound still go.
  }
}

/** Start a timer; it alerts when it ends, whatever page is showing. */
export function startTimer(
  label: string,
  seconds: number,
  now = Date.now(),
): Timer {
  const t: Timer = {
    id: `${now}-${Math.random().toString(36).slice(2)}`,
    label,
    seconds,
    endsAt: now + seconds * 1000,
    done: false,
  }
  timers = [...timers, t]
  handles.set(
    t.id,
    setTimeout(() => {
      timers = timers.map((x) => (x.id === t.id ? { ...x, done: true } : x))
      handles.delete(t.id)
      alert(t)
      emit()
    }, seconds * 1000),
  )
  // Ask once, so a timer can notify while the user is elsewhere.
  try {
    if ('Notification' in window && Notification.permission === 'default')
      void Notification.requestPermission()
  } catch {
    // Not supported here.
  }
  emit()
  return t
}

/** Stop a running timer, or dismiss a finished one. */
export function stopTimer(id: string): void {
  const h = handles.get(id)
  if (h) clearTimeout(h)
  handles.delete(id)
  timers = timers.filter((t) => t.id !== id)
  emit()
}

/** The timers, live. */
export function useTimers(): Timer[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => timers,
  )
}

/** The current time, every second while `on`, for countdowns. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const tick = () => setNow(Date.now())
    // Start from the right time, not when the last timer stopped.
    const first = setTimeout(tick, 0)
    const t = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [on])
  return now
}

/** Keep the screen on while mounted (Screen Wake Lock API), asking again
 *  when the page comes back into view (the browser drops the lock when it's
 *  hidden). Returns whether it's held. */
export function useWakeLock(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    // Every lock acquired, in case requests overlap.
    const locks = new Set<WakeLockSentinel>()
    let live = true
    // Ask for a lock while the page is visible.
    const request = async () => {
      try {
        if (
          !('wakeLock' in navigator) ||
          document.visibilityState !== 'visible'
        )
          return
        const lock = await navigator.wakeLock.request('screen')
        if (!live) {
          void lock.release()
          return
        }
        locks.add(lock)
        setHeld(true)
        lock.addEventListener('release', () => {
          locks.delete(lock)
          if (live) setHeld(locks.size > 0)
        })
      } catch {
        // Refused (battery saver) or not supported: the page still works.
        if (live) setHeld(locks.size > 0)
      }
    }
    const again = () => {
      if (document.visibilityState === 'visible') void request()
    }
    void request()
    document.addEventListener('visibilitychange', again)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', again)
      for (const lock of locks) void lock.release()
      locks.clear()
    }
  }, [])
  return held
}

/** For tests: forget every timer. */
export function clearTimers(): void {
  for (const h of handles.values()) clearTimeout(h)
  handles.clear()
  timers = []
  emit()
}
