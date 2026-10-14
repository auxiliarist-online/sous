import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useMemo, useState } from 'react'
import {
  auth as defaultAuth,
  client as defaultClient,
  useSession,
  type Auth,
} from './auth.ts'
import { Library, type LibraryApi } from './Library.tsx'
import {
  importPage,
  importRecipe,
  importText,
  removeSaved,
  setTags,
  savedRecipes,
} from './library.ts'
import { navigate, route, usePath } from './navigation.ts'
import { Browse, type BrowseApi } from './Browse.tsx'
import { clearBrowseCache } from './browseCache.ts'
import { clearPage, pendingPage } from './page.ts'
import { PlanPage, type PlanApi } from './Plan.tsx'
import {
  addToPlan,
  copyPlan,
  isMonday,
  loadPlan,
  addedCosts,
  clearMyPrice,
  planCost,
  setMyPrice,
  recipeFits,
  removeEntry,
  setPantry,
  updateEntry,
  weekOf,
} from './plan.ts'
import { RecipeForm, type RecipeFormApi } from './RecipeForm.tsx'
import { RecipePage, type RecipePageApi } from './RecipePage.tsx'
import { Privacy } from './Privacy.tsx'
import { Link } from './router.tsx'
import { Settings } from './Settings.tsx'
import { clearShare, pendingShare } from './share.ts'
import { SignIn } from './SignIn.tsx'
import {
  chooseStore,
  deleteMyAccount,
  exportMyData,
  myStore,
  pantryStaples,
  storesNear,
} from './stores.ts'
import { Welcome, type WelcomeApi } from './Welcome.tsx'
import {
  loadPreferences,
  NO_PREFERENCES,
  recipeDetail,
  referenceOptions,
  saveManual,
  savePreferences,
  saveToLibrary,
  searchCatalog,
  searchIngredients,
  type Preferences,
} from './sous.ts'

/** Everything the signed-in pages need; tests pass a fake. */
export type SousApi = LibraryApi &
  RecipePageApi &
  RecipeFormApi &
  WelcomeApi &
  PlanApi &
  BrowseApi

/** The real API for a signed-in session: Supabase under the user's
 *  row-level security, and the Sous API for what needs the server. */
function liveApi(db: SupabaseClient, session: Session): SousApi {
  const userId = session.user.id
  return {
    list: () => savedRecipes(db),
    save: (url) => importRecipe(session, url),
    savePage: (page) => importPage(session, page),
    saveText: (recipe) => importText(session, recipe),
    remove: (id) => removeSaved(db, id),
    recipe: (id) => recipeDetail(db, userId, id),
    saveManual: (input, id) => saveManual(session, input, id),
    preferences: () => loadPreferences(db, userId),
    savePreferences: (p) => savePreferences(db, userId, p),
    options: () => referenceOptions(db),
    searchIngredients: (q) => searchIngredients(db, q),
    plan: (week) => loadPlan(db, week),
    addToPlan: (week, id, scale, day) => addToPlan(db, week, id, scale, day),
    updateEntry: (id, patch) => updateEntry(db, id, patch),
    removeEntry: (id) => removeEntry(db, id),
    copyPlan: (from, to) => copyPlan(db, from, to),
    planCost: (week) => planCost(session, week),
    addedCosts: (week, ids) => addedCosts(session, week, ids),
    setMyPrice: (id, store, cents, basis) =>
      setMyPrice(db, id, store, cents, basis),
    clearMyPrice: (id, store) => clearMyPrice(db, id, store),
    favoriteCuisines: () =>
      loadPreferences(db, userId).then((p) => p.favoriteCuisines),
    recipeFits: (ids) => recipeFits(db, ids),
    searchCatalog: (q, offset) => searchCatalog(db, q, offset),
    saveToLibrary: (id) => saveToLibrary(db, userId, id),
    setTags: (id, tags) => setTags(db, id, tags),
    setPantry: (ingredientId, status) =>
      setPantry(db, userId, ingredientId, status),
    storesNear: (zip) => storesNear(session, zip),
    myStore: () => myStore(session),
    chooseStore: (locationId) => chooseStore(session, locationId),
    exportMyData: () => exportMyData(db),
    deleteMyAccount: () => deleteMyAccount(db),
    pantryStaples: () => pantryStaples(db),
  }
}

interface Props {
  auth?: Auth | null
  /** Builds the API for a session; tests pass a fake. */
  libraryApi?: (session: Session) => SousApi
}

function App({ auth = defaultAuth, libraryApi }: Props) {
  const session = useSession(auth)
  const path = usePath()
  const [shared] = useState(pendingShare)
  const [sharedPage] = useState(pendingPage)
  const [prefs, setPrefs] = useState<Preferences | null>(null)

  const api = useMemo(() => {
    if (!session) return null
    if (libraryApi) return libraryApi(session)
    return defaultClient ? liveApi(defaultClient, session) : null
  }, [session, libraryApi])

  // Once signed in, the Library shows the shared link; don't offer it again later.
  useEffect(() => {
    if (session && shared) clearShare()
    if (session && sharedPage) clearPage()
  }, [session, shared, sharedPage])

  useEffect(() => {
    if (!api) return
    let live = true
    api.preferences().then(
      (p) => live && setPrefs(p),
      // Preferences only shape filters; the app works without them. Marked
      // saved, so a failed load doesn't send an existing user to setup.
      () => live && setPrefs({ ...NO_PREFERENCES, saved: true }),
    )
    return () => {
      live = false
    }
  }, [api])

  const at = route(path)
  const signedIn = !!(auth && session && api)

  // A new user sets up first (TYL-58), unless they came to save a recipe.
  const needsSetup =
    signedIn && prefs !== null && !prefs.saved && !shared && !sharedPage
  useEffect(() => {
    if (needsSetup && at.page !== 'welcome' && at.page !== 'privacy') {
      navigate('/welcome', true)
    }
  }, [needsSetup, at.page])
  // Any date in the address shows the week it falls in.
  const week =
    at.page === 'plan' && at.week
      ? isMonday(at.week)
        ? at.week
        : weekOf(new Date(`${at.week}T12:00`))
      : weekOf()

  return (
    <main className="app" aria-busy={session === undefined}>
      <header className="app-header">
        <h1>
          <Link to="/">Sous</Link>
        </h1>
        <p>Plan the week. Shop the deals.</p>
        {signedIn && (
          <nav className="app-nav" aria-label="Main">
            <Link to="/">Recipes</Link>
            <Link to="/browse">Find</Link>
            <Link to="/plan">Plan</Link>
            <Link to="/settings">Preferences</Link>
          </nav>
        )}
      </header>

      {!auth && (
        <p className="error" role="alert">
          Sign-in isn't set up: add VITE_SUPABASE_URL and
          VITE_SUPABASE_ANON_KEY.
        </p>
      )}
      {at.page === 'privacy' && <Privacy signedIn={signedIn} />}
      {auth && session === null && at.page !== 'privacy' && (
        <>
          {(shared || sharedPage) && (
            <p className="card muted">Sign in to save the recipe you shared.</p>
          )}
          <SignIn auth={auth} />
        </>
      )}
      {signedIn && api && auth && session && (
        <>
          {at.page === 'library' && (
            <Library
              api={api}
              shared={shared}
              sharedPage={sharedPage}
              myDiets={prefs?.diets ?? []}
              onboarded={prefs === null || prefs.saved}
            />
          )}
          {at.page === 'recipe' && (
            <RecipePage key={at.id} id={at.id} api={api} />
          )}
          {at.page === 'new' && <RecipeForm api={api} />}
          {at.page === 'edit' && (
            <RecipeForm key={at.id} api={api} recipeId={at.id} />
          )}
          {at.page === 'browse' && <Browse api={api} />}
          {at.page === 'plan' && <PlanPage key={week} api={api} week={week} />}
          {at.page === 'settings' && (
            <Settings
              api={api}
              email={session.user.email}
              onSaved={(p) => {
                clearBrowseCache() // Find's ranking depends on preferences
                setPrefs(p)
              }}
              onSignOut={() => void auth.signOut()}
              onDeleted={() => {
                void auth.signOut()
                navigate('/', true)
              }}
            />
          )}
          {at.page === 'welcome' && (
            <Welcome
              api={api}
              onDone={(p) => {
                clearBrowseCache()
                setPrefs(p)
                navigate('/', true)
              }}
            />
          )}
        </>
      )}
    </main>
  )
}

export default App
