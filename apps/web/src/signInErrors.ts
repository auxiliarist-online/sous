/** Why the link couldn't be sent, in plain words. Supabase's built-in email
 *  service allows only 2 emails an hour for the whole project (TYL-48). */
export function sendError(error: { code?: string; status?: number }): string {
  if (error.code === 'over_email_send_rate_limit' || error.status === 429) {
    return (
      'Sous has sent as many sign-in emails as it can for now (a few an hour). ' +
      'Try again in an hour, or use the link from your last email if it was recent.'
    )
  }
  if (
    error.code === 'email_address_invalid' ||
    error.code === 'validation_failed'
  ) {
    return "That doesn't look like a valid email address."
  }
  if (!error.status) {
    return "We couldn't reach the sign-in service. Check your connection and try again."
  }
  return "We couldn't send the link. Try again in a minute."
}
