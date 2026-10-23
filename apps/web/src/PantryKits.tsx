import type { PantryItem } from './pantry.ts'

/** A kit's heading: "Basics", or the cuisine's or diet's name. */
function kitLabel(kit: string, names: Record<string, string>): string {
  return kit === 'basics' ? 'Basics' : (names[kit] ?? kit)
}

/** Starter kits (TYL-135): Basics, plus a kit for each favorite cuisine and
 *  diet, every item a checkbox. The caller holds what's checked (pre-checked
 *  to start) and saves it. */
export function StarterKits({
  kits,
  names,
  checked,
  onChange,
}: {
  kits: { kit: string; items: PantryItem[] }[]
  /** Cuisine and diet names, by slug. */
  names: Record<string, string>
  checked: string[]
  onChange: (next: string[]) => void
}) {
  return (
    <div className="starter-kits">
      {kits.map(({ kit, items }) => (
        <fieldset key={kit} className="kit">
          <legend>{kitLabel(kit, names)}</legend>
          {items.map((i) => (
            <label key={i.id} className="check">
              <input
                type="checkbox"
                checked={checked.includes(i.id)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...checked, i.id]
                      : checked.filter((id) => id !== i.id),
                  )
                }
              />
              {i.name}
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  )
}
