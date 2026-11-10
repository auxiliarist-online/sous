// Open the Add-a-recipe sheet (TYL-151) from anywhere: the round add button,
// or "+ Add" on Your recipes. The app listens and shows it.
import { useEffect } from 'react'

const EVENT = 'sous:add-recipe'

/** Show the Add-a-recipe sheet. */
export function openAddSheet(): void {
  window.dispatchEvent(new Event(EVENT))
}

/** Call `onOpen` whenever something asks for the sheet. */
export function useAddSheetRequests(onOpen: () => void): void {
  useEffect(() => {
    window.addEventListener(EVENT, onOpen)
    return () => window.removeEventListener(EVENT, onOpen)
  }, [onOpen])
}
