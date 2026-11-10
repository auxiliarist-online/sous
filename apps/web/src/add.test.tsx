import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddRecipeSheet } from './AddRecipe.tsx'
import { takeRequestedLink } from './library.ts'
import { DrawerPanel, Lips, Toaster } from './Shell.tsx'
import { draftFromSpeech, type Recognition } from './speech.ts'
import { showToast, TOAST_MS } from './toast.ts'

function api() {
  return {
    recipe: vi.fn(async () => null),
    saveManual: vi.fn(async () => 'new-id'),
    readPhotos: vi.fn(),
    sourceNotes: vi.fn(async () => []),
  }
}

afterEach(() => {
  vi.useRealTimers()
  window.history.replaceState(null, '', '/')
  Reflect.deleteProperty(window, 'webkitSpeechRecognition')
})

describe('Add a recipe (TYL-151)', () => {
  it('offers five ways in', () => {
    render(<AddRecipeSheet api={api()} onClose={vi.fn()} />)
    const ways = screen.getAllByRole('button').map((b) => b.textContent)
    expect(ways).toEqual([
      'Paste a linkFrom any recipe site',
      'Share from your browserTap Share on a page, choose Sous',
      'Photo of a cookbook pageSous reads it into a draft',
      'Say itDictate a family recipe',
      'Type it inPrivate to you',
    ])
  })

  it('checks a link, then hands it to Your recipes to save', async () => {
    const onClose = vi.fn()
    render(<AddRecipeSheet api={api()} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: /Paste a link/ }))
    const field = screen.getByLabelText('Recipe link')
    await userEvent.type(field, 'not a link')
    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Paste a link to a recipe page, starting with https://',
    )
    await userEvent.clear(field)
    await userEvent.type(field, 'https://example-blog.com/stew/')
    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(onClose).toHaveBeenCalled()
    expect(window.location.pathname).toBe('/recipes')
    expect(takeRequestedLink()).toBe('https://example-blog.com/stew/')
  })

  it('types one in, and opens it once saved', async () => {
    const a = api()
    const onClose = vi.fn()
    render(<AddRecipeSheet api={a} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: /Type it in/ }))
    expect(
      screen.getByRole('dialog', { name: 'Type in a recipe' }),
    ).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Title'), 'Grandma’s stew')
    await userEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    expect(a.saveManual).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Grandma’s stew' }),
      undefined,
    )
    expect(window.location.pathname).toBe('/recipe/new-id')
    expect(onClose).toHaveBeenCalled()
  })

  it('says so where the browser can’t take dictation', async () => {
    render(<AddRecipeSheet api={api()} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /Say it/ }))
    expect(screen.getByText(/can't take dictation/)).toBeInTheDocument()
  })

  it('listens, shows what it heard, and turns it into a draft', async () => {
    let rec: Recognition | null = null
    class FakeRecognition {
      continuous = false
      interimResults = false
      lang = ''
      onresult: Recognition['onresult'] = null
      onerror: Recognition['onerror'] = null
      onend: Recognition['onend'] = null
      start() {
        rec = this as unknown as Recognition
      }
      stop() {
        this.onend?.()
      }
    }
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      value: FakeRecognition,
      configurable: true,
    })
    render(<AddRecipeSheet api={api()} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /Say it/ }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Start listening' }),
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Listening… tap to stop',
    )
    act(() =>
      rec!.onresult?.({
        resultIndex: 0,
        results: [
          {
            isFinal: true,
            0: {
              transcript:
                'Lentil soup. Ingredients one cup lentils, two carrots. Steps simmer the lentils then add the carrots.',
            },
          },
        ],
      }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Stop listening' }),
    )
    expect(screen.getByRole('status')).toHaveTextContent('Got it.')
    await userEvent.click(
      screen.getByRole('button', { name: 'Turn this into a recipe' }),
    )
    expect(screen.getByLabelText('Title')).toHaveValue('Lentil soup')
    expect(screen.getByLabelText('Ingredients')).toHaveValue(
      'One cup lentils\nTwo carrots',
    )
    expect(
      screen.getByText(/Written up from what you said/),
    ).toBeInTheDocument()
  })
})

describe('draftFromSpeech', () => {
  it('splits the title, ingredients and steps at the words people say', () => {
    expect(
      draftFromSpeech(
        'Grandma’s stew. Ingredients 2 pounds beef, an onion and 3 carrots. Method brown the beef. Then add the rest and simmer 2 hours.',
      ),
    ).toMatchObject({
      title: 'Grandma’s stew',
      ingredients: ['2 pounds beef', 'An onion', '3 carrots'],
      instructions: ['Brown the beef.', 'Add the rest and simmer 2 hours.'],
      unsure: [],
    })
  })

  it('asks for the markers when it can’t place things', () => {
    const d = draftFromSpeech('Toast. Toast the bread and butter it.')
    expect(d.title).toBe('Toast')
    expect(d.instructions).toEqual(['Toast the bread and butter it.'])
    expect(d.unsure).toHaveLength(1)
  })
})

describe('the drawers (TYL-149)', () => {
  it('shows the open drawer’s lip as current, and closes it on a second tap', async () => {
    window.history.replaceState(null, '', '/list')
    render(<Lips open="list" toBuy={15} onAdd={vi.fn()} />)
    const list = screen.getByRole('link', { name: 'List · 15' })
    expect(list).toHaveAttribute('aria-current', 'page')
    await userEvent.click(list)
    expect(window.location.pathname).toBe('/')
    await userEvent.click(screen.getByRole('link', { name: 'Pantry' }))
    expect(window.location.pathname).toBe('/pantry')
  })

  it('goes back to the week from the strip', async () => {
    window.history.replaceState(null, '', '/recipes')
    render(
      <DrawerPanel>
        <p>Recipes</p>
      </DrawerPanel>,
    )
    await userEvent.click(screen.getByRole('button', { name: /This week/ }))
    expect(window.location.pathname).toBe('/')
  })
})

describe('toast', () => {
  it('shows a message for a moment', () => {
    vi.useFakeTimers()
    render(<Toaster />)
    act(() => showToast('Saved to your recipes.'))
    expect(screen.getByRole('status')).toHaveTextContent(
      'Saved to your recipes.',
    )
    act(() => vi.advanceTimersByTime(TOAST_MS))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
