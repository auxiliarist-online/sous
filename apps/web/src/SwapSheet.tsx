import { Sheet } from './Shell.tsx'
import type { IngredientLine } from './sous.ts'
import { swapText, type Swap } from './swaps.ts'

/** The swaps for one line (TYL-77): best first, with those that make the
 *  recipe fit the user's diets, and those they have, marked. Choosing one
 *  saves it for this recipe; "Keep the recipe's" goes back. */
export function SwapSheet({
  line,
  swaps,
  chosen,
  fixes,
  have,
  onChoose,
  onClose,
}: {
  line: IngredientLine
  swaps: Swap[]
  chosen: string | null
  fixes: string[]
  have: Set<string> | null
  onChoose: (swapId: string | null) => void
  onClose: () => void
}) {
  const rank = (s: Swap) =>
    (fixes.length && !fixes.includes(s.id) ? 4 : 0) +
    (have?.has(s.toId) ? 0 : 2) +
    (s.quality === 'good' ? 0 : 1)
  const sorted = [...swaps].sort((a, b) => rank(a) - rank(b))
  return (
    <Sheet title={`Swap ${line.name ?? 'this'}`} onClose={onClose}>
      <p className="small muted">{line.rawText}</p>
      <ul className="swap-options">
        {sorted.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className="swap-option"
              aria-pressed={chosen === s.id}
              onClick={() => onChoose(s.id)}
            >
              <span className="swap-name">{swapText(line, s)}</span>
              <span className="tags">
                {fixes.includes(s.id) && (
                  <span className="tag fit">Fits your diet</span>
                )}
                {have?.has(s.toId) && <span className="tag">You have it</span>}
                <span className="tag">
                  {s.quality === 'good' ? 'Works well' : 'In a pinch'}
                </span>
                {s.uses !== 'any' && <span className="tag">For {s.uses}</span>}
              </span>
              <span className="small muted">{s.note}</span>
            </button>
          </li>
        ))}
      </ul>
      {chosen && (
        <button
          type="button"
          className="secondary"
          onClick={() => onChoose(null)}
        >
          Keep the recipe’s
        </button>
      )}
    </Sheet>
  )
}
