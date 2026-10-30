import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CookMode, TimerBar } from './CookMode.tsx'
import {
  clearTimers,
  clock,
  startTimer,
  stepTimes,
  stopTimer,
} from './cookTimers.ts'
import { fakeCookedApi } from './cookedFake.ts'
import { cookParams, cookPath, route } from './navigation.ts'
import type { IngredientLine, RecipeDetail } from './sous.ts'

const ID = '00000000-0000-0000-0000-0000000000c0'

const line = (
  lineNo: number,
  rawText: string,
  extra: Partial<IngredientLine> = {},
): IngredientLine => ({
  lineNo,
  optionNo: 1,
  rawText,
  section: null,
  name: null,
  quantity: null,
  quantityMax: null,
  unit: null,
  preparation: null,
  isOptional: false,
  ingredientId: null,
  ...extra,
})

const STEW: RecipeDetail = {
  id: ID,
  title: 'Lentil stew',
  sourceUrl: null,
  sourceName: null,
  sourceNote: null,
  license: null,
  saved: true,
  tags: [],
  favorite: null,
  servings: 4,
  prepMinutes: null,
  cookMinutes: null,
  totalMinutes: null,
  instructions: [
    'Soften the onion.',
    'Add the lentils and simmer 20 minutes, until tender.',
  ],
  handTyped: true,
  ingredients: [
    line(0, '1 cup red lentils', {
      name: 'red lentils',
      quantity: 1,
      unit: 'cup',
    }),
    line(1, '1 onion', { name: 'onion', quantity: 1 }),
  ],
  diets: [],
  cuisines: [],
  cuisinesCorrected: false,
}

const LINK_ONLY: RecipeDetail = {
  ...STEW,
  sourceUrl: 'https://example-blog.com/stew/',
  sourceName: 'Example Blog',
  instructions: null,
  handTyped: false,
}

function cookApi(r: RecipeDetail | null) {
  return { recipe: vi.fn(async () => r), ...fakeCookedApi() }
}

afterEach(() => {
  clearTimers()
  vi.useRealTimers()
})

describe('cook mode addresses', () => {
  it('routes /cook/<id> and carries the size and plan entry', () => {
    expect(route(`/cook/${ID}`)).toEqual({ page: 'cook', id: ID })
    expect(cookPath(ID)).toBe(`/cook/${ID}`)
    const path = cookPath(ID, 2, 'entry-1')
    expect(path).toBe(`/cook/${ID}?scale=2&entry=entry-1`)
    expect(cookParams(path.slice(path.indexOf('?')))).toEqual({
      scale: 2,
      entryId: 'entry-1',
    })
    expect(cookParams('?scale=7')).toEqual({ scale: 1, entryId: null })
  })
})

describe('step times', () => {
  it('finds the times in a step', () => {
    expect(stepTimes('Simmer 20 minutes, then rest 5 mins.')).toEqual([
      { text: '20 minutes', seconds: 1200 },
      { text: '5 mins', seconds: 300 },
    ])
    expect(stepTimes('Bake 25 to 30 minutes')).toEqual([
      { text: '25 to 30 minutes', seconds: 1500 },
    ])
    expect(stepTimes('Roast for 1 hour')[0].seconds).toBe(3600)
    expect(stepTimes('Rest half an hour')[0].seconds).toBe(1800)
    expect(stepTimes('Add 2 cups water')).toEqual([])
    // "a" inside a word isn't "a minute".
    expect(stepTimes('Give the pasta an extra minute')).toEqual([])
  })

  it('shows a countdown as a clock', () => {
    expect(clock(1200)).toBe('20:00')
    expect(clock(65)).toBe('1:05')
    expect(clock(3725)).toBe('1:02:05')
  })
})

describe('CookMode (TYL-75)', () => {
  it('checks off the ingredients at the planned size', async () => {
    render(<CookMode api={cookApi(STEW)} id={ID} scale={2} />)
    expect(await screen.findByText('2 cups red lentils')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Half' }))
    expect(screen.getByText('½ cup red lentils')).toBeInTheDocument()
    const box = screen.getByRole('checkbox', { name: /onion/ })
    await userEvent.click(box)
    expect(box).toBeChecked()
  })

  it('goes through the steps one at a time, with a timer for each time', async () => {
    const api = cookApi(STEW)
    render(<CookMode api={api} id={ID} entryId="e-1" />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Start the steps' }),
    )
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /timer/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/simmer 20 minutes/)).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: 'Start a 20:00 timer' }),
    )
    render(<TimerBar />)
    expect(screen.getByText(/Step 2: 20 minutes/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Cooked Lentil stew' }),
    )
    expect(api.markCooked).toHaveBeenCalledWith(
      expect.objectContaining({ recipeId: ID, planEntryId: 'e-1', scale: 1 }),
    )
  })

  it('never shows a link-only recipe’s steps: it opens them on the author’s page', async () => {
    render(<CookMode api={cookApi(LINK_ONLY)} id={ID} />)
    const open = await screen.findByRole('link', {
      name: /Open the steps on Example Blog/,
    })
    expect(open).toHaveAttribute('href', 'https://example-blog.com/stew/')
    expect(screen.queryByRole('button', { name: 'Start the steps' })).toBeNull()
    expect(screen.queryByText(/simmer/)).toBeNull()
  })

  it('keeps the screen on while cooking, and lets go after', async () => {
    const release = vi.fn(async () => {})
    const sentinel = { release, addEventListener: vi.fn() }
    const request = vi.fn(async () => sentinel)
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request },
      configurable: true,
    })
    const { unmount } = render(<CookMode api={cookApi(STEW)} id={ID} />)
    expect(
      await screen.findByText('The screen stays on while you cook.', {
        exact: false,
      }),
    ).toBeInTheDocument()
    expect(request).toHaveBeenCalledWith('screen')
    unmount()
    expect(release).toHaveBeenCalled()
    Reflect.deleteProperty(navigator, 'wakeLock')
  })
})

describe('timers', () => {
  it('alert when they end, whatever page is showing', () => {
    vi.useFakeTimers()
    const vibrate = vi.fn()
    Object.defineProperty(navigator, 'vibrate', {
      value: vibrate,
      configurable: true,
    })
    render(<TimerBar />)
    act(() => {
      startTimer('Step 2: 20 minutes', 1200)
    })
    expect(screen.getByText('20:00')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1200 * 1000)
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Time's up: Step 2: 20 minutes",
    )
    expect(vibrate).toHaveBeenCalled()
    Reflect.deleteProperty(navigator, 'vibrate')
  })

  it('stop when asked', () => {
    render(<TimerBar />)
    let id = ''
    act(() => {
      id = startTimer('Rest', 60).id
    })
    expect(screen.getByLabelText('Timers')).toBeInTheDocument()
    act(() => stopTimer(id))
    expect(screen.queryByLabelText('Timers')).toBeNull()
  })
})
