// Saving a recipe from a site that blocks Sous (TYL-59): the user copies the
// ingredients from the page (or shares a selection) and Sous keeps just the
// ingredient lines, with a link back to the author's page for everything else.

const BULLET = /^[\s•·*\-–—▢□☐■◻◦▪✓✔○●]+/
const INGREDIENTS_HEADING = /^ingredients?\b[\s:]*$/i
// Where the ingredient list ends on a typical recipe page.
const END_HEADING =
  /^(directions|instructions|method|steps|preparation|how to make( it)?|notes?|recipe notes|nutrition( facts)?|equipment|tips)\b[\s:]*$/i
const MAX_LINES = 200

function clean(line: string): string {
  return line.replace(BULLET, '').replace(/\s+/g, ' ').trim()
}

/** The ingredient lines in pasted text. Pasting a whole page works: lines
 *  between an "Ingredients" heading and "Directions" (or "Instructions",
 *  "Method", "Notes"…) are kept. Bullets and checkboxes are dropped. */
export function ingredientsFromText(text: string): string[] {
  const lines = text.split(/\r?\n/).map(clean)
  let start = lines.findIndex((l) => INGREDIENTS_HEADING.test(l))
  start = start === -1 ? 0 : start + 1
  let end = lines.findIndex((l, i) => i >= start && END_HEADING.test(l))
  if (end === -1) end = lines.length
  return lines.slice(start, end).filter(Boolean).slice(0, MAX_LINES)
}

/** A readable title from a recipe link: ".../the-best-chili-recipe-5089384"
 *  becomes "The Best Chili Recipe". */
export function titleFromUrl(url: string): string {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return ''
  }
  const slug =
    path
      .split('/')
      .filter(Boolean)
      .reverse()
      .find((part) => /[a-z]{3,}/i.test(part)) ?? ''
  const words = decodeURIComponent(slug)
    .replace(/\.[a-z]{2,5}$/i, '') // .html
    .split(/[-_+\s]+/)
    .filter((w) => w && !/^\d+$/.test(w))
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .slice(0, 200)
}

/** Drops Chrome's "link to highlight" (#:~:text=…) from a shared address. */
export function withoutTextFragment(url: string): string {
  const at = url.indexOf('#:~:')
  return at === -1 ? url : url.slice(0, at)
}

/** Text shared to Sous that looks like a copied ingredient list (more than
 *  one line once the link is taken out), or null. */
export function sharedIngredients(
  text: string | null | undefined,
): string | null {
  if (!text) return null
  const withoutLinks = text
    .replace(/https?:\/\/\S+/g, '')
    .trim()
    .replace(/^["“”']+|["“”']+$/g, '')
    .trim()
  const lines = withoutLinks.split(/\r?\n/).filter((l) => l.trim())
  return lines.length > 1 ? withoutLinks : null
}
