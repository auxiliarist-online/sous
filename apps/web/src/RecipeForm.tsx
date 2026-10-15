import { useEffect, useState, type FormEvent } from 'react'
import { navigate } from './navigation.ts'
import { Link } from './router.tsx'
import { PhotoReader } from './PhotoReader.tsx'
import {
  manualInput,
  type ManualRecipeInput,
  type PhotoDraft,
  type RecipeDetail,
} from './sous.ts'

export interface RecipeFormApi {
  recipe(id: string): Promise<RecipeDetail | null>
  saveManual(input: ManualRecipeInput, recipeId?: string): Promise<string>
  /** Read photos of a cookbook's pages into a draft (TYL-52). */
  readPhotos(images: string[]): Promise<PhotoDraft>
}

const EMPTY: ManualRecipeInput = {
  title: '',
  ingredients: '',
  instructions: '',
  servings: null,
  totalMinutes: null,
  sourceNote: '',
}

function numberOrNull(value: string): number | null {
  const n = Number(value)
  return value.trim() && Number.isFinite(n) && n > 0 ? n : null
}

/** Type in a recipe of your own, or edit one. It stays private to you, and
 *  its ingredients are parsed and labelled like any other recipe. */
export function RecipeForm({
  api,
  recipeId,
}: {
  api: RecipeFormApi
  recipeId?: string
}) {
  const [input, setInput] = useState<ManualRecipeInput | null>(
    recipeId ? null : EMPTY,
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // After reading photos: what to check, and what was left out.
  const [review, setReview] = useState<PhotoDraft | null>(null)

  useEffect(() => {
    if (!recipeId) return
    let live = true
    api.recipe(recipeId).then(
      (r) => {
        if (!live) return
        if (r?.handTyped) setInput(manualInput(r))
        else setError("This recipe can't be edited here.")
      },
      () => live && setError("We couldn't load this recipe."),
    )
    return () => {
      live = false
    }
  }, [api, recipeId])

  if (!input) {
    return error ? (
      <p className="card error" role="alert">
        {error}
      </p>
    ) : (
      <p className="card muted">Loading…</p>
    )
  }

  const set = (patch: Partial<ManualRecipeInput>) =>
    setInput({ ...input, ...patch })

  // Fill the form from photos; anything already typed is replaced.
  function fromPhotos(d: PhotoDraft) {
    setInput({
      title: d.title,
      ingredients: d.ingredients.join('\n'),
      instructions: d.instructions.join('\n'),
      servings: d.servings,
      totalMinutes: d.totalMinutes,
      sourceNote: input?.sourceNote ?? '',
    })
    setReview(d)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!input?.title.trim()) return
    setSaving(true)
    setError(null)
    try {
      const id = await api.saveManual(input, recipeId)
      navigate(`/recipe/${id}`, true)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <form className="card recipe-form" onSubmit={submit}>
      <Link to={recipeId ? `/recipe/${recipeId}` : '/'} className="small">
        ← {recipeId ? 'Back to the recipe' : 'Your recipes'}
      </Link>
      <h2>{recipeId ? 'Edit your recipe' : 'Type in a recipe'}</h2>
      <p className="muted small">Only you can see recipes you type in.</p>

      {!recipeId && <PhotoReader read={api.readPhotos} onRead={fromPhotos} />}
      {review && (
        <section className="photo-review" role="status">
          <p className="small">
            Read from your photos. Check it over before saving, and add the
            book's name under “Where it's from”.
          </p>
          {review.unsure.length > 0 && (
            <>
              <p className="small">Worth a check:</p>
              <ul className="small" aria-label="Worth a check">
                {review.unsure.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </>
          )}
          {review.skipped.length > 0 && (
            <details className="small">
              <summary>Left out ({review.skipped.length})</summary>
              <ul aria-label="Left out">
                {review.skipped.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      <label htmlFor="title">Title</label>
      <input
        id="title"
        required
        maxLength={200}
        value={input.title}
        onChange={(e) => set({ title: e.target.value })}
      />

      <label htmlFor="ingredients">Ingredients</label>
      <p className="muted small" id="ingredients-help">
        One per line, like “2 cups rice”. A line ending in a colon starts a
        section (“For the sauce:”).
      </p>
      <textarea
        id="ingredients"
        aria-describedby="ingredients-help"
        rows={8}
        value={input.ingredients}
        onChange={(e) => set({ ingredients: e.target.value })}
      />

      <label htmlFor="instructions">Steps</label>
      <p className="muted small" id="steps-help">
        One step per line.
      </p>
      <textarea
        id="instructions"
        aria-describedby="steps-help"
        rows={8}
        value={input.instructions}
        onChange={(e) => set({ instructions: e.target.value })}
      />

      <div className="row">
        <div>
          <label htmlFor="servings">Serves</label>
          <input
            id="servings"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={input.servings ?? ''}
            onChange={(e) => set({ servings: numberOrNull(e.target.value) })}
          />
        </div>
        <div>
          <label htmlFor="minutes">Total time (min)</label>
          <input
            id="minutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={10000}
            value={input.totalMinutes ?? ''}
            onChange={(e) =>
              set({ totalMinutes: numberOrNull(e.target.value) })
            }
          />
        </div>
      </div>

      <label htmlFor="source-note">Where it's from (optional)</label>
      <input
        id="source-note"
        maxLength={300}
        placeholder="Grandma, or a cookbook and page"
        value={input.sourceNote}
        onChange={(e) => set({ sourceNote: e.target.value })}
      />

      <button type="submit" disabled={saving || !input.title.trim()}>
        {saving ? 'Saving…' : 'Save recipe'}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  )
}
