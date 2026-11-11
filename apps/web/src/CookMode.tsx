import { useEffect, useRef, useState } from 'react'
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
import { SwapSheet } from './SwapSheet.tsx'
import { swapText, type Swap } from './swaps.ts'
import type { IngredientLine } from './sous.ts'
import type { PantryEntry } from './pantry.ts'

export interface CookApi extends CookedApi {
  recipe(id: string): Promise<RecipeDetail | null>
  /** Swaps (TYL-77): the user's for the recipe show in the checklist, and
   *  "Out of it?" offers the rest. */
  swapsFor?(ingredientIds: string[]): Promise<Swap[]>
  /** The swaps the user chose for the recipe, by the ingredient swapped
   *  out. */
  recipeSwaps?(recipeId: string): Promise<Record<string, string>>
  /** Save a swap for an ingredient in the recipe; null goes back to the
   *  recipe's own. */
  setRecipeSwap?(
    recipeId: string,
    fromId: string,
    swapId: string | null,
  ): Promise<void>
  /** The pantry, for which swaps the user has on hand. */
  pantry?(): Promise<PantryEntry[]>
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
  // Swaps (TYL-77): those for the recipe's ingredients, the user's choices
  // by the ingredient swapped out, what's on hand, and the line whose swaps
  // are open.
  const [swaps, setSwaps] = useState<Swap[]>([])
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [have, setHave] = useState<Set<string> | null>(null)
  const [outOf, setOutOf] = useState<IngredientLine | null>(null)
  // Swaps chosen here that couldn't be saved: they stay on this screen, and
  // can be sent again.
  const [unsaved, setUnsaved] = useState<Record<string, string | null>>({})
  // Swaps chosen here, so loading the saved ones doesn't undo them.
  const touched = useRef(new Set<string>())
  // Saves on their way, by ingredient: each waits for the one before.
  const writes = useRef(new Map<string, Promise<void>>())

  useEffect(() => {
    let live = true
    api.recipe(id).then(
      (r) => live && setRecipe(r),
      () => live && setFailed(true),
    )
    // Swaps are extra: without them the recipe's own lines show.
    if (api.recipeSwaps)
      api.recipeSwaps(id).then(
        (saved) => {
          if (!live) return
          setChosen((now) => {
            const next = { ...saved }
            for (const from of touched.current)
              if (now[from]) next[from] = now[from]
              else delete next[from]
            return next
          })
        },
        () => {},
      )
    // What's on hand, for ranking swaps: the pantry where it can be read.
    const stocked = api.pantry
      ? api
          .pantry()
          .then((p) =>
            p.filter((e) => e.status === 'have').map((e) => e.ingredientId),
          )
      : api.onHandIn(id).then((items) => items.map((i) => i.ingredientId))
    stocked.then(
      (ids) => live && setHave(new Set(ids)),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api, id])

  // The recipe's ingredients, for their swaps.
  const ingredientKey = (recipe?.ingredients ?? [])
    .flatMap((l) => (l.ingredientId ? [l.ingredientId] : []))
    .join(',')
  useEffect(() => {
    let live = true
    if (ingredientKey && api.swapsFor)
      api.swapsFor([...new Set(ingredientKey.split(','))]).then(
        (s) => live && setSwaps(s),
        () => {},
      )
    return () => {
      live = false
    }
  }, [api, ingredientKey])

  // Swap a line's ingredient (or go back) on this screen, and save it for
  // next time; if that fails, say so and keep it here to send again.
  function chooseSwap(fromId: string, swapId: string | null) {
    touched.current.add(fromId)
    setChosen((c) => {
      const next = { ...c }
      if (swapId) next[fromId] = swapId
      else delete next[fromId]
      return next
    })
    setOutOf(null)
    save(fromId, swapId)
  }

  // Send one swap, noting it as unsaved until it goes through.
  function save(fromId: string, swapId: string | null) {
    const send = api.setRecipeSwap
    if (!send) return
    const write = (writes.current.get(fromId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => send(id, fromId, swapId))
    writes.current.set(fromId, write)
    write.then(
      () =>
        setUnsaved((u) => {
          if (!(fromId in u) || u[fromId] !== swapId) return u
          const next = { ...u }
          delete next[fromId]
          return next
        }),
      () => setUnsaved((u) => ({ ...u, [fromId]: swapId })),
    )
  }
  const swapFor = (fromId: string | null | undefined) =>
    fromId ? swaps.find((s) => s.id === chosen[fromId]) : undefined

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
  // Check or uncheck one ingredient line.
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

      {/* Swaps that couldn't be saved, on every screen of cook mode. */}
      {Object.keys(unsaved).length > 0 && (
        <p role="alert" className="error small">
          We couldn't save{' '}
          {Object.keys(unsaved).length === 1
            ? 'a swap'
            : `${Object.keys(unsaved).length} swaps`}
          : they're only in cook mode for now.{' '}
          <button
            type="button"
            className="link"
            onClick={() =>
              Object.entries(unsaved).forEach(([from, swap]) =>
                save(from, swap),
              )
            }
          >
            Try again
          </button>
        </p>
      )}

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
                  <span>
                    {swapFor(line.ingredientId) ? (
                      <>
                        <s>{scaledLine(line, scale)}</s> →{' '}
                        {swapText(
                          {
                            ...line,
                            quantity:
                              line.quantity != null
                                ? line.quantity * scale
                                : null,
                          },
                          swapFor(line.ingredientId)!,
                        )}
                      </>
                    ) : (
                      scaledLine(line, scale)
                    )}
                  </span>
                </label>
                {swaps.some((w) => w.fromId === line.ingredientId) && (
                  <button
                    type="button"
                    className="link small"
                    aria-label={`Out of ${line.name ?? line.rawText}?`}
                    onClick={() => setOutOf(line)}
                  >
                    {swapFor(line.ingredientId) ? 'Change' : 'Out of it?'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {outOf?.ingredientId && (
            <SwapSheet
              line={{
                ...outOf,
                quantity:
                  outOf.quantity != null ? outOf.quantity * scale : null,
              }}
              swaps={swaps.filter((w) => w.fromId === outOf.ingredientId)}
              chosen={chosen[outOf.ingredientId] ?? null}
              fixes={[]}
              have={have}
              onChoose={(swapId) => chooseSwap(outOf.ingredientId!, swapId)}
              onClose={() => setOutOf(null)}
            />
          )}
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
