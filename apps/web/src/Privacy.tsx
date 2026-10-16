import { Link } from './router.tsx'

/** What Sous keeps about you, in plain words (TYL-74). Linked from sign-in
 *  and Preferences; readable signed out. Keep it true when things change. */
export function Privacy({ signedIn }: { signedIn: boolean }) {
  return (
    <article className="card privacy">
      <Link to={signedIn ? '/settings' : '/'} className="small">
        ← {signedIn ? 'Preferences' : 'Sign in'}
      </Link>
      <h2>What Sous keeps about you</h2>
      <p className="muted small">
        Sous is in a small test with friends and family. This page says what it
        keeps, where it goes, and how to take it back.
      </p>

      <h3>What Sous keeps</h3>
      <ul>
        <li>Your email address, to sign you in.</li>
        <li>
          What you tell it about how you eat: diets, allergies, things to avoid,
          favorite cuisines and ingredients, household size and weekly budget.
        </li>
        <li>
          Your zip code and the store you choose, to find prices near you. Sous
          doesn't use your device's location.
        </li>
        <li>
          Recipes you save (and your tags on them), recipes you type in, your
          meal plans, shopping lists, your pantry, and prices you enter.
        </li>
        <li>
          Problems and ideas you send from the app, with the page you sent them
          from (and for a problem, your phone and browser). The team reads them
          to fix and improve Sous.
        </li>
      </ul>

      <h3>Who sees it</h3>
      <p>
        Only you. Your prices, tags, plans and the recipes you type in are
        private. Recipes you import from a website join Sous's shared catalog as
        a link, without your name. Nothing is sold, and there are no ads or
        trackers.
      </p>

      <h3>Other services Sous uses</h3>
      <ul>
        <li>
          <strong>Supabase</strong> stores the data above and sends sign-in
          codes.
        </li>
        <li>
          <strong>Vercel</strong> runs the app and its server.
        </li>
        <li>
          <strong>Kroger</strong> answers store and price lookups. Sous sends
          your zip code or store and the products it's pricing, never who you
          are.
        </li>
        <li>
          <strong>Google Cloud Vision</strong> reads the text of cookbook pages
          you photograph to add a recipe. Sous doesn't keep the photos.
        </li>
        <li>
          <strong>PostHog</strong> records how Sous is used, errors, and replays
          of what's on screen, so problems can be found and fixed. Anything you
          type is hidden in replays, and you're known by your account number,
          not your name or email.
        </li>
        <li>
          <strong>Linear</strong> is where the team tracks problems you report,
          with your message, the page, your phone and browser, and a link to the
          replay.
        </li>
        <li>
          <strong>Recipe websites</strong> are visited by Sous's server when you
          import a link, as "SousBot".
        </li>
      </ul>

      <h3>Taking it back</h3>
      <p>
        In Preferences, <strong>Download my data</strong> gives you a copy of
        everything above, and <strong>Delete my account</strong> deletes it all,
        including the recipes you typed in. Deleting can't be undone.
      </p>
    </article>
  )
}
