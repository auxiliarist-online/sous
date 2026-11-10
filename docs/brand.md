# Brand

- **Status:** the mobile redesign (TYL-148, `docs/design_handoff_sous_mobile/`), direction 1c: phthalo green and warm browns on cream, Caprasimo headings, Figtree body. It replaces the provisional palette of 2026-10-11.
- **In code:** `apps/web/src/index.css` defines the roles below as `--color-*` (light, and dark under `prefers-color-scheme`). Components use the roles, so a palette change happens in one place. The PWA theme colour, `index.html`'s `theme-color` and `public/icon.svg` follow `bg` and `hero`.

## Colours

| Role                   | Light                | Dark                    | Used for                                                      |
| ---------------------- | -------------------- | ----------------------- | ------------------------------------------------------------- |
| bg                     | `#f5ead8`            | `#0d1a14`               | Page; text on brown buttons                                   |
| surface                | `#ebddc5`            | `#16281f`               | Chips, lips, the shopping card                                |
| card                   | `#fbf3e4`            | `#1b3126`               | Cards, rows, inputs                                           |
| text                   | `#1f1c19`            | `#f1e6d0`               | Body text                                                     |
| muted                  | `#66574a`            | `#b9ab94`               | Secondary text                                                |
| accent (phthalo green) | `#14402e`            | `#8fcdb0`               | Primary buttons, the wordmark, links, "on" chips              |
| accent-ink             | `#f5ead8`            | `#0c2218`               | Text on accent                                                |
| accent-soft            | `#d3e1cf`            | `#214132`               | Diet chips, "Have it", "Planned"                              |
| accent-2 (warm brown)  | `#7a4a2b`            | `#d9a87a`               | The add button, "Need it", kickers                            |
| brown-soft             | `#ead0b3`            | `#3b2a1d`               | Notices, notes, cuisine chips                                 |
| brown-ink              | `#5a3119`            | `#ecc9a4`               | Text on brown-soft                                            |
| divider                | `rgba(31,28,25,.15)` | `rgba(241,230,208,.16)` | Rules, outlines                                               |
| hero                   | `#123524`            | `#1c4a36`               | Today's row, the list summary, the drawer strip, the app icon |
| hero-ink               | `#f3e8d2`            | `#f3e8d2`               | Text on hero                                                  |
| hero-muted             | `#b4d3c0`            | `#b4d3c0`               | Secondary text on hero                                        |
| scrim                  | `rgba(12,34,24,.5)`  | `rgba(0,0,0,.6)`        | Behind sheets                                                 |

## Type

- **Caprasimo** 400: headings, buttons, the wordmark. Sizes 38 / 34 / 32 / 26 / 22 / 20 / 18.
- **Figtree** 400, 600, 700: body (15px), inputs (16px), secondary (14, 13), kickers and small tags (12, bold, capitals).
- Both are self-hosted (`@fontsource`), so they work offline.

## Contrast

Text pairings meet WCAG AA (4.5:1): text on bg, card and surface; accent-ink on accent; hero-ink on hero; brown-ink on brown-soft; bg on accent-2. Muted text stays on bg, card or surface only. Check any new pairing before using it for text.
