import { useState } from 'react'
import { weekOf, type Fit, type Scale } from './plan.ts'

export interface QuickAddApi {
  addToPlan(
    weekStart: string,
    recipeId: string,
    scale?: Scale,
    day?: string | null,
  ): Promise<void>
  recipeFits(ids: string[]): Promise<Record<string, Fit>>
}

/** A button on a recipe in a list that adds it to this week's plan without
 *  opening it (TYL-119). Like the recipe page, a recipe that breaks the
 *  user's diets or allergies is a warning, not a block: it asks first. */
export function QuickAdd({
  api,
  recipeId,
  title,
}: {
  api: QuickAddApi
  recipeId: string
  title: string
}) {
  const [state, setState] = useState<'idle' | 'adding' | 'added' | 'error'>(
    'idle',
  )

  // Add it to this week at full size, after asking if it breaks the user's
  // diets or allergies.
  async function add() {
    setState('adding')
    try {
      // The plan works without the check; it only adds a warning.
      const fit = await api.recipeFits([recipeId]).then(
        (f) => f[recipeId],
        () => undefined,
      )
      if (
        fit === 'excluded' &&
        !confirm(
          `“${title}” doesn't fit your diets or allergies. Add it anyway?`,
        )
      ) {
        setState('idle')
        return
      }
      await api.addToPlan(weekOf(), recipeId, 1)
      setState('added')
    } catch {
      setState('error')
    }
  }

  if (state === 'added') {
    return (
      <span className="quick-add small" role="status">
        ✓ Planned
      </span>
    )
  }
  return (
    <button
      type="button"
      className={`quick-add secondary${state === 'error' ? ' failed' : ''}`}
      aria-label={
        state === 'error'
          ? `Couldn't add ${title}. Try again`
          : `Add ${title} to this week's plan`
      }
      disabled={state === 'adding'}
      onClick={() => void add()}
    >
      {state === 'adding' ? '…' : state === 'error' ? 'Retry' : '+ Plan'}
    </button>
  )
}
