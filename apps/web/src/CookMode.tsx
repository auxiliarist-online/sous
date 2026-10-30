import { useEffect, useState } from 'react'
import { CookedButton } from './Cooked.tsx'
import type { CookedApi } from './cooked.ts'
import {
  clock,
  startTimer,
  stepTimes,
  stopTimer,
  useNow,
  useTimers,
  useWakeLock,
} from './cookTimers.ts'
import { ExternalLink } from './ExternalLink.tsx'
import { sourceLabel } from './library.ts'
import { isoDate, SCALES, scaledLine, type Scale } from './plan.ts'
import { Link } from './router.tsx'
import { ingredientLines, type RecipeDetail } from './sous.ts'

export interface CookApi extends CookedApi {
  recipe(id: string): Promise<RecipeDetail | null>
}

/** Cook mode (TYL-75): big type, the screen kept on, the ingredients to
 *  check off at the planned size, and the steps one at a time with timers.
 *  Link-only recipes show the checklist and open the author's steps instead
 *  (policy: their steps are never copied). */
export function CookMode({
  api,
  id,
  scale: planned = 1,
  entryId = null,
  now,
}: {
  api: CookApi
  id: string
  scale?: Scale
  entryId?: string | null
  now?: Date
}) {
  const [recipe, setRecipe] = useState<RecipeDetail | null | undefined>()
  const [failed, setFailed] = useState(false)
  const [scale, setScale] = useState<Scale>(planned)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  // -1 is the ingredients; 0.. the steps; steps.length is the end.
  const [at, setAt] = useState(-1)
  // The day cooking started (tests pass one).
  const [today] = useState(() => isoDate(now ?? new Date()))
  const awake = useWakeLock()

  useEffect(() => {
    let live = true
    api.recipe(id).then(
      (r) => live && setRecipe(r),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [api, id])

  if (failed)
    return (
      <p className="card error" role="alert">
        We couldn't load this recipe.
      </p>
    )
  if (recipe === undefined) return <p className="card muted">Loading…</p>
  if (recipe === null)
    return (
      <section className="card">
        <h2>Recipe not found</h2>
        <Link to="/recipes">Back to your recipes</Link>
      </section>
    )

  const lines = ingredientLines(recipe.ingredients)
  const steps = recipe.instructions ?? []
  const toggle = (n: number) => {
    const next = new Set(checked)
    if (next.has(n)) next.delete(n)
    else next.add(n)
    setChecked(next)
  }

  return (
    <section className="cook-mode" aria-label={`Cooking ${recipe.title}`}>
      <header className="cook-head">
        <h2>{recipe.title}</h2>
        <p className="small muted">
          {awake ? 'The screen stays on while you cook.' : ''}{' '}
          <Link to={`/recipe/${recipe.id}`}>Leave cook mode</Link>
        </p>
      </header>

      {at === -1 && (
        <>
          <div className="chips" role="group" aria-label="Size">
            {SCALES.map(([s, label]) => (
              <button
                key={s}
                type="button"
                className="chip"
                aria-pressed={scale === s}
                onClick={() => setScale(s)}
              >
                {label}
              </button>
            ))}
          </div>
          <h3>Ingredients</h3>
          <ul className="cook-ingredients">
            {lines.map((line) => (
              <li key={line.lineNo}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked.has(line.lineNo)}
                    onChange={() => toggle(line.lineNo)}
                  />
                  <span>{scaledLine(line, scale)}</span>
                </label>
              </li>
            ))}
          </ul>
          {steps.length > 0 ? (
            <button
              type="button"
              className="cook-next"
              onClick={() => setAt(0)}
            >
              Start the steps
            </button>
          ) : recipe.sourceUrl ? (
            // The author's steps stay on their page (policy).
            <ExternalLink className="button cook-next" href={recipe.sourceUrl}>
              Open the steps on{' '}
              {sourceLabel(recipe.sourceName, recipe.sourceUrl)}
            </ExternalLink>
          ) : null}
          {steps.length === 0 && (
            <Finish
              api={api}
              recipe={recipe}
              entryId={entryId}
              scale={scale}
              today={today}
            />
          )}
        </>
      )}

      {at >= 0 && at < steps.length && (
        <Step
          text={steps[at]}
          n={at + 1}
          of={steps.length}
          onBack={() => setAt(at - 1)}
          onNext={() => setAt(at + 1)}
        />
      )}

      {steps.length > 0 && at === steps.length && (
        <>
          <p className="cook-step">That's the last step.</p>
          <button
            type="button"
            className="secondary"
            onClick={() => setAt(steps.length - 1)}
          >
            Back
          </button>
          <Finish
            api={api}
            recipe={recipe}
            entryId={entryId}
            scale={scale}
            today={today}
          />
        </>
      )}
    </section>
  )
}

/** One step in big type, with a timer button for each time in it. */
function Step({
  text,
  n,
  of,
  onBack,
  onNext,
}: {
  text: string
  n: number
  of: number
  onBack: () => void
  onNext: () => void
}) {
  return (
    <>
      <p className="small muted">
        Step {n} of {of}
      </p>
      <p className="cook-step">{text}</p>
      {stepTimes(text).map((t, i) => (
        <button
          key={i}
          type="button"
          className="chip cook-timer-start"
          onClick={() => startTimer(`Step ${n}: ${t.text}`, t.seconds)}
        >
          Start a {clock(t.seconds)} timer
        </button>
      ))}
      <div className="cook-nav">
        <button type="button" className="secondary" onClick={onBack}>
          {n === 1 ? 'Ingredients' : 'Back'}
        </button>
        <button type="button" onClick={onNext}>
          {n === of ? 'Done' : 'Next'}
        </button>
      </div>
    </>
  )
}

/** The end of cooking: mark it cooked (TYL-68). */
function Finish({
  api,
  recipe,
  entryId,
  scale,
  today,
}: {
  api: CookApi
  recipe: RecipeDetail
  entryId: string | null
  scale: Scale
  today: string
}) {
  return (
    <p className="cook-finish">
      <CookedButton
        api={api}
        recipeId={recipe.id}
        title={recipe.title}
        planEntryId={entryId}
        cookedOn={today}
        scale={scale}
      />
    </p>
  )
}

/** The running timers, on every page: a countdown each, and an alert when
 *  one ends (TYL-75). */
export function TimerBar() {
  const timers = useTimers()
  const now = useNow(timers.some((t) => !t.done))
  if (!timers.length) return null
  return (
    <aside className="timer-bar" aria-label="Timers">
      {timers.map((t) =>
        t.done ? (
          <p key={t.id} role="alert" className="timer done">
            ⏰ Time's up: {t.label}{' '}
            <button
              type="button"
              className="link"
              onClick={() => stopTimer(t.id)}
            >
              OK
            </button>
          </p>
        ) : (
          <p key={t.id} className="timer">
            {t.label} · <strong>{clock((t.endsAt - now) / 1000)}</strong>{' '}
            <button
              type="button"
              className="link"
              aria-label={`Stop ${t.label}`}
              onClick={() => stopTimer(t.id)}
            >
              Stop
            </button>
          </p>
        ),
      )}
    </aside>
  )
}
