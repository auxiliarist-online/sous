import { useEffect, useState } from 'react'
import { kitItems, kitsFor, type Kit, type PantryItem } from './pantry.ts'
import { StarterKits } from './PantryKits.tsx'
import {
  ChipGroup,
  HouseholdFields,
  IngredientPicker,
  type SettingsApi,
} from './Settings.tsx'
import { StorePicker } from './StorePicker.tsx'
import { CATEGORIES, type Option, type Preferences } from './sous.ts'

/** Setup needs what Preferences does, the pantry's kits included. */
export type WelcomeApi = SettingsApi

const TITLES = [
  'How do you eat?',
  'Anything you can’t or won’t eat?',
  'Cuisines you love',
  'Ingredients you love, and ones you’d skip',
  'Who are you cooking for?',
  'Where do you shop?',
  'What do you have at home?',
]

/** First-login setup (TYL-58): one question per screen, each skippable, then
 *  the same preferences Settings edits. Finishing or skipping saves, so it
 *  doesn't come back. */
export function Welcome({
  api,
  initial,
  onDone,
}: {
  api: WelcomeApi
  /** The user's preferences as App loaded them: setup starts from these. */
  initial: Preferences
  onDone: (p: Preferences) => void
}) {
  const [prefs, setPrefs] = useState<Preferences>(initial)
  const [options, setOptions] = useState<{
    diets: Option[]
    cuisines: Option[]
  } | null>(null)
  const [optionsFailed, setOptionsFailed] = useState(false)
  const [catalog, setCatalog] = useState<PantryItem[]>([])
  const [kits, setKits] = useState<Kit[]>([])
  // What's been unchecked in the starter kits: everything else shown is kept.
  const [unchecked, setUnchecked] = useState<string[]>([])
  // The kits are only kept if the user got to see them.
  const [sawKits, setSawKits] = useState(false)
  const [step, setStep] = useState(0)
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle')

  useEffect(() => {
    let live = true
    // Without the diet and cuisine lists those steps are empty, but setup
    // can still be finished or skipped.
    api.options().then(
      (o) => live && setOptions(o),
      () => {
        if (!live) return
        setOptions({ diets: [], cuisines: [] })
        setOptionsFailed(true)
      },
    )
    // Only for the last step; it's empty if they don't load.
    Promise.all([api.pantryCatalog(), api.pantryKits()]).then(
      ([c, k]) => {
        if (!live) return
        setCatalog(c)
        setKits(k)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [api])

  if (!options) return <p className="card muted">Loading…</p>

  const set = (patch: Partial<Preferences>) => setPrefs({ ...prefs, ...patch })
  const last = TITLES.length - 1
  // The starter kits for the diets and cuisines chosen so far (TYL-135).
  const starter = kitItems(kitsFor(kits, prefs), catalog)
  // What's checked: what's shown, less what was unchecked. Going back and
  // changing cuisines or diets hides some and shows new ones (pre-checked);
  // only what's shown is kept.
  const shown = starter.flatMap((k) => k.items.map((i) => i.id))
  const checked = shown.filter((id) => !unchecked.includes(id))
  // Go to a step, noting when the kits have been seen.
  const go = (to: number) => {
    if (to === last) setSawKits(true)
    setStep(to)
  }

  // Save what's been chosen (all of it, or the defaults when skipping).
  async function finish(chosen: Preferences, pantryHave: string[]) {
    setStatus('saving')
    try {
      // The pantry first: saving preferences is what ends setup.
      await api.keepStaples(pantryHave)
      const saved = { ...chosen, saved: true }
      await api.savePreferences(saved)
      onDone(saved)
    } catch {
      setStatus('error')
    }
  }

  // The current step's question.
  function current(step: number) {
    if (!options) return null
    switch (step) {
      case 0:
        return (
          <>
            <p className="muted small">
              Recipes are labelled and filtered by these.
            </p>
            <ChipGroup
              options={options.diets}
              selected={prefs.diets}
              onChange={(diets) => set({ diets })}
            />
          </>
        )
      case 1:
        return (
          <>
            <h3 className="small">Allergies: always left out</h3>
            <ChipGroup
              options={CATEGORIES}
              selected={prefs.allergens}
              onChange={(allergens) => set({ allergens })}
            />
            <h3 className="small">Also avoid</h3>
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
          </>
        )
      case 2:
        return (
          <ChipGroup
            options={options.cuisines}
            selected={prefs.favoriteCuisines}
            onChange={(favoriteCuisines) => set({ favoriteCuisines })}
          />
        )
      case 3:
        return (
          <>
            <h3 className="small">Favorites</h3>
            <IngredientPicker
              id="welcome-favorites"
              label="Favorite ingredients"
              chosen={prefs.favoriteIngredients}
              onChange={(favoriteIngredients) => set({ favoriteIngredients })}
              search={api.searchIngredients}
            />
            <h3 className="small">Rather skip</h3>
            <IngredientPicker
              id="welcome-dislikes"
              label="Disliked ingredients"
              chosen={prefs.dislikedIngredients}
              onChange={(dislikedIngredients) => set({ dislikedIngredients })}
              search={api.searchIngredients}
            />
          </>
        )
      case 4:
        return (
          <>
            <p className="muted small">
              Recipes are sized for your household, and the plan keeps to the
              budget. Leave the budget empty for none.
            </p>
            <HouseholdFields prefs={prefs} set={set} />
          </>
        )
      case 5:
        return (
          <StorePicker
            api={api}
            zip={prefs.homeZip}
            onZip={(homeZip) => set({ homeZip })}
          />
        )
      case 6:
        return (
          <>
            <p className="muted small">
              Staples you always keep are left off your shopping list. Here's
              what kitchens like yours usually have: uncheck what you don't.
            </p>
            <StarterKits
              kits={starter}
              names={Object.fromEntries(
                [...options.cuisines, ...options.diets].map((o) => [
                  o.slug,
                  o.name,
                ]),
              )}
              checked={checked}
              onChange={(next) =>
                setUnchecked((u) => [
                  ...u.filter((id) => !shown.includes(id)),
                  ...shown.filter((id) => !next.includes(id)),
                ])
              }
            />
          </>
        )
      default:
        return null
    }
  }

  return (
    <section className="card welcome" aria-labelledby="welcome-title">
      <p className="muted small">
        Step {step + 1} of {TITLES.length}
      </p>
      <progress
        max={TITLES.length}
        value={step + 1}
        aria-label="Setup progress"
      />
      <h2 id="welcome-title">{TITLES[step]}</h2>
      {optionsFailed && (step === 0 || step === 2) && (
        <p role="alert" className="muted small">
          We couldn't load the list. Skip this step for now; it's in Preferences
          later.
        </p>
      )}
      {current(step)}
      <div className="welcome-nav">
        {step > 0 && (
          <button type="button" className="link" onClick={() => go(step - 1)}>
            Back
          </button>
        )}
        {step < last ? (
          <button type="button" onClick={() => go(step + 1)}>
            Next
          </button>
        ) : (
          <button
            type="button"
            disabled={status === 'saving'}
            onClick={() => void finish(prefs, sawKits ? checked : [])}
          >
            {status === 'saving' ? 'Saving…' : 'Finish'}
          </button>
        )}
      </div>
      <button
        type="button"
        className="link small"
        disabled={status === 'saving'}
        onClick={() => void finish(prefs, sawKits ? checked : [])}
      >
        Skip the rest; you can change all of this in Preferences
      </button>
      {status === 'error' && (
        <p role="alert" className="error small">
          We couldn't save. Try again.
        </p>
      )}
    </section>
  )
}
