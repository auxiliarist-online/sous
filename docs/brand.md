# Brand colors

- **Status:** provisional (Tyler, 2026-10-11): use these for now; revisit with a fuller visual identity.
- **In code:** `apps/web/src/index.css` defines them as `--brand-*`. Components use the role variables (`--color-bg`, `--color-text`, `--color-accent`, `--color-secondary`, `--color-muted`), so a palette change happens in one place.

| Color                      | Hex       | Role                                                                    |
| -------------------------- | --------- | ----------------------------------------------------------------------- |
| Green                      | `#2f6b4f` | Accent: buttons, links, the Sous wordmark, the app icon and theme color |
| Off-white                  | `#faf8f4` | Page background; text on green buttons                                  |
| Mahogany / chocolate brown | `#5b2d1e` | Secondary: section headings, dividers                                   |
| Black                      | `#161210` | Body text (a warm near-black)                                           |

Supporting shade: muted text `#6e5a4f` (warm brown-grey).

## Dark mode

| Role                 | Hex       |
| -------------------- | --------- |
| Background           | `#141110` |
| Text                 | `#f3efe8` |
| Accent (green)       | `#7cc4a0` |
| Secondary (mahogany) | `#c48a6a` |
| Muted                | `#b3a398` |

## Contrast

Every text/background pairing meets WCAG AA (4.5:1). The lowest are green on off-white and off-white on green, at 5.9:1 in light mode. Body text is about 17:1 in both modes. Check new pairings before using them for text.
