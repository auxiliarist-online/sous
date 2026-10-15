import { useEffect, useRef, useState } from 'react'
import { shrinkPhoto } from './photos.ts'
import type { PhotoDraft } from './sous.ts'

const MAX_PAGES = 4

interface Page {
  id: number
  file: File
  /** For the thumbnail; revoked when the page goes. */
  url: string
}

/** "Read from photos" (TYL-52): take or choose up to four pages of one
 *  recipe, put them in order, and read them into the form below. */
export function PhotoReader({
  read,
  onRead,
  shrink = shrinkPhoto,
}: {
  read: (images: string[]) => Promise<PhotoDraft>
  onRead: (draft: PhotoDraft) => void
  /** Turns a photo into base64 JPEG to send; tests pass their own. */
  shrink?: (file: Blob) => Promise<string>
}) {
  const [pages, setPages] = useState<Page[]>([])
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [next, setNext] = useState(1)

  // Free the thumbnails' memory when leaving (pages removed earlier are
  // freed as they go).
  const current = useRef<Page[]>([])
  useEffect(() => {
    current.current = pages
  }, [pages])
  useEffect(
    () => () => current.current.forEach((p) => URL.revokeObjectURL(p.url)),
    [],
  )

  // Add chosen or taken photos after the pages already there.
  function add(files: FileList | null) {
    if (!files?.length) return
    const room = MAX_PAGES - pages.length
    const added = Array.from(files)
      .slice(0, room)
      .map((file, i) => ({
        id: next + i,
        file,
        url: URL.createObjectURL(file),
      }))
    setNext(next + added.length)
    setPages([...pages, ...added])
    setError(
      files.length > room ? `One recipe takes up to ${MAX_PAGES} pages.` : null,
    )
  }

  // Take a page out.
  function remove(id: number) {
    const gone = pages.find((p) => p.id === id)
    if (gone) URL.revokeObjectURL(gone.url)
    setPages(pages.filter((p) => p.id !== id))
  }

  // Swap a page with the one before it.
  function moveUp(index: number) {
    if (index === 0) return
    const order = [...pages]
    ;[order[index - 1], order[index]] = [order[index], order[index - 1]]
    setPages(order)
  }

  // Read the pages, in order, into a draft for the form.
  async function submit() {
    setReading(true)
    setError(null)
    try {
      const images = await Promise.all(pages.map((p) => shrink(p.file)))
      onRead(await read(images))
      pages.forEach((p) => URL.revokeObjectURL(p.url))
      setPages([])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setReading(false)
    }
  }

  return (
    <section className="photo-reader" aria-labelledby="photo-reader-title">
      <h3 id="photo-reader-title">Read from photos</h3>
      <p className="muted small">
        Photograph a recipe in a cookbook, one page or a few. Sous reads it into
        the form below for you to check. The photos aren't kept.
      </p>
      {pages.length > 0 && (
        <ol className="photo-pages" aria-label="Pages">
          {pages.map((p, i) => (
            <li key={p.id}>
              <img src={p.url} alt={`Page ${i + 1}`} />
              <span className="small">Page {i + 1}</span>
              {i > 0 && (
                <button
                  type="button"
                  className="link small"
                  aria-label={`Move page ${i + 1} up`}
                  onClick={() => moveUp(i)}
                >
                  ↑
                </button>
              )}
              <button
                type="button"
                className="link small"
                aria-label={`Remove page ${i + 1}`}
                onClick={() => remove(p.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
      {pages.length < MAX_PAGES && (
        <div className="photo-pick">
          <label className="button secondary">
            {pages.length ? 'Add a page' : 'Take a photo'}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="visually-hidden"
              onChange={(e) => {
                add(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
          <label className="button secondary">
            Choose photos
            <input
              type="file"
              accept="image/*"
              multiple
              className="visually-hidden"
              onChange={(e) => {
                add(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
        </div>
      )}
      {pages.length > 0 && (
        <button type="button" disabled={reading} onClick={() => void submit()}>
          {reading
            ? 'Reading…'
            : `Read ${pages.length === 1 ? 'this page' : `these ${pages.length} pages`}`}
        </button>
      )}
      {error && (
        <p role="alert" className="error small">
          {error}
        </p>
      )}
    </section>
  )
}
