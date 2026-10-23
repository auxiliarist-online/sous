import { vi } from 'vitest'
import type { Cooked, CookedApi, CookedSummary, HistoryItem } from './cooked.ts'
import type { PantryKind } from './pantry.ts'
import type { PantryStatus } from './plan.ts'
import type { Seasons } from './seasons.ts'
import type { Frequency, Recent } from './variety.ts'

/** A stand-in for the cooked-meals API in tests (TYL-68): it remembers what's
 *  marked, rated and undone, in memory. */
export function fakeCookedApi(
  start: Cooked[] = [],
  history: HistoryItem[] = [],
  recent: Recent = {},
) {
  let rows = [...start]
  let next = rows.length
  return {
    // The records for these entries, from what's been marked.
    cookedEntries: vi.fn(async (ids: string[]) =>
      Object.fromEntries(
        rows
          .filter((r) => r.planEntryId && ids.includes(r.planEntryId))
          .map((r) => [r.planEntryId!, r]),
      ),
    ),
    // Add a record, numbered cooked-1, cooked-2…
    markCooked: vi.fn(
      async (meal: Parameters<CookedApi['markCooked']>[0]): Promise<Cooked> => {
        const row: Cooked = {
          id: `cooked-${++next}`,
          recipeId: meal.recipeId,
          planEntryId: meal.planEntryId ?? null,
          cookedOn: meal.cookedOn,
          scale: meal.scale ?? 1,
          rating: null,
          note: null,
        }
        rows.push(row)
        return row
      },
    ),
    // Change a record's rating or note.
    rateCooked: vi.fn(
      async (id: string, patch: Parameters<CookedApi['rateCooked']>[1]) => {
        rows = rows.map((r) => (r.id === id ? { ...r, ...patch } : r))
      },
    ),
    // Forget a record.
    undoCooked: vi.fn(async (id: string) => {
      rows = rows.filter((r) => r.id !== id)
    }),
    // Count a recipe's records, the latest and its latest note.
    cookedSummary: vi.fn(async (recipeId: string): Promise<CookedSummary> => {
      const mine = rows
        .filter((r) => r.recipeId === recipeId)
        .sort((a, b) => b.cookedOn.localeCompare(a.cookedOn))
      const noted = mine.find((r) => r.note)
      return {
        times: mine.length,
        lastOn: mine[0]?.cookedOn ?? null,
        note: noted ? { text: noted.note!, on: noted.cookedOn } : null,
      }
    }),
    cookingHistory: vi.fn(async () => history),
    addFavorite: vi.fn(async (_recipeId: string) => {}),
    seasons: vi.fn(async (): Promise<Seasons> => new Map()),
    setFavorite: vi.fn(
      async (_recipeId: string, _frequency: Frequency | null) => {},
    ),
    recentRecipes: vi.fn(async (_week: string, _weeks: number) => recent),
    // Nothing on hand unless a test says so (TYL-137).
    onHandIn: vi.fn(
      async (
        _recipeId: string,
      ): Promise<{ ingredientId: string; name: string }[]> => [],
    ),
    setPantry: vi.fn(
      async (
        _ingredientId: string,
        _status: PantryStatus | null,
        _kind?: PantryKind,
      ) => {},
    ),
  } satisfies CookedApi & Record<string, unknown>
}
