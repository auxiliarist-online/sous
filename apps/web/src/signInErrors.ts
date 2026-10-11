/** Why the link couldn't be sent, in plain words. Supabase's built-in email
 *  service allows only 2 emails an hour for the whole project (TYL-48). */
export function sendError(error: { code?: string; status?: number }): string {
  if (error.code === 'over_email_send_rate_limit' || error.status === 429) {
    return (
      'Sous has sent as many sign-in emails as it can for now (a few an hour). ' +
      'Try again in an hour, or use the code from your last email if it was recent.'
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

/** Why a code from the email didn't work. */
export function codeError(error: { code?: string; status?: number }): string {
  if (
    error.code === 'otp_expired' ||
    error.status === 403 ||
    error.status === 401
  ) {
    return "That code didn't work. It may have expired or been replaced by a newer email; use the latest one, or send a new code."
  }
  if (error.status === 429) {
    return 'Too many tries. Wait a minute and try again.'
  }
  if (!error.status) {
    return "We couldn't reach the sign-in service. Check your connection and try again."
  }
  return "We couldn't check that code. Try again."
}
