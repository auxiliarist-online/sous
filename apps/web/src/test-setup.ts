import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
  // Pages are real URLs; start every test on the library.
  window.history.replaceState(null, '', '/')
})
