import { useEffect, useState } from 'react'
import {
  kitItems,
  kitsFor,
  PANTRY_GROUPS,
  type Kit,
  type PantryEntry,
  type PantryGroup,
  type PantryItem,
  type PantryKind,
  type Suggestion,
} from './pantry.ts'
import { StarterKits } from './PantryKits.tsx'
import type { PantryStatus } from './plan.ts'
import { IngredientPicker } from './Settings.tsx'
import type { IngredientRef, Option } from './sous.ts'

export interface PantryApi {
  /** What's in the user's pantry: staples and what's on hand. */
  pantry(): Promise<PantryEntry[]>
  /** Every pantry-type ingredient, with its aisle group. */
  pantryCatalog(): Promise<PantryItem[]>
  pantryKits(): Promise<Kit[]>
  options(): Promise<{ diets: Option[]; cuisines: Option[] }>
  /** Mark an ingredient; null takes it out of the pantry, so it's bought. */
  setPantry(
    ingredientId: string,
    status: PantryStatus | null,
    kind?: PantryKind,
  ): Promise<void>
  /** Keep these as staples, all "have". */
  keepStaples(ingredientIds: string[]): Promise<void>
  searchIngredients(query: string): Promise<IngredientRef[]>
  pantrySuggestions(): Promise<Suggestion[]>
  dismissSuggestion(ingredientId: string): Promise<void>
}

/** The aisle group's heading, or "Other staples" for one outside them. */
function groupName(group: PantryGroup | null): string {
  return PANTRY_GROUPS.find(([g]) => g === group)?.[1] ?? 'Other staples'
}

/** The pantry (TYL-133 to TYL-136): staples the user always keeps, by aisle
 *  group with a search, each "out" when it runs low (which puts it on the
 *  list); what they have right now; starter kits when there are no staples
 *  yet; and suggestions from what they cook. */
export function PantryPage({
  api,
  prefs = { diets: [], favoriteCuisines: [] },
}: {
  api: PantryApi
  /** For the starter kits: their diets and favorite cuisines. */
  prefs?: { diets: string[]; favoriteCuisines: string[] }
}) {
  const [entries, setEntries] = useState<PantryEntry[] | null>(null)
  const [catalog, setCatalog] = useState<PantryItem[]>([])
  const [kits, setKits] = useState<Kit[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [failed, setFailed] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  // Ingredients being saved: their controls wait, so saves can't cross.
  const [saving, setSaving] = useState<string[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    let live = true
    Promise.all([api.pantry(), api.pantryCatalog()]).then(
      ([e, c]) => {
        if (!live) return
        setEntries(e)
        setCatalog(c)
      },
      () => live && setFailed(true),
    )
    // Extras: the page works without them.
    api.pantryKits().then(
      (k) => live && setKits(k),
      () => {},
    )
    api.options().then(
      (o) =>
        live &&
        setNames(
          Object.fromEntries(
            [...o.cuisines, ...o.diets].map((x) => [x.slug, x.name]),
          ),
        ),
      () => {},
    )
    api.pantrySuggestions().then(
      (s) => live && setSuggestions(s),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api])

  if (failed) {
    return (
      <p className="card error" role="alert">
        We couldn't load your pantry.
      </p>
    )
  }
  if (!entries) return <p className="card muted">Loading…</p>

  const byId = new Map(entries.map((e) => [e.ingredientId, e]))
  const staples = entries.filter((e) => e.kind === 'staple')
  const onHand = entries.filter((e) => e.kind === 'on_hand')

  // Save one ingredient's entry (null takes it out), shown at once and put
  // back if saving fails. Only that one: others may have saved meanwhile.
  async function save(
    item: { id: string; name: string; group: PantryGroup | null },
    next: { status: PantryStatus; kind: PantryKind } | null,
  ) {
    const before = byId.get(item.id)
    const replace = (entry: PantryEntry | undefined) =>
      setEntries((all) => [
        ...(all ?? []).filter((e) => e.ingredientId !== item.id),
        ...(entry ? [entry] : []),
      ])
    replace(
      next
        ? { ingredientId: item.id, name: item.name, group: item.group, ...next }
        : undefined,
    )
    setSaveFailed(false)
    setSaving((s) => [...s, item.id])
    try {
      await api.setPantry(item.id, next?.status ?? null, next?.kind)
    } catch {
      replace(before)
      setSaveFailed(true)
    } finally {
      setSaving((s) => s.filter((x) => x !== item.id))
    }
  }

  // Keep a suggestion as a staple, or turn it down; either way it goes.
  async function answer(s: Suggestion, keep: boolean) {
    setSuggestions((all) =>
      all.filter((x) => x.ingredientId !== s.ingredientId),
    )
    const item = catalog.find((i) => i.id === s.ingredientId)
    if (keep) {
      await save(
        { id: s.ingredientId, name: s.name, group: item?.group ?? null },
        { status: 'have', kind: 'staple' },
      )
    } else {
      await api.dismissSuggestion(s.ingredientId).catch(() => {})
    }
  }

  // The checklist: every pantry item and every staple kept, by group, those
  // matching the search.
  const q = query.trim().toLowerCase()
  const listed: { id: string; name: string; group: PantryGroup | null }[] = [
    ...catalog,
    ...staples
      .filter((s) => !catalog.some((i) => i.id === s.ingredientId))
      .map((s) => ({ id: s.ingredientId, name: s.name, group: s.group })),
  ].filter((i) => !q || i.name.toLowerCase().includes(q))
  const groups = [...PANTRY_GROUPS.map(([g]) => g), null].flatMap((g) => {
    const items = listed
      .filter((i) => (i.group ?? null) === g)
      .sort((a, b) => a.name.localeCompare(b.name))
    return items.length ? [{ group: g, items }] : []
  })

  return (
    <section className="card pantry">
      <h2>Pantry</h2>
      {saveFailed && (
        <p role="alert" className="error small">
          That didn't save. Try again.
        </p>
      )}
      <p className="muted small">
        Staples are what you always keep: they're left off your list until you
        mark one out. Anything else a recipe needs gets bought, unless you have
        some right now.
      </p>
      {suggestions.length > 0 && (
        <ul className="pantry-suggestions" aria-label="Suggestions">
          {suggestions.map((s) => (
            <li key={s.ingredientId}>
              <span>
                You've used {s.name} in {s.recipes} recipes. Keep it as a
                staple?
              </span>
              <button
                type="button"
                className="chip"
                onClick={() => void answer(s, true)}
              >
                Keep {s.name}
              </button>
              <button
                type="button"
                className="link small"
                onClick={() => void answer(s, false)}
              >
                No thanks
              </button>
            </li>
          ))}
        </ul>
      )}
      {staples.length === 0 && (
        <KitCard
          kits={kitItems(kitsFor(kits, prefs), catalog)}
          names={names}
          onKeep={async (ids) => {
            await api.keepStaples(ids)
            const keep = new Set(ids)
            setEntries((all) => [
              ...(all ?? []).filter((e) => !keep.has(e.ingredientId)),
              ...catalog
                .filter((i) => keep.has(i.id))
                .map((i) => ({
                  ingredientId: i.id,
                  name: i.name,
                  group: i.group,
                  status: 'have' as const,
                  kind: 'staple' as const,
                })),
            ])
          }}
        />
      )}
      <h3>Staples</h3>
      <label htmlFor="pantry-search" className="visually-hidden">
        Find a staple
      </label>
      <input
        id="pantry-search"
        type="search"
        placeholder="Find a staple"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {groups.length === 0 && (
        <p className="muted small">Nothing matches “{query.trim()}”.</p>
      )}
      {groups.map(({ group, items }) => {
        const kept = items.filter(
          (i) => byId.get(i.id)?.kind === 'staple',
        ).length
        return (
          <details
            key={group ?? 'other'}
            className="pantry-group"
            open={q !== '' || kept > 0}
          >
            <summary>
              {groupName(group)}{' '}
              <span className="muted small">
                {kept} of {items.length}
              </span>
            </summary>
            <ul aria-label={groupName(group)}>
              {items.map((i) => {
                const entry = byId.get(i.id)
                const keeps = entry?.kind === 'staple'
                const out = keeps && entry.status === 'out'
                const busy = saving.includes(i.id)
                return (
                  <li key={i.id} className="pantry-row">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={keeps}
                        disabled={busy}
                        onChange={() =>
                          void save(
                            i,
                            keeps ? null : { status: 'have', kind: 'staple' },
                          )
                        }
                      />
                      {i.name}
                    </label>
                    {keeps && (
                      <button
                        type="button"
                        className="chip"
                        aria-pressed={out}
                        aria-label={`Out of ${i.name}`}
                        disabled={busy}
                        onClick={() =>
                          void save(i, {
                            status: out ? 'have' : 'out',
                            kind: 'staple',
                          })
                        }
                      >
                        {out ? 'Out · on your list' : 'Out'}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </details>
        )
      })}
      <h3>Have right now</h3>
      <p className="muted small">
        One-offs, like half a bag of spinach: left off your list until they're
        used up.
      </p>
      <IngredientPicker
        id="pantry-on-hand"
        label="Have right now"
        chosen={onHand.map((e) => ({ id: e.ingredientId, name: e.name }))}
        search={api.searchIngredients}
        onChange={(next) => {
          for (const i of next)
            if (!byId.has(i.id) || byId.get(i.id)?.kind !== 'on_hand')
              void save(
                { ...i, group: null },
                { status: 'have', kind: 'on_hand' },
              )
          for (const e of onHand)
            if (!next.some((i) => i.id === e.ingredientId))
              void save(
                { id: e.ingredientId, name: e.name, group: e.group },
                null,
              )
        }}
      />
    </section>
  )
}

/** Starter kits on an empty pantry (TYL-135), pre-checked, with "Keep these". */
function KitCard({
  kits,
  names,
  onKeep,
}: {
  kits: { kit: string; items: PantryItem[] }[]
  names: Record<string, string>
  onKeep: (ids: string[]) => Promise<void>
}) {
  const all = kits.flatMap((k) => k.items.map((i) => i.id))
  const [checked, setChecked] = useState<string[] | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  if (kits.length === 0) return null
  const chosen = checked ?? all
  return (
    <div className="kit-card">
      <h3>Start with a kit</h3>
      <p className="muted small">
        What most kitchens like yours keep. Uncheck what you don't.
      </p>
      <StarterKits
        kits={kits}
        names={names}
        checked={chosen}
        onChange={setChecked}
      />
      <button
        type="button"
        disabled={status === 'saving' || chosen.length === 0}
        onClick={() => {
          setStatus('saving')
          onKeep(chosen).then(
            () => setStatus('idle'),
            () => setStatus('error'),
          )
        }}
      >
        {status === 'saving' ? 'Saving…' : `Keep these ${chosen.length}`}
      </button>
      {status === 'error' && (
        <p role="alert" className="error small">
          We couldn't save. Try again.
        </p>
      )}
    </div>
  )
}
