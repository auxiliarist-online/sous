// Find's results by query, kept while the app is open so Back from a recipe
// shows the same list at once. Cleared when preferences change, since the
// ranking depends on them.
import type { CatalogRecipe } from './sous.ts'

export interface BrowseResults {
  items: CatalogRecipe[]
  /** False once a page came back short: nothing more to show. */
  more: boolean
}

export const browseCache = new Map<string, BrowseResults>()

export function clearBrowseCache(): void {
  browseCache.clear()
}
