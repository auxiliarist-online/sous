// The user's grocery store (TYL-19) and their account (TYL-74).
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { apiFetch } from './auth.ts'

/** A Kroger-family store, from the store finder. */
export interface NearbyStore {
  locationId: string
  /** "harris_teeter", or "kroger" for the rest of Kroger's chains. */
  chainSlug: string
  name: string
  address: string
  city: string
  state: string
  zip: string
}

/** The store live prices come from. */
export interface MyStore {
  name: string
  address: string | null
}

interface NearbyBody {
  location_id: string
  chain_slug: string
  name: string
  address: string
  city: string
  state: string
  zip: string
}

/** Throws with the API's own message when there is one. */
async function check(resp: Response, fallback: string): Promise<Response> {
  if (resp.ok) return resp
  const detail = (
    (await resp.json().catch(() => null)) as { detail?: unknown } | null
  )?.detail
  throw new Error(typeof detail === 'string' ? detail : fallback)
}

/** Kroger-family stores near a five-digit zip code, nearest first. */
export async function storesNear(
  session: Session,
  zip: string,
  send: typeof apiFetch = apiFetch,
): Promise<NearbyStore[]> {
  const resp = await check(
    await send(session, `/stores/nearby?zip=${encodeURIComponent(zip)}`),
    "We couldn't look up stores. Try again.",
  )
  return ((await resp.json()) as NearbyBody[]).map((s) => ({
    locationId: s.location_id,
    chainSlug: s.chain_slug,
    name: s.name,
    address: s.address,
    city: s.city,
    state: s.state,
    zip: s.zip,
  }))
}

/** The user's store, or null before they choose one (prices are estimates
 *  until then). */
export async function myStore(
  session: Session,
  send: typeof apiFetch = apiFetch,
): Promise<MyStore | null> {
  const resp = await check(
    await send(session, '/stores/mine'),
    "We couldn't load your store.",
  )
  const body = (await resp.json()) as {
    store: { name: string; address: string | null } | null
  }
  return body.store
    ? { name: body.store.name, address: body.store.address }
    : null
}

/** Make a store from storesNear() the user's store. */
export async function chooseStore(
  session: Session,
  locationId: string,
  zip: string | null = null,
  send: typeof apiFetch = apiFetch,
): Promise<void> {
  await check(
    await send(session, '/stores/mine', {
      method: 'PUT',
      // The zip it was found by is saved as the home zip too (TYL-145).
      body: JSON.stringify({ location_id: locationId, ...(zip && { zip }) }),
    }),
    "We couldn't save your store. Try again.",
  )
}

/** Everything Sous keeps about the user, as pretty-printed JSON. */
export async function exportMyData(db: SupabaseClient): Promise<string> {
  const { data, error } = await db.rpc('export_my_data')
  if (error) throw error
  return JSON.stringify(data, null, 2)
}

/** Delete the user's account and everything about them. They're signed out
 *  after; the caller does that. */
export async function deleteMyAccount(db: SupabaseClient): Promise<void> {
  const { error } = await db.rpc('delete_my_account')
  if (error) throw error
}
