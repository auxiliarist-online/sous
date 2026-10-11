import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from './router.tsx'
import {
  CATEGORIES,
  type IngredientRef,
  type Option,
  type Preferences,
} from './sous.ts'

export interface SettingsApi {
  preferences(): Promise<Preferences>
  savePreferences(p: Preferences): Promise<void>
  options(): Promise<{ diets: Option[]; cuisines: Option[] }>
  searchIngredients(query: string): Promise<IngredientRef[]>
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value]
}

function ChipGroup({
  options,
  selected,
  onChange,
}: {
  options: Option[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button
          key={o.slug}
          type="button"
          className="chip"
          aria-pressed={selected.includes(o.slug)}
          onClick={() => onChange(toggle(selected, o.slug))}
        >
          {o.name}
        </button>
      ))}
    </div>
  )
}

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <fieldset className="pref">
      <legend>{title}</legend>
      {hint && <p className="muted small">{hint}</p>}
      {children}
    </fieldset>
  )
}

/** Search the canonical ingredients and pick some (favorites or dislikes). */
function IngredientPicker({
  id,
  label,
  chosen,
  onChange,
  search,
}: {
  id: string
  label: string
  chosen: IngredientRef[]
  onChange: (next: IngredientRef[]) => void
  search: (q: string) => Promise<IngredientRef[]>
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<IngredientRef[]>([])

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      search(query).then(
        (r) =>
          live &&
          setResults(r.filter((i) => !chosen.some((c) => c.id === i.id))),
        () => live && setResults([]),
      )
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, chosen, search])

  return (
    <div className="picker">
      {chosen.length > 0 && (
        <div className="chips" aria-label={`${label}: chosen`}>
          {chosen.map((i) => (
            <button
              key={i.id}
              type="button"
              className="chip"
              aria-pressed
              aria-label={`Remove ${i.name}`}
              onClick={() => onChange(chosen.filter((c) => c.id !== i.id))}
            >
              {i.name} ×
            </button>
          ))}
        </div>
      )}
      <label htmlFor={id} className="visually-hidden">
        Find an ingredient to add to {label.toLowerCase()}
      </label>
      <input
        id={id}
        type="search"
        placeholder="Find an ingredient"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.length > 0 && query.trim().length >= 2 && (
        <div className="chips" aria-label={`${label}: matches`}>
          {results.map((i) => (
            <button
              key={i.id}
              type="button"
              className="chip"
              aria-pressed={false}
              onClick={() => {
                onChange([...chosen, i])
                setQuery('')
              }}
            >
              + {i.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** How you eat (TYL-14) and what you like (TYL-24). */
export function Settings({
  api,
  email,
  onSaved,
  onSignOut,
}: {
  api: SettingsApi
  email: string | undefined
  onSaved: (p: Preferences) => void
  onSignOut: () => void
}) {
  const [prefs, setPrefs] = useState<Preferences | null>(null)
  const [options, setOptions] = useState<{
    diets: Option[]
    cuisines: Option[]
  } | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  )
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let live = true
    Promise.all([api.preferences(), api.options()]).then(
      ([p, o]) => {
        if (!live) return
        setPrefs(p)
        setOptions(o)
      },
      () => live && setLoadError(true),
    )
    return () => {
      live = false
    }
  }, [api])

  if (loadError) {
    return (
      <p className="card error" role="alert">
        We couldn't load your preferences.
      </p>
    )
  }
  if (!prefs || !options) return <p className="card muted">Loading…</p>

  const set = (patch: Partial<Preferences>) => {
    setPrefs({ ...prefs, ...patch })
    setStatus('idle')
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!prefs) return
    setStatus('saving')
    try {
      const saved = { ...prefs, saved: true }
      await api.savePreferences(saved)
      setPrefs(saved)
      setStatus('saved')
      onSaved(saved)
    } catch {
      setStatus('error')
    }
  }

  return (
    <form className="card settings" onSubmit={submit}>
      <Link to="/" className="small">
        ← Your recipes
      </Link>
      <h2>Your preferences</h2>

      <Section title="Diets" hint="Recipes are labelled and filtered by these.">
        <ChipGroup
          options={options.diets}
          selected={prefs.diets}
          onChange={(diets) => set({ diets })}
        />
      </Section>

      <Section
        title="Allergies"
        hint="Recipes with these are always left out, brand or not."
      >
        <ChipGroup
          options={CATEGORIES}
          selected={prefs.allergens}
          onChange={(allergens) => set({ allergens })}
        />
      </Section>

      <Section
        title="Also avoid"
        hint="On top of your diets, for example animal rennet in cheese."
      >
        <ChipGroup
          options={CATEGORIES}
          selected={prefs.avoid}
          onChange={(avoid) => set({ avoid })}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.strictMayContain}
            onChange={(e) => set({ strictMayContain: e.target.checked })}
          />
          Leave out recipes that only fit with the right brand (the starred
          ones)
        </label>
      </Section>

      <Section title="Favorite cuisines">
        <ChipGroup
          options={options.cuisines}
          selected={prefs.favoriteCuisines}
          onChange={(favoriteCuisines) => set({ favoriteCuisines })}
        />
      </Section>

      <Section title="Favorite ingredients">
        <IngredientPicker
          id="favorites"
          label="Favorite ingredients"
          chosen={prefs.favoriteIngredients}
          onChange={(favoriteIngredients) => set({ favoriteIngredients })}
          search={api.searchIngredients}
        />
      </Section>

      <Section title="Ingredients you'd rather skip">
        <IngredientPicker
          id="dislikes"
          label="Disliked ingredients"
          chosen={prefs.dislikedIngredients}
          onChange={(dislikedIngredients) => set({ dislikedIngredients })}
          search={api.searchIngredients}
        />
      </Section>

      <Section title="Household">
        <div className="row">
          <div>
            <label htmlFor="household">People you cook for</label>
            <input
              id="household"
              type="number"
              inputMode="numeric"
              min={1}
              max={20}
              value={prefs.householdSize}
              onChange={(e) =>
                set({
                  householdSize: Math.min(
                    20,
                    Math.max(1, Number(e.target.value) || 1),
                  ),
                })
              }
            />
          </div>
          <div>
            <label htmlFor="budget">Weekly grocery budget ($)</label>
            <input
              id="budget"
              type="number"
              inputMode="decimal"
              min={1}
              step="1"
              value={
                prefs.weeklyBudgetCents ? prefs.weeklyBudgetCents / 100 : ''
              }
              onChange={(e) => {
                const dollars = Number(e.target.value)
                set({
                  weeklyBudgetCents:
                    e.target.value.trim() && dollars > 0
                      ? Math.round(dollars * 100)
                      : null,
                })
              }}
            />
          </div>
        </div>
      </Section>

      <button type="submit" disabled={status === 'saving'}>
        {status === 'saving' ? 'Saving…' : 'Save preferences'}
      </button>
      <p
        aria-live="polite"
        className={status === 'error' ? 'error' : 'muted small'}
      >
        {status === 'saved' && 'Saved.'}
        {status === 'error' && "We couldn't save your preferences. Try again."}
      </p>

      <section className="account">
        <p className="muted small">
          Signed in as <strong>{email}</strong>
        </p>
        <button type="button" className="link" onClick={onSignOut}>
          Sign out
        </button>
      </section>
    </form>
  )
}
