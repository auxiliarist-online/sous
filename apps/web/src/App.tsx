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
  removeSaved,
  savedRecipes,
} from './library.ts'
import { clearPage, pendingPage } from './page.ts'
import { clearShare, pendingShare } from './share.ts'
import { SignIn } from './SignIn.tsx'

function liveApi(db: SupabaseClient, session: Session): LibraryApi {
  return {
    list: () => savedRecipes(db),
    save: (url) => importRecipe(session, url),
    savePage: (page) => importPage(session, page),
    remove: (id) => removeSaved(db, id),
  }
}

interface Props {
  auth?: Auth | null
  /** Builds the library API for a session; tests pass a fake. */
  libraryApi?: (session: Session) => LibraryApi
}

function App({ auth = defaultAuth, libraryApi }: Props) {
  const session = useSession(auth)
  const [shared] = useState(pendingShare)
  const [sharedPage] = useState(pendingPage)

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

  return (
    <main className="app" aria-busy={session === undefined}>
      <header className="app-header">
        <h1>Sous</h1>
        <p>Plan the week. Shop the deals.</p>
      </header>

      {!auth && (
        <p className="error" role="alert">
          Sign-in isn't set up: add VITE_SUPABASE_URL and
          VITE_SUPABASE_ANON_KEY.
        </p>
      )}
      {auth && session === null && (
        <>
          {(shared || sharedPage) && (
            <p className="card muted">Sign in to save the recipe you shared.</p>
          )}
          <SignIn auth={auth} />
        </>
      )}
      {auth && session && api && (
        <>
          <Library api={api} sharedUrl={shared} sharedPage={sharedPage} />
          <section className="card account">
            <p className="muted small">
              Signed in as <strong>{session.user.email}</strong>
            </p>
            <button
              type="button"
              className="link"
              onClick={() => void auth.signOut()}
            >
              Sign out
            </button>
          </section>
        </>
      )}
    </main>
  )
}

export default App
