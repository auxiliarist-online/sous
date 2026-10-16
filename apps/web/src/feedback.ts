import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { apiFetch } from './auth.ts'

/** The database's answer to the 21st message in a day. */
export class FeedbackLimitError extends Error {}

/** A problem (filed as a bug) or an idea. */
export type FeedbackKind = 'problem' | 'idea'

export interface Report {
  message: string
  page: string
  kind: FeedbackKind
  /** The browser and phone, as the browser describes itself. */
  device?: string
  /** The PostHog replay of this session, when it's recording. */
  replayUrl?: string | null
}

/** Save a message (the database fills in who sent it); a problem is then
 *  filed in Linear by the API. Saving is what counts: if filing fails, the
 *  report is still there to read. True when it was filed. */
export async function sendFeedback(
  db: SupabaseClient,
  session: Session,
  report: Report,
  send: typeof apiFetch = apiFetch,
): Promise<boolean> {
  const { data, error } = await db
    .from('feedback')
    .insert({
      message: report.message.trim(),
      page: report.page.slice(0, 200),
      kind: report.kind,
      device: report.device?.slice(0, 300) ?? null,
      replay_url: report.replayUrl ?? null,
    })
    .select('id')
    .single()
  if (error?.code === '54000') {
    throw new FeedbackLimitError(
      "That's the most feedback for today. Thank you! Try again tomorrow.",
    )
  }
  if (error) throw error
  if (report.kind !== 'problem') return false
  try {
    const resp = await send(
      session,
      `/feedback/${(data as { id: number }).id}/file`,
      {
        method: 'POST',
      },
    )
    return (
      resp.ok && ((await resp.json()) as { filed?: boolean }).filed === true
    )
  } catch {
    return false
  }
}
