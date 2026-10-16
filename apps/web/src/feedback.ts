import type { SupabaseClient } from '@supabase/supabase-js'

/** Save a feedback message; the signed-in user is filled in by the database. */
export async function sendFeedback(
  db: SupabaseClient,
  message: string,
  page: string,
): Promise<void> {
  const { error } = await db
    .from('feedback')
    .insert({ message: message.trim(), page: page.slice(0, 200) })
  if (error) throw error
}
