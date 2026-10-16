import type { SupabaseClient } from '@supabase/supabase-js'

/** The database's answer to the 21st message in a day. */
export class FeedbackLimitError extends Error {}

/** Save a feedback message; the signed-in user is filled in by the database. */
export async function sendFeedback(
  db: SupabaseClient,
  message: string,
  page: string,
): Promise<void> {
  const { error } = await db
    .from('feedback')
    .insert({ message: message.trim(), page: page.slice(0, 200) })
  if (error?.code === '54000') {
    throw new FeedbackLimitError(
      "That's the most feedback for today. Thank you! Try again tomorrow.",
    )
  }
  if (error) throw error
}
