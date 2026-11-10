# Handoff: Sous mobile redesign (drawers direction)

## Overview
A mobile redesign of Sous (`auxiliarist-online/sous`, `apps/web`). Same product and behaviour as today's web app (Week, Plan, Recipes, Find, Recipe, List, Pantry, Add recipe), with a new look (earthy: phthalo green + warm browns on cream), a new navigation pattern (pull-up drawers over the week), and two functional additions:

1. **Review step** between plan and list: "What do you already have?" New plan entries don't reach the list until the user confirms what they need.
2. **Add a recipe** sheet with five entry points: paste a link, share from browser, photo of a cookbook page, dictation, type it in.

The chosen direction is **1c** in `Sous Directions.dc.html`: `nav="drawers"`, `home="ledger"`, `detail="pantry"`. It was reviewed in dark; both themes are specified below.

## About the design files
The files here are **design references built in HTML**: prototypes showing intended look and behaviour, not production code. Recreate them in the existing `apps/web` React + TypeScript app using its patterns (role CSS variables in `src/index.css`, the `Link` router, the `SousApi` interfaces, offline queues). Do not ship the prototype HTML or its mock data.

Open `SousApp.dc.html` in a browser to click through. Variants are props on the root (`theme`, `nav`, `home`, `detail`); the copy in this folder defaults to the chosen direction (`dark` / `drawers` / `ledger` / `pantry`). Change the fallbacks in `renderVals()` to `light` to see the light theme. Screenshots of every screen are in `screenshots/dark/` and `screenshots/light/`.

## Fidelity
**High-fidelity.** Colors, type, radii, spacing and copy are final. Recipes, prices and plan contents are placeholder data.

## Navigation: drawers
- The **Week** screen is the base layer and has no tab of its own.
- Bottom edge: three "lips" (Recipes, `List · {n to buy}`, Pantry) plus a round add button. Container `position:absolute; left/right/bottom:0; padding:28px 12px 0; display:flex; gap:6px; align-items:flex-end; background:linear-gradient(transparent, bg 55%)` so content fades out behind the lips.
  - Lip: `flex:1`, height 50px (62px when active, `transition: height .2s ease`), radius `22px 22px 0 0`, padding-top 8px, a 30×4px grab bar (radius 2px, currentColor at 45%) above the label. Label Caprasimo 14px. Inactive: bg `surface`, text `text`. Active: bg `accent`, text `accent-ink`. Shadow `0 -4px 14px rgba(12,34,24,.14)`.
  - Add button: 56×56 circle, bg `accent-2`, icon `bg` color, Lucide `plus` 26px, margin-bottom 10px, shadow `0 6px 16px rgba(12,34,24,.3)`.
- Tapping a lip opens that screen as a **drawer**: the scroll container's top moves from 0 to 52px with radius `32px 32px 0 0`; behind it an 84px strip (bg `hero`, text `hero-ink`, Caprasimo 16px "This week", right-aligned 13px "tap to close" in `hero-muted`) stays tappable and returns to Week. Tapping the active lip also closes it. Content enters with `opacity 0→1, translateY 10px→0, .28s ease`.
- Find opens inside the Recipes drawer; Plan opens over Week (pushed, with a back link). Recipe detail is a pushed full screen with **no nav**, and a sticky action bar instead.
- In production, make the drawer draggable (pull down to close); the prototype only handles taps.

## Screens

All screens: content padding `8px 20px 132px`, body Figtree 15px/1.45, headings Caprasimo. Section kicker style: 12px, weight 700, letter-spacing .08em, uppercase, color `accent-2`. Minimum hit target 44px.

### Week (home) — `Home.tsx`, `SeasonCard.tsx`
- Header row: wordmark "Sous" Caprasimo 30px `accent`; "Week of Nov 9" 13px `muted`; 44px round Preferences button (bg `surface`, Lucide `sliders-horizontal` 20px) at right → `/settings`.
- **Ledger**: headline "This week, {n} dinners." Caprasimo 38px/1.02. Then seven rows, gap 6px. Row: `min-height:62px; padding:8px 18px; radius:26px; gap:16px`; day abbreviation Caprasimo 22px in a 54px column; title weight 600; right tag 12px/700 uppercase.
  - Today: bg `hero`, text `hero-ink`, tag "Tonight".
  - Planned day: bg `card`.
  - Open day: transparent, title "Open" at 55% opacity, tag "+ Add" → Find.
  - Tap a planned row → recipe.
- Link "See and change the plan" (Caprasimo 15px, `accent`, underlined, offset 4px) → Plan.
- **Shopping card**: bg `surface`, radius 34px, padding 22px, gap 12px. "Shopping" Caprasimo 20px + "{n} to buy" 13px muted; total Caprasimo 34px `accent` ("~$39.83") + "of your $90 budget" 14px muted; progress bar 10px high, pill, track `bg`, fill `accent`, width = total/budget; pending notice (below); primary button "Open the list".
- **Pending notice** (shown on Week, Plan, List whenever any plan entry is unreviewed): bg `brown-soft`, text `brown-ink`, radius 22–24px, padding 10–12px 16–18px, 13–14px text: "**Not on the list yet:** {titles joined by '; '}. Check what you already have." + "Review" in Caprasimo at right. Opens the Review sheet.
- **In season now**: Lucide `leaf` 18px `accent` + Caprasimo 20px heading; rows of produce name (700, 76px column) + recipe title (14px muted), each → recipe.
- Other home layouts in the prototype (`tonight`, `strip`) are alternates, not chosen.

### Plan — `Plan.tsx`, `DraftWeek.tsx`
- Back link "← This week"; title "Your plan" Caprasimo 32px + "Nov 9 – 15" 18px muted.
- Buttons: primary "Plan my week"; secondary "Add a recipe" → Find.
- Pending notice: "**{n} recipe(s) is/are not on the list yet.** Check what you already have before they're added."
- Sections Monday…Sunday (today's heading adds "· tonight") then "Any day this week". Entry card: bg `card`, radius 24px, padding `12px 10px 12px 18px`; title 700; sub "{min} min" + " · not on the list yet" if unreviewed; "Move" pill (bg `surface`, 13px/600; prototype cycles day, production should use the existing day picker); 44px remove `x`. Empty day: dashed 1.5px `divider` row "Open · add a recipe" → Find.
- **Plan my week sheet**: copy from `DraftWeek.tsx`. Each pick is a `card` (radius 28px, padding 16px 18px) with title Caprasimo 18px, reason 13px muted, chips "Keep"/"Kept" (pressed = accent fill) and "Swap". Then "About **$X** for the week of your $90 budget.", primary "Add {n} to my week", secondary "Draft again". Accepted picks enter the plan as any-day, **unreviewed**.

### Review sheet (new)
- Bottom sheet, max-height 90%, radius `36px 36px 0 0`, bg `bg`; scrim `scrim`; grab bar 44×5px.
- Title "What do you already have?" Caprasimo 26px. Body: "Pantry items are ticked for you. Tap anything to change it; only what you need goes on the list."
- Grouped by recipe (kicker = recipe title). Row: pill, bg `card`, min-height 54px, padding `6px 8px 6px 18px`; **Name** · amount (13px muted); price (hidden when "have"); state pill min 84×40px:
  - "Have it": bg `accent-soft`, text `text`; row text at 55% opacity.
  - "Need it": bg `accent-2`, text `bg`.
  - Default = on hand in pantry (`onHandIn(recipeId)`); tap toggles.
- Footer (top border `divider`): "List after this" … total Caprasimo 18px "of $90"; primary CTA "Add {n} to the list · +${cost}" or "Nothing to buy · done".
- Confirm: add needed items to the list (merge by ingredient), mark entries reviewed, navigate to List, toast "{n} items added to your list."

### Recipes — `Library.tsx`
- Title "Your recipes" Caprasimo 32px; "+ Add" pill (bg `accent-2`, text `bg`, Caprasimo 14px) opens Add sheet.
- Search entry pill (bg `surface`, 52px, Lucide `search`): "Find new recipes: "quick vegetarian dinner"" → Find.
- Horizontal tag chips: All, Favorites, then the user's tags. Chip 44px, pill, 13px/700; on = `accent`/`accent-ink`, off = `surface`/`text`.
- Recipe card: bg `card`, radius 28px, padding `16px 12px 16px 20px`; title Caprasimo 18px/1.2; meta 13px muted "{source} · {min} min · favorite"; QuickAdd pill "+ Plan" (1.5px `divider` border) / "✓ Planned" (bg `accent-soft`).

### Find — `Browse.tsx`, `QuickAdd.tsx`
- Back; "Find recipes" 32px; helper copy from the web app; search field (pill, bg `card`, 1.5px `divider`, 54px, 16px text, placeholder "What do you feel like?").
- Filter chips (wrap): Under 30 min, Vegetarian, In season, Soup, Dessert — multi-select, same chip style. These are shortcuts onto the existing natural-language search.
- Count line; result cards identical to Recipes cards with meta "{source} · {min} min · {why}". Empty: "Nothing that fits your preferences matches. Try another ingredient or dish."

### Recipe — `RecipePage.tsx` (detail = `pantry`)
- Back link; favorite heart 44px round (on = bg `accent-2`); title Caprasimo 34px/1.05; facts 14px muted "{source} · {time} · serves {n}".
- Note card (bg `brown-soft`, radius 22px): "Your note from Oct 28: …". "In season: …" in `accent` 700 with leaf icon. "Cooked 6 times, last on Oct 28."
- Chips (30px, 12px/700): diets on `accent-soft`, cuisine on `brown-soft`/`brown-ink`, user tags on `surface`.
- For `link_only` sources: full-width button "View full recipe on {source}" (bg `accent-2`) is the main action; no steps shown; note "The steps live on the author's page. Sous keeps the ingredients so it can plan and price them."
- Secondary buttons "Cook" and "Cooked it" (1.5px `divider` outline, 48px).
- **Ingredients split**: "To buy ({n}) · ~${sum}" then "You have ({n})", headings Caprasimo 22px. Line: 8px dot (`accent-2` to buy, `accent` have), **amount** name, right-aligned price or "have it"; bottom rule `divider`, min-height 42px.
- Steps: numbered 34px circles (bg `accent-soft`, Caprasimo 15px).
- License attribution line 12px muted for open-licence sources (existing copy).
- Sticky bar (bottom, bg `bg`, fade shadow `0 -14px 18px bg`): "Save"/"Saved" outline pill + primary "Add to this week's plan" → after adding: "In this week · see the plan" (bg `accent-soft`).

### List — `ListPage.tsx`
- Title "Shopping list" 32px + "this week" 16px muted; 44px share button (Lucide `share-2`).
- Summary card: bg `hero`, radius 28px, padding 18px 20px; total Caprasimo 28px; "of your $90 budget"; "{x} of {y} in the cart"; 8px progress bar (fill `hero-ink`) = cart share.
- Pending notice; add-item field (pill, placeholder "Add an item, like paper towels", "Add" button disabled at 45% until text; Enter submits).
- Aisle groups (kicker heading). Row: 26px circle (2px `accent` border), **name** · amount, price; 52px; rule below. Checked rows move to "In the cart ({n})": filled `accent` circle with `check`, strike-through, muted. All checked: "Everything's in the cart."
- Keep the existing offline queue, edit/remove, "Taken off", places and print behaviour; they are not redrawn here.

### Pantry — `PantryPage.tsx`
- "Pantry" 32px; helper "What you keep at home. Sous ticks these as "have it" when you review a plan for the list." Groups "Staples" and "Have right now" as toggle chips (44px, 14px/600).

### Add a recipe sheet — `RecipeForm.tsx`, `PhotoReader.tsx`, `Library.tsx`
- Bottom sheet, max-height 92%, same chrome as Review. Menu of five rows (bg `card`, radius 28px, min-height 68px; 46px icon circle alternating `accent-soft` / `brown-soft`; label Caprasimo 17px; sub 13px muted):
  1. Paste a link — "From any recipe site" (`link`)
  2. Share from your browser — "Tap Share on a page, choose Sous" (`share-2`)
  3. Photo of a cookbook page — "Sous reads it into a draft" (`camera`)
  4. Say it — "Dictate a family recipe" (`mic`)
  5. Type it in — "Private to you" (`pencil`)
- **Link**: URL field; validation "Paste a link to a recipe page, starting with https://"; button "Save recipe" → "Reading the page…" while loading; on success open the recipe + toast "Saved to your recipes."
- **Share**: card "Save the recipe from {site}?" with title/time; "Save to my recipes". This is the existing share-target arrival state (`pendingShare`).
- **Photo**: photo slot, "Take or choose a photo" → "Reading your photo…"; then the form pre-filled with a `brown-soft` note "Read from your photos. Check it over before saving. Worth a check: …" (existing `PhotoDraft.unsure`).
- **Voice** (new): 104px mic circle (`accent`; `accent-2` and pulsing scale 1→1.12, 1s, while listening); hints "Tap and read the recipe aloud" / "Listening… tap to stop" / "Got it."; live transcript card; "Turn this into a recipe" → pre-filled form with note "Written up from what you said. Check it over before saving." Needs a new transcription + parse endpoint; reuse the photo draft shape.
- **Form**: fields and help text from `RecipeForm.tsx` (Title required → "Give the recipe a title."; Ingredients; Steps; Serves; Total time (min); Where it's from). Inputs: pill, 52px, bg `card`, 1.5px `divider`, 16px text; textareas radius 24px. "Save recipe"; "Only you can see recipes you type in."

## Interactions & behaviour
- Screen enter: `opacity 0→1, translateY(10px→0)`, .28s ease.
- Sheets: scrim fade .2s; panel `translateY(100%→0)` .3s `cubic-bezier(.2,.8,.2,1)`; tap scrim to close.
- Toast: top, 14px from edge, pill, bg `text`, text `bg`, 14px/600, auto-dismiss 2.4s.
- Progress bars animate width .35–.4s ease.
- Adding to plan (recipe page or QuickAdd) creates an any-day, unreviewed entry and shows "Added to this week. Review it for the list."
- Focus: 2px `accent` outline, offset 2px. Disabled: 45% opacity.

## State management
New state beyond what exists:
- `plan entry.reviewed: boolean` (or equivalent) — gates `syncList`: only reviewed entries' ingredients are synced. Needs a migration + RLS test.
- Review sheet: local `have` overrides per `(entryId, ingredientId)`, defaulting from `onHandIn`.
- Nav: which drawer is open (derive from route: `/recipes`, `/browse`, `/list`, `/pantry` = drawer over `/`).
- Add sheet: `mode` (menu | link | share | photo | voice | form), busy, error, draft form.
- Voice: idle | listening | done, transcript.

## Design tokens
Shape and type come from the Organic system (`_ds/.../styles.css`); colours override its accents.

| Token | Light | Dark |
| --- | --- | --- |
| bg | `#f5ead8` | `#0d1a14` |
| surface | `#ebddc5` | `#16281f` |
| card | `#fbf3e4` | `#1b3126` |
| text | `#1f1c19` | `#f1e6d0` |
| muted | `#66574a` | `#b9ab94` |
| accent (phthalo green) | `#14402e` | `#8fcdb0` |
| accent-ink (text on accent) | `#f5ead8` | `#0c2218` |
| accent-soft | `#d3e1cf` | `#214132` |
| accent-2 (warm brown) | `#7a4a2b` | `#d9a87a` |
| brown-soft | `#ead0b3` | `#3b2a1d` |
| brown-ink | `#5a3119` | `#ecc9a4` |
| divider | `rgba(31,28,25,.15)` | `rgba(241,230,208,.16)` |
| hero | `#123524` | `#1c4a36` |
| hero-ink | `#f3e8d2` | `#f3e8d2` |
| hero-muted | `#b4d3c0` | `#b4d3c0` |
| scrim | `rgba(12,34,24,.5)` | `rgba(0,0,0,.6)` |

These replace the provisional palette in `docs/brand.md` / `--brand-*` in `src/index.css`; update `docs/brand.md`, the PWA theme colour and `icon.svg` (`#2f6b4f` → `#123524`) together, and re-check AA contrast for any new text pairing.

- **Type**: Caprasimo 400 (headings, buttons, wordmark); Figtree 400/600/700 (body). Sizes: 38 / 34 / 32 / 26 / 22 / 20 / 18 heading; 16 inputs; 15 body; 14, 13 secondary; 12 kickers and small tags.
- **Radius**: pills `999px` for buttons, chips, inputs; cards 24–34px; sheets 36px top; drawer 32px top; lips 22px top.
- **Spacing**: screen gutter 20px; card padding 16–22px; section gap 16–22px; list row min-height 52px.
- **Shadows**: card `0 3px 10px rgba(46,43,37,.1)`; floating `0 12px 32px rgba(12,34,24,.3)`.

## Assets
- Icons: Lucide (`calendar-days`, `book-open`, `shopping-basket`, `package`, `plus`, `search`, `arrow-left`, `chevron-right`, `heart`, `leaf`, `share-2`, `check`, `x`, `link`, `camera`, `mic`, `pencil`, `sliders-horizontal`). The prototype loads them from a CDN as CSS masks at default stroke; in the app use `lucide-react` at **stroke-width 2.75**.
- Fonts: Caprasimo and Figtree from Google Fonts; self-host for the PWA so they work offline.
- No photography. The cookbook-photo slot is a striped placeholder.

## Files
- `SousApp.dc.html` — the full clickable prototype (template + logic; all screens, sheets, three nav / home / detail variants, both themes).
- `Sous Directions.dc.html` — the three directions side by side; the third phone (1c) is the chosen one.
- `android-frame.jsx` — device bezel only; not part of the design.
- `support.js` — prototype runtime; not part of the design.
- `_ds/…/styles.css` — Organic design-system tokens and base classes.
- `screenshots/dark/` and `screenshots/light/` — each screen and sheet of the chosen direction in both themes: 01 Week, 02 Plan, 03 Plan my week, 04 Review, 05 Recipes drawer, 06 Find, 07 Recipe, 08 List, 09 Pantry, 10 Add menu, 11 Dictate, 12 Type it in.
