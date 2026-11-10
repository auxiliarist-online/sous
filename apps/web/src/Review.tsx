import { useEffect, useState } from 'react'
import type { PantryEntry, PantryKind } from './pantry.ts'
import {
  amountText,
  dollars,
  scaledLine,
  type PantryStatus,
  type PlanCost,
  type PlanEntry,
  type Scale,
} from './plan.ts'
import { navigate } from './navigation.ts'
import { Sheet } from './Shell.tsx'
import { ingredientLines, type RecipeDetail } from './sous.ts'
import { showToast } from './toast.ts'

export interface ReviewApi {
  recipe(id: string): Promise<RecipeDetail | null>
  /** The whole week's buy list and prices, for each item's price. */
  planCost(weekStart: string): Promise<PlanCost>
  /** What's on the list now (reviewed entries only), for its total. */
  listCost(weekStart: string): Promise<PlanCost>
  pantry(): Promise<PantryEntry[]>
  setPantry(
    ingredientId: string,
    status: PantryStatus | null,
    kind?: PantryKind,
  ): Promise<void>
  updateEntry(
    id: string,
    patch: { scale?: Scale; day?: string | null; reviewed?: boolean },
  ): Promise<void>
}

/** "Not on the list yet": plan entries waiting for review, with Review. */
export function PendingNotice({
  entries,
  onReview,
  long = false,
}: {
  entries: PlanEntry[]
  onReview: () => void
  /** The plan page's wording: "1 recipe is not on the list yet." */
  long?: boolean
}) {
  if (!entries.length) return null
  const n = entries.length
  return (
    <div className="pending" role="status">
      {long ? (
        <p>
          <strong>
            {n === 1 ? '1 recipe is' : `${n} recipes are`} not on the list yet.
          </strong>{' '}
          Check what you already have before {n === 1 ? "it's" : "they're"}{' '}
          added.
        </p>
      ) : (
        <p>
          <strong>Not on the list yet:</strong>{' '}
          {entries.map((e) => e.title).join('; ')}. Check what you already have.
        </p>
      )}
      <button type="button" onClick={onReview}>
        Review
      </button>
    </div>
  )
}

interface Row {
  key: string
  ingredientId: string
  name: string
  amount: string | null
}

interface Group {
  entry: PlanEntry
  rows: Row[]
}

/** "What do you already have?" (TYL-150): each new recipe's ingredients,
 *  ticked "Have it" when the pantry has them. Confirming records the
 *  answers in the pantry (a one-off on hand, or a staple out) and marks the
 *  recipes reviewed, so what's needed goes on the list. */
export function ReviewSheet({
  api,
  week,
  entries,
  onClose,
  onDone,
}: {
  api: ReviewApi
  week: string
  entries: PlanEntry[]
  onClose: () => void
  /** After confirming; the default goes to the list. */
  onDone?: () => void
}) {
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [pantry, setPantry] = useState<Map<string, PantryEntry>>(new Map())
  const [prices, setPrices] = useState<Map<string, number>>(new Map())
  const [listTotal, setListTotal] = useState<{
    cents: number
    budget: number | null
    onList: Set<string>
  } | null>(null)
  // The user's answers, by ingredient: true is "Have it".
  const [have, setHave] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    Promise.all([
      Promise.all(entries.map((e) => api.recipe(e.recipeId))),
      api.pantry().catch(() => [] as PantryEntry[]),
    ]).then(
      ([recipes, kept]) => {
        if (!live) return
        const byId = new Map(kept.map((p) => [p.ingredientId, p] as const))
        setPantry(byId)
        const out: Group[] = []
        const answers: Record<string, boolean> = {}
        entries.forEach((entry, n) => {
          const r = recipes[n]
          if (!r) return
          const rows = ingredientLines(r.ingredients)
            .filter((l) => l.ingredientId && !l.isOptional)
            .map((l) => {
              const id = l.ingredientId!
              // Ticked when the pantry has it (a staple not marked out, or
              // a one-off on hand).
              answers[id] ??= byId.get(id)?.status === 'have'
              return {
                key: `${entry.id}-${l.lineNo}`,
                ingredientId: id,
                name: capitalize(l.name ?? l.rawText),
                amount:
                  l.quantity != null
                    ? amountText(l.quantity * entry.scale, l.unit ?? '')
                    : scaledLine(l, entry.scale) === l.rawText
                      ? null
                      : scaledLine(l, entry.scale),
              }
            })
          out.push({ entry, rows })
        })
        setHave(answers)
        setGroups(out)
      },
      () => live && setFailed(true),
    )
    // Prices and the list's total: the sheet works without them.
    api.planCost(week).then(
      (c) =>
        live &&
        setPrices(
          new Map(
            c.items.flatMap((i) =>
              i.ingredientId && i.cents != null
                ? [[i.ingredientId, i.cents] as const]
                : [],
            ),
          ),
        ),
      () => {},
    )
    api.listCost(week).then(
      (c) =>
        live &&
        setListTotal({
          cents: c.totalCents,
          budget: c.budgetCents,
          onList: new Set(
            c.items.flatMap((i) =>
              i.buy && i.ingredientId ? [i.ingredientId] : [],
            ),
          ),
        }),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api, week, entries])

  const needed = [
    ...new Set(
      (groups ?? []).flatMap((g) =>
        g.rows.filter((r) => !have[r.ingredientId]).map((r) => r.ingredientId),
      ),
    ),
  ]
  // What the list grows by: the needed things it doesn't have yet.
  const adds = needed
    .filter((id) => !listTotal?.onList.has(id))
    .reduce((sum, id) => sum + (prices.get(id) ?? 0), 0)

  // Save the answers in the pantry, then mark the recipes reviewed.
  async function confirm() {
    setBusy(true)
    setFailed(false)
    try {
      const ids = new Set(
        (groups ?? []).flatMap((g) => g.rows.map((r) => r.ingredientId)),
      )
      for (const id of ids) {
        const kept = pantry.get(id)
        const hasIt = kept?.status === 'have'
        if (have[id] && !hasIt)
          await api.setPantry(id, 'have', kept?.kind ?? 'on_hand')
        else if (!have[id] && hasIt)
          // A staple runs out (and goes on the list); a one-off is used up.
          await api.setPantry(
            id,
            kept.kind === 'staple' ? 'out' : null,
            kept.kind,
          )
      }
      for (const e of entries) await api.updateEntry(e.id, { reviewed: true })
      showToast(
        needed.length
          ? `${needed.length} item${needed.length === 1 ? '' : 's'} added to your list.`
          : 'Nothing to buy for these.',
      )
      if (onDone) onDone()
      else navigate('/list')
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  const n = needed.length
  return (
    <Sheet
      title="What do you already have?"
      onClose={onClose}
      foot={
        <>
          {listTotal && (
            <p className="review-total">
              <span className="muted">List after this</span>
              <span>
                <strong>~{dollars(listTotal.cents + adds)}</strong>
                {listTotal.budget !== null && (
                  <span className="muted"> of {dollars(listTotal.budget)}</span>
                )}
              </span>
            </p>
          )}
          <button
            type="button"
            className="review-confirm"
            disabled={busy || groups === null}
            onClick={() => void confirm()}
          >
            {busy
              ? 'Adding…'
              : n
                ? `Add ${n} to the list${adds ? ` · +${dollars(adds)}` : ''}`
                : 'Nothing to buy · done'}
          </button>
          {failed && (
            <p className="error small" role="alert">
              We couldn't save that. Try again.
            </p>
          )}
        </>
      }
    >
      <p className="small muted">
        Pantry items are ticked for you. Tap anything to change it; only what
        you need goes on the list.
      </p>
      {groups === null && !failed && <p className="muted">Loading…</p>}
      {(groups ?? []).map((g) => (
        <section key={g.entry.id} aria-label={g.entry.title}>
          <h3 className="kicker">{g.entry.title}</h3>
          <ul className="review-rows">
            {g.rows.map((r) => {
              const hasIt = !!have[r.ingredientId]
              const price = prices.get(r.ingredientId)
              return (
                <li
                  key={r.key}
                  className={hasIt ? 'review-row have' : 'review-row'}
                >
                  <span className="review-name">
                    <strong>{r.name}</strong>
                    {r.amount && (
                      <span className="small muted"> · {r.amount}</span>
                    )}
                  </span>
                  {!hasIt && price != null && (
                    <span className="small">{dollars(price)}</span>
                  )}
                  <button
                    type="button"
                    className={hasIt ? 'state have' : 'state need'}
                    aria-pressed={hasIt}
                    aria-label={`${r.name}: ${hasIt ? 'have it' : 'need it'}`}
                    onClick={() =>
                      setHave((h) => ({ ...h, [r.ingredientId]: !hasIt }))
                    }
                  >
                    {hasIt ? 'Have it' : 'Need it'}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </Sheet>
  )
}

/** "white beans" -> "White beans". */
function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}
