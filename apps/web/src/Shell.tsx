import {
  useId,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent,
} from 'react'
import { Plus } from 'lucide-react'
import { navigate, type Drawer } from './navigation.ts'
import { useToast } from './toast.ts'

const PATHS: Record<Drawer, string> = {
  recipes: '/recipes',
  list: '/list',
  pantry: '/pantry',
}

// How far the drawer is pulled down before letting go closes it.
const CLOSE_AT = 110

/** A page as a drawer over the week: the "This week · tap to close" strip
 *  above it returns to the week, and so does pulling it down by its top. */
export function DrawerPanel({ children }: { children: ReactNode }) {
  const [pull, setPull] = useState(0)
  const start = useRef<number | null>(null)

  // Follow a finger (or mouse) down from the drawer's top edge.
  function down(e: PointerEvent<HTMLDivElement>) {
    start.current = e.clientY
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    if (start.current !== null) setPull(Math.max(0, e.clientY - start.current))
  }
  function up() {
    if (start.current === null) return
    start.current = null
    if (pull > CLOSE_AT) navigate('/')
    setPull(0)
  }

  return (
    <>
      <button
        type="button"
        className="drawer-strip"
        onClick={() => navigate('/')}
      >
        <span>This week</span>
        <span className="drawer-strip-hint">tap to close</span>
      </button>
      <section
        className="drawer"
        style={pull ? { transform: `translateY(${pull}px)` } : undefined}
      >
        <div
          className="drawer-handle"
          aria-hidden="true"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          <span className="grab" />
        </div>
        <div className="drawer-body screen">{children}</div>
      </section>
    </>
  )
}

/** The bottom edge (TYL-149): a lip for each drawer, and the round add
 *  button. Tapping the open drawer's lip closes it. */
export function Lips({
  open,
  toBuy,
  onAdd,
}: {
  open: Drawer | null
  /** Items left to buy on this week's list, for "List · 15". */
  toBuy: number | null
  onAdd: () => void
}) {
  const lip = (d: Drawer, label: string) => (
    <a
      href={PATHS[d]}
      className="lip"
      aria-current={open === d ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault()
        navigate(open === d ? '/' : PATHS[d])
      }}
    >
      <span className="lip-grab" aria-hidden="true" />
      {label}
    </a>
  )
  return (
    <nav className="lips" aria-label="Main">
      {lip('recipes', 'Recipes')}
      {lip('list', toBuy ? `List · ${toBuy}` : 'List')}
      {lip('pantry', 'Pantry')}
      <button
        type="button"
        className="add-button"
        aria-label="Add a recipe"
        onClick={onAdd}
      >
        <Plus size={26} strokeWidth={2.75} aria-hidden="true" />
      </button>
    </nav>
  )
}

/** The toast, when there is one (see toast.ts). */
export function Toaster() {
  const message = useToast()
  return message ? (
    <p className="toast" role="status">
      {message}
    </p>
  ) : null
}

/** A bottom sheet over a scrim (Plan my week, Review, Add a recipe): tap
 *  the scrim to close. `foot` stays put below the scrolling body. */
export function Sheet({
  title,
  onClose,
  children,
  foot,
  head,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  foot?: ReactNode
  /** Before the title: a back button. */
  head?: ReactNode
}) {
  const id = useId()
  return (
    <>
      <div className="sheet-scrim" onClick={onClose} aria-hidden="true" />
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <span className="grab" aria-hidden="true" />
        <div className="sheet-body">
          <div className="sheet-head">
            {head}
            <h2 id={id}>{title}</h2>
          </div>
          {children}
        </div>
        {foot && <div className="sheet-foot">{foot}</div>}
      </section>
    </>
  )
}
