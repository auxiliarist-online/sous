import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useMemo, useState } from 'react'
import {
  auth as defaultAuth,
  client as defaultClient,
  useSession,
  type Auth,
} from './auth.ts'
import { Home, type HomeApi } from './Home.tsx'
import { Library, type LibraryApi } from './Library.tsx'
import { ListPage, type ListApi } from './ListPage.tsx'
import { PantryPage, type PantryApi } from './PantryPage.tsx'
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
  loadPantry,
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
import { addPlace, loadList, places, sendOp, syncList } from './list.ts'
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
  HomeApi &
  ListApi &
  PantryApi &
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
    syncList: (week, items) => syncList(db, week, items),
    loadList: (week) => loadList(db, week),
    sendListOp: (op) => sendOp(db, op),
    places: () => places(db, userId),
    addPlace: (name) => addPlace(db, userId, name),
    pantry: () => loadPantry(db),
  }
}

interface Props {
  auth?: Auth | null
  /** Builds the API for a session; tests pass a fake. */
  libraryApi?: (session: Session) => SousApi
}

/** The app: sign-in, then the signed-in pages by address, with first-login
 *  setup (TYL-58) and the privacy page readable either way. */
function App({ auth = defaultAuth, libraryApi }: Props) {
  const session = useSession(auth)
  const path = usePath()
  const [shared] = useState(pendingShare)
  const [sharedPage] = useState(pendingPage)
  const [loaded, setPrefs] = useState<Preferences | null>(null)
  // Whose preferences those are: another account signing in mustn't be
  // routed by them, so they count only for the account they were loaded for.
  const [prefsFor, setPrefsFor] = useState<string | null>(null)

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

  const userId = session?.user.id ?? null
  useEffect(() => {
    if (!api) return
    let live = true
    api.preferences().then(
      (p) => {
        if (!live) return
        setPrefs(p)
        setPrefsFor(userId)
      },
      // Preferences only shape filters; the app works without them. Marked
      // saved, so a failed load doesn't send an existing user to setup.
      () => {
        if (!live) return
        setPrefs({ ...NO_PREFERENCES, saved: true })
        setPrefsFor(userId)
      },
    )
    return () => {
      live = false
    }
  }, [api, userId])

  const prefs = prefsFor === userId ? loaded : null
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
    (at.page === 'plan' || at.page === 'list') && at.week
      ? isMonday(at.week)
        ? at.week
        : weekOf(new Date(`${at.week}T12:00`))
      : weekOf()
  // Which tab is current (TYL-72): Find and recipe pages sit under Recipes,
  // the plan under Week.
  const tab =
    at.page === 'home' || at.page === 'plan'
      ? 'week'
      : at.page === 'list'
        ? 'list'
        : at.page === 'pantry'
          ? 'pantry'
          : ['library', 'recipe', 'new', 'edit', 'browse'].includes(at.page)
            ? 'recipes'
            : null

  return (
    <main className="app" aria-busy={session === undefined}>
      <header className="app-header">
        <h1>
          <Link to="/">Sous</Link>
        </h1>
        <p>Plan the week. Shop the deals.</p>
        {signedIn && (
          <Link
            to="/settings"
            className="profile-link"
            current={at.page === 'settings'}
            label="Preferences"
          >
            <span aria-hidden="true">☰</span>
          </Link>
        )}
      </header>
      {signedIn && at.page !== 'welcome' && (
        <nav className="tab-bar" aria-label="Main">
          <Link to="/" current={tab === 'week'}>
            Week
          </Link>
          <Link to="/recipes" current={tab === 'recipes'}>
            Recipes
          </Link>
          <Link to="/list" current={tab === 'list'}>
            List
          </Link>
          <Link to="/pantry" current={tab === 'pantry'}>
            Pantry
          </Link>
        </nav>
      )}

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
          {at.page === 'home' && !shared && !sharedPage && <Home api={api} />}
          {(at.page === 'library' ||
            (at.page === 'home' && (shared || sharedPage))) && (
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
          {at.page === 'list' && <ListPage key={week} api={api} week={week} />}
          {at.page === 'pantry' && <PantryPage api={api} />}
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
          {at.page === 'welcome' && !prefs && (
            <p className="card muted">Loading…</p>
          )}
          {at.page === 'welcome' && prefs && (
            <Welcome
              api={api}
              initial={prefs}
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
