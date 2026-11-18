# Turning on Sign in with Google (TYL-48)

The app's "Continue with Google" button is built but hidden. It shows once `VITE_GOOGLE_SIGN_IN` is `on`. To turn it on:

1. **Google Cloud: create the OAuth client.**
   - Go to <https://console.cloud.google.com/apis/credentials>. Any project will do; the playlist job's project is fine.
   - If asked, set up the consent screen:
     - user type: External;
     - app name: Sous;
     - support email: yours;
     - scopes: the defaults (email, profile, openid).
   - Choose **Create credentials → OAuth client ID → Web application**.
   - Under **Authorized redirect URIs**, add Supabase's callback: `https://<project id>.supabase.co/auth/v1/callback`. The project id is `SUPABASE_PROJECT_ID` in `.env.local`.
   - Copy the **client ID** and **client secret**.
2. **Supabase: turn on the Google provider.**
   - Go to **Authentication → Sign In / Providers → Google**.
   - Turn it on and paste the client ID and secret.
   - Under **Authentication → URL Configuration**, check that the redirect URLs include `https://sous-tawny.vercel.app/**`. Email sign-in already needs this, so it's probably there.
3. **Vercel: show the button.**
   - In the `sous` project, under **Settings → Environment Variables**, add `VITE_GOOGLE_SIGN_IN` = `on` for Production.
   - Redeploy.
   - For local development, put the same line in `apps/web/.env.local`.

Until Google verifies the consent screen, it says the app is unverified and lets about 100 users through. That's plenty for the beta.

## Testing

- **Android:** sign in from the installed app. Google opens in a tab inside the app and comes back to Sous signed in.
- **iPhone:** an installed web app may finish Google's sign-in in Safari rather than in the app, leaving the app signed out. If that happens, use the emailed code in the installed app. It stays on the sign-in screen as the fallback.
