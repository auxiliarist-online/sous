import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useMemo, useState } from 'react'
import {
  auth as defaultAuth,
  client as defaultClient,
  useSession,
  type Auth,
} from './auth.ts'
import { Library, type LibraryApi } from './Library.tsx'
import { importRecipe, removeSaved, savedRecipes } from './library.ts'
import { clearShare, pendingShare } from './share.ts'
import { SignIn } from './SignIn.tsx'

function liveApi(db: SupabaseClient, session: Session): LibraryApi {
  return {
    list: () => savedRecipes(db),
    save: (url) => importRecipe(session, url),
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

  const api = useMemo(() => {
    if (!session) return null
    if (libraryApi) return libraryApi(session)
    return defaultClient ? liveApi(defaultClient, session) : null
  }, [session, libraryApi])

  // Once signed in, the Library takes the shared link; don't replay it later.
  useEffect(() => {
    if (session && shared) clearShare()
  }, [session, shared])

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
          {shared && (
            <p className="card muted">
              Sign in and we'll save the recipe you shared.
            </p>
          )}
          <SignIn auth={auth} />
        </>
      )}
      {auth && session && api && (
        <>
          <Library api={api} sharedUrl={shared} />
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
