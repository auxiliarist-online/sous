import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { ImportError, firstUrl, importRecipe, savedRecipes } from './library.ts'

const session = { access_token: 'tok' } as Session

function reply(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

describe('firstUrl', () => {
  it('finds a link in shared text and trims trailing punctuation', () => {
    expect(firstUrl(null, 'Try this: https://blog.example/dal/?x=1.')).toBe(
      'https://blog.example/dal/?x=1',
    )
  })

  it('prefers the first part that has a link', () => {
    expect(firstUrl('https://a.example/', 'https://b.example/')).toBe(
      'https://a.example/',
    )
    expect(firstUrl('', 'no link here', undefined)).toBeNull()
  })
})

describe('importRecipe', () => {
  it('posts the URL with the user token and returns the result', async () => {
    const result = { recipe_id: 'r1', title: 'Dal' }
    const send = reply(200, result)
    expect(
      await importRecipe(session, 'https://blog.example/dal/', send),
    ).toEqual(result)
    expect(send).toHaveBeenCalledWith(session, '/recipes/import', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://blog.example/dal/' }),
    })
  })

  it("passes on the API's own message and code", async () => {
    const send = reply(422, {
      detail: {
        code: 'blocked',
        message: 'This site blocks automated imports.',
      },
    })
    await expect(
      importRecipe(session, 'https://x.example/', send),
    ).rejects.toMatchObject({
      code: 'blocked',
      message: 'This site blocks automated imports.',
    })
  })

  it('explains an expired session, a server error and no connection', async () => {
    await expect(
      importRecipe(session, 'u', reply(401, {})),
    ).rejects.toMatchObject({
      code: 'signed_out',
    })
    await expect(
      importRecipe(session, 'u', reply(500, 'oops')),
    ).rejects.toMatchObject({
      code: 'error',
    })
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(importRecipe(session, 'u', offline)).rejects.toBeInstanceOf(
      ImportError,
    )
  })
})

describe('savedRecipes', () => {
  it('maps saved rows to recipes, newest first as the query asks', async () => {
    const rows = [
      {
        created_at: '2026-10-09T10:00:00Z',
        recipe: {
          id: 'r1',
          title: 'Dal',
          source_url: 'https://blog.example/dal/',
          total_minutes: 30,
          source: { name: 'Example Blog' },
        },
      },
      { created_at: '2026-10-08T10:00:00Z', recipe: null },
    ]
    const order = vi.fn(async () => ({ data: rows, error: null }))
    const select = vi.fn(() => ({ order }))
    const db = { from: vi.fn(() => ({ select })) } as unknown as SupabaseClient
    expect(await savedRecipes(db)).toEqual([
      {
        id: 'r1',
        title: 'Dal',
        sourceUrl: 'https://blog.example/dal/',
        sourceName: 'Example Blog',
        totalMinutes: 30,
        savedAt: '2026-10-09T10:00:00Z',
      },
    ])
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false })
  })
})
