// Supabase Auth in the browser: email magic links for now (ADR 0001 also
// plans Google). Only the public anon key is used here.
import {
  createClient,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js'
import { useEffect, useState } from 'react'

/** The parts of Supabase Auth the app uses; tests pass a fake. */
export type Auth = Pick<
  SupabaseClient['auth'],
  'getSession' | 'onAuthStateChange' | 'signInWithOtp' | 'signOut'
>

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** Null when the Supabase env vars aren't set (e.g. a fresh checkout). */
export const client: SupabaseClient | null =
  url && key ? createClient(url, key) : null
export const auth: Auth | null = client?.auth ?? null

/** The current session: undefined while loading, null when signed out. */
export function useSession(client: Auth | null): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(
    client ? undefined : null,
  )
  useEffect(() => {
    if (!client) return
    let live = true
    client.getSession().then(({ data }) => {
      if (live) setSession(data.session)
    })
    const { data } = client.onAuthStateChange((_event, next) =>
      setSession(next),
    )
    return () => {
      live = false
      data.subscription.unsubscribe()
    }
  }, [client])
  return session
}

/** fetch() for our API, with the signed-in user's token. */
export function apiFetch(
  session: Session,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${session.access_token}`)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(`/api${path}`, { ...init, headers })
}
