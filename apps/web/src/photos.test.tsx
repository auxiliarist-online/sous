import type { Session } from '@supabase/supabase-js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PhotoReader } from './PhotoReader.tsx'
import { RecipeForm } from './RecipeForm.tsx'
import { readPhotos, type PhotoDraft } from './sous.ts'

// jsdom can't draw images: the form's own shrinking is stood in for.
vi.mock('./photos.ts', () => ({ shrinkPhoto: vi.fn(async () => 'b64') }))

const DRAFT: PhotoDraft = {
  title: 'Red Lentil Dal',
  servings: 4,
  totalMinutes: 45,
  ingredients: ['1 cup red lentils', 'For the tadka:', '1 tsp cumin seeds'],
  instructions: ['Rinse the lentils.', 'Simmer for 25 minutes.'],
  unsure: ['1 tsp cumin seeds'],
  skipped: ['My grandmother made this every Sunday.'],
}

const photo = (name: string) => new File(['x'], name, { type: 'image/jpeg' })

beforeEach(() => {
  URL.createObjectURL = vi.fn((f: Blob) => `blob:${(f as File).name}`)
  URL.revokeObjectURL = vi.fn()
})

describe('readPhotos', () => {
  it('sends the pages and reads the draft, adding prep and cook', async () => {
    const send = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            title: 'Dal',
            servings: 4,
            prep_minutes: 10,
            cook_minutes: 35,
            total_minutes: null,
            ingredients: ['1 cup lentils'],
            instructions: ['Simmer.'],
            unsure: [],
            skipped: [],
          }),
        ),
    )
    const d = await readPhotos({} as Session, ['aGk='], send)
    expect(send).toHaveBeenCalledWith({}, '/recipes/read-photos', {
      method: 'POST',
      body: JSON.stringify({ images: ['aGk='] }),
    })
    expect(d).toMatchObject({ title: 'Dal', servings: 4, totalMinutes: 45 })
  })

  it('passes on the limit message, and explains other failures', async () => {
    const reply = (status: number, body: unknown) =>
      vi.fn(async () => new Response(JSON.stringify(body), { status }))
    await expect(
      readPhotos(
        {} as Session,
        ['x'],
        reply(429, { detail: 'A lot of pages.' }),
      ),
    ).rejects.toThrow('A lot of pages.')
    await expect(
      readPhotos({} as Session, ['x'], reply(502, { detail: 'down' })),
    ).rejects.toThrow("We couldn't read the photos")
    await expect(
      readPhotos({} as Session, ['x'], reply(413, {})),
    ).rejects.toThrow('too large')
  })
})

describe('PhotoReader', () => {
  it('takes up to four pages, in an order the user sets, and reads them', async () => {
    const read = vi.fn(async (_images: string[]) => DRAFT)
    const onRead = vi.fn()
    const shrink = vi.fn(async (f: Blob) => `b64-${(f as File).name}`)
    render(<PhotoReader read={read} onRead={onRead} shrink={shrink} />)
    const choose = screen.getByLabelText('Choose photos')
    await userEvent.upload(choose, [photo('one.jpg'), photo('two.jpg')])
    const pages = screen.getByRole('list', { name: 'Pages' })
    expect(
      within(pages)
        .getAllByRole('img')
        .map((i) => i.getAttribute('alt')),
    ).toEqual(['Page 1', 'Page 2'])
    await userEvent.click(
      screen.getByRole('button', { name: 'Move page 2 up' }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Read these 2 pages' }),
    )
    await waitFor(() => expect(onRead).toHaveBeenCalledWith(DRAFT))
    expect(read).toHaveBeenCalledWith(['b64-two.jpg', 'b64-one.jpg'])
    expect(screen.queryByRole('list', { name: 'Pages' })).toBeNull()
  })

  it('stops at four pages, and removes a page', async () => {
    render(<PhotoReader read={vi.fn()} onRead={vi.fn()} shrink={vi.fn()} />)
    await userEvent.upload(screen.getByLabelText('Choose photos'), [
      photo('1.jpg'),
      photo('2.jpg'),
      photo('3.jpg'),
      photo('4.jpg'),
      photo('5.jpg'),
    ])
    expect(screen.getByRole('alert')).toHaveTextContent('up to 4 pages')
    expect(screen.queryByLabelText('Choose photos')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Remove page 4' }))
    expect(screen.getAllByRole('img')).toHaveLength(3)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:4.jpg')
  })

  it('says why it couldn’t read them', async () => {
    const read = vi.fn(async () => {
      throw new Error("We couldn't read the photos. Try again.")
    })
    render(
      <PhotoReader read={read} onRead={vi.fn()} shrink={async () => 'x'} />,
    )
    await userEvent.upload(
      screen.getByLabelText('Take a photo'),
      photo('p.jpg'),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Read this page' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't read the photos",
    )
  })
})

describe('RecipeForm from photos', () => {
  it('fills the form and lists what to check and what was left out', async () => {
    const api = {
      recipe: vi.fn(),
      saveManual: vi.fn(async () => 'new-id'),
      readPhotos: vi.fn(async () => DRAFT),
      sourceNotes: vi.fn(async () => []),
    }
    render(<RecipeForm api={api} />)
    await userEvent.upload(
      screen.getByLabelText('Choose photos'),
      photo('p.jpg'),
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Read this page' }),
    )
    expect(await screen.findByLabelText('Title')).toHaveValue('Red Lentil Dal')
    expect(screen.getByLabelText('Ingredients')).toHaveValue(
      '1 cup red lentils\nFor the tadka:\n1 tsp cumin seeds',
    )
    expect(screen.getByLabelText('Steps')).toHaveValue(
      'Rinse the lentils.\nSimmer for 25 minutes.',
    )
    expect(screen.getByLabelText('Serves')).toHaveValue(4)
    expect(
      within(screen.getByRole('list', { name: 'Worth a check' })).getByText(
        '1 tsp cumin seeds',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Left out (1)')).toBeInTheDocument()
  })

  it('isn’t offered when editing a recipe', async () => {
    const api = {
      recipe: vi.fn(async () => null),
      saveManual: vi.fn(),
      readPhotos: vi.fn(),
      sourceNotes: vi.fn(async () => []),
    }
    render(<RecipeForm api={api} recipeId="r" />)
    expect(screen.queryByText('Read from photos')).toBeNull()
  })
})
