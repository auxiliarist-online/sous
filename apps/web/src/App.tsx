import { auth as defaultAuth, useSession, type Auth } from './auth.ts'
import { SignIn } from './SignIn.tsx'

function App({ auth = defaultAuth }: { auth?: Auth | null }) {
  const session = useSession(auth)

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
      {auth && session === null && <SignIn auth={auth} />}
      {auth && session && (
        <section className="card">
          <p>
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
      )}
    </main>
  )
}

export default App
