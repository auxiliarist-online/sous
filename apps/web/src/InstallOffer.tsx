import { useState } from 'react'
import { promptInstall, useInstallWay, type InstallWay } from './install.ts'

const DISMISSED = 'sous:install-dismissed'

/** Whether the person said "Not now" on this device before. */
function wasDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === '1'
  } catch {
    return false
  }
}

/** "Install Sous on your phone": one tap where the browser can install
 *  apps (Android), the two taps to make on an iPhone. Shown until it's
 *  installed or put off. Before sign-in it says to install first: an
 *  iPhone keeps the installed app's sign-in apart from Safari's. */
export function InstallOffer({
  signedIn,
  way: forced,
}: {
  signedIn: boolean
  /** Tests set the way to install; the app detects it. */
  way?: InstallWay
}) {
  const detected = useInstallWay()
  const way = forced === undefined ? detected : forced
  const [hidden, setHidden] = useState(wasDismissed)
  if (!way || hidden) return null

  function dismiss() {
    setHidden(true)
    try {
      localStorage.setItem(DISMISSED, '1')
    } catch {
      // Private browsing: it comes back next time, which is fine.
    }
  }

  return (
    <aside className="card install-offer" aria-label="Install Sous">
      <p>
        <strong>Install Sous on your phone</strong> for one-tap opening and your
        shopping list offline.
        {!signedIn && ' Install it first, then sign in from the app.'}
      </p>
      {way === 'ios' && (
        <ol className="small">
          <li>
            Tap <strong>Share</strong> <ShareIcon /> at the bottom of Safari (in
            other browsers, it may be in the menu).
          </li>
          <li>
            Choose <strong>Add to Home Screen</strong>, then{' '}
            <strong>Add</strong>.
          </li>
        </ol>
      )}
      <div className="actions">
        {way === 'prompt' && (
          <button type="button" onClick={() => void promptInstall()}>
            Install
          </button>
        )}
        <button type="button" className="link small" onClick={dismiss}>
          Not now
        </button>
      </div>
    </aside>
  )
}

/** iOS's Share button: a box with an arrow out of the top. */
function ShareIcon() {
  return (
    <svg
      className="share-icon"
      viewBox="0 0 16 20"
      width="12"
      height="15"
      aria-hidden="true"
    >
      <path
        d="M8 1v11M4.5 4.5 8 1l3.5 3.5M5 8H2v11h12V8h-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  )
}
