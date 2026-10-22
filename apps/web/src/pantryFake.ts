import { vi } from 'vitest'
import type {
  Kit,
  PantryEntry,
  PantryItem,
  PantryKind,
  Suggestion,
} from './pantry.ts'
import type { PantryStatus } from './plan.ts'

/** A small pantry catalog for tests: two spices, an oil, a sauce. */
export const CATALOG: PantryItem[] = [
  { id: 'salt', name: 'salt', group: 'spices' },
  { id: 'cumin', name: 'ground cumin', group: 'spices' },
  { id: 'oil', name: 'olive oil', group: 'oils_vinegars' },
  { id: 'fish', name: 'fish sauce', group: 'sauces' },
]

/** Basics, a Thai kit and a vegetarian kit, over CATALOG. */
export const KITS: Kit[] = [
  { kit: 'basics', ingredientIds: ['salt', 'oil'] },
  { kit: 'thai', ingredientIds: ['fish', 'oil'] },
  { kit: 'vegetarian', ingredientIds: ['cumin'] },
]

/** A stand-in for the pantry API in tests (TYL-133 to TYL-137): it remembers
 *  what's kept, on hand, and turned down, in memory. */
export function fakePantryApi({
  entries = [] as PantryEntry[],
  catalog = CATALOG,
  kits = KITS,
  suggestions = [] as Suggestion[],
  onHand = [] as { ingredientId: string; name: string }[],
} = {}) {
  let rows = [...entries]
  const dismissed: string[] = []
  const named = (id: string) =>
    catalog.find((i) => i.id === id) ?? rows.find((r) => r.ingredientId === id)
  return {
    pantry: vi.fn(async () => rows),
    pantryCatalog: vi.fn(async () => catalog),
    pantryKits: vi.fn(async () => kits),
    // Keep, change or forget one entry.
    setPantry: vi.fn(
      async (id: string, status: PantryStatus | null, kind?: PantryKind) => {
        const item = named(id)
        rows = rows.filter((r) => r.ingredientId !== id)
        if (status)
          rows.push({
            ingredientId: id,
            name: item?.name ?? id,
            group: item && 'group' in item ? item.group : null,
            status,
            kind: kind ?? 'staple',
          })
      },
    ),
    // Keep several staples, all "have".
    keepStaples: vi.fn(async (ids: string[]) => {
      rows = [
        ...rows.filter((r) => !ids.includes(r.ingredientId)),
        ...ids.map((id) => ({
          ingredientId: id,
          name: named(id)?.name ?? id,
          group: catalog.find((i) => i.id === id)?.group ?? null,
          status: 'have' as const,
          kind: 'staple' as const,
        })),
      ]
    }),
    pantrySuggestions: vi.fn(async () => suggestions),
    dismissedSuggestions: vi.fn(async () => dismissed),
    dismissSuggestion: vi.fn(async (id: string) => {
      dismissed.push(id)
    }),
    onHandIn: vi.fn(async (_recipeId: string) => onHand),
    /** What's kept now, for assertions. */
    rows: () => rows,
  }
}
