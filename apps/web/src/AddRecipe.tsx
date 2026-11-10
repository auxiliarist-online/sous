import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  ArrowLeft,
  Camera,
  Link as LinkIcon,
  Mic,
  Pencil,
  Share2,
} from 'lucide-react'
import { requestLinkSave } from './library.ts'
import { navigate } from './navigation.ts'
import { PhotoReader } from './PhotoReader.tsx'
import {
  RecipeForm,
  type DraftSource,
  type RecipeFormApi,
} from './RecipeForm.tsx'
import type { PhotoDraft } from './sous.ts'
import { draftFromSpeech, recognizer, type Recognition } from './speech.ts'
import { Sheet } from './Shell.tsx'
import { showToast } from './toast.ts'

export type AddRecipeApi = RecipeFormApi

type Mode = 'menu' | 'link' | 'share' | 'photo' | 'voice' | 'form'

const TITLES: Record<Mode, string> = {
  menu: 'Add a recipe',
  link: 'Paste a link',
  share: 'Share from your browser',
  photo: 'Photo of a cookbook page',
  voice: 'Say it',
  form: 'Type in a recipe',
}

// The menu's wording, where it differs from the sheet's title.
const LABELS: Partial<Record<Mode, string>> = { form: 'Type it in' }

/** Open a saved recipe and say so. */
function opened(id: string, onClose: () => void) {
  onClose()
  navigate(`/recipe/${id}`)
  showToast('Saved to your recipes.')
}

/** "Add a recipe" (TYL-151): a sheet with five ways in. Paste a link, share
 *  from the browser, a photo of a cookbook page, say it, or type it in. */
export function AddRecipeSheet({
  api,
  onClose,
}: {
  api: AddRecipeApi
  onClose: () => void
}) {
  const [mode, setMode] = useState<Mode>('menu')
  const [draft, setDraft] = useState<{
    draft: PhotoDraft
    from: DraftSource
  } | null>(null)

  // A draft from a photo or speech opens the form, filled in.
  const toForm = (d: PhotoDraft, from: DraftSource) => {
    setDraft({ draft: d, from })
    setMode('form')
  }

  return (
    <Sheet
      title={TITLES[mode]}
      onClose={onClose}
      head={
        mode !== 'menu' && (
          <button
            type="button"
            className="icon-button plain"
            aria-label="Back"
            onClick={() => {
              setMode('menu')
              setDraft(null)
            }}
          >
            <ArrowLeft size={22} strokeWidth={2.75} aria-hidden="true" />
          </button>
        )
      }
    >
      {mode === 'menu' && <Menu onPick={setMode} />}
      {mode === 'link' && <FromLink onClose={onClose} />}
      {mode === 'share' && <FromShare />}
      {mode === 'photo' && (
        <PhotoReader read={api.readPhotos} onRead={(d) => toForm(d, 'photo')} />
      )}
      {mode === 'voice' && <FromVoice onDraft={(d) => toForm(d, 'voice')} />}
      {mode === 'form' && (
        <RecipeForm
          key={draft ? 'draft' : 'empty'}
          api={api}
          embedded
          draft={draft ?? undefined}
          onSaved={(id) => opened(id, onClose)}
        />
      )}
    </Sheet>
  )
}

/** The five ways in, each with what it does. */
function Menu({ onPick }: { onPick: (m: Mode) => void }) {
  const row = (m: Mode, icon: ReactNode, sub: string, brown: boolean) => (
    <li key={m}>
      <button type="button" className="add-way" onClick={() => onPick(m)}>
        <span className={brown ? 'add-icon brown' : 'add-icon'}>{icon}</span>
        <span>
          <span className="add-way-label">{LABELS[m] ?? TITLES[m]}</span>
          <span className="add-way-sub">{sub}</span>
        </span>
      </button>
    </li>
  )
  const icon = { size: 22, strokeWidth: 2.75, 'aria-hidden': true } as const
  return (
    <ul className="add-ways">
      {row('link', <LinkIcon {...icon} />, 'From any recipe site', false)}
      {row(
        'share',
        <Share2 {...icon} />,
        'Tap Share on a page, choose Sous',
        true,
      )}
      {row('photo', <Camera {...icon} />, 'Sous reads it into a draft', false)}
      {row('voice', <Mic {...icon} />, 'Dictate a family recipe', true)}
      {row('form', <Pencil {...icon} />, 'Private to you', false)}
    </ul>
  )
}

/** Paste a recipe page's address. The recipes page saves it, with its full
 *  flow (when a site turns Sous away, it offers to paste the ingredients). */
function FromLink({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(e: FormEvent) {
    e.preventDefault()
    const link = url.trim()
    if (!/^https:\/\/\S+\.\S+/i.test(link)) {
      setError('Paste a link to a recipe page, starting with https://')
      return
    }
    requestLinkSave(link)
    onClose()
    navigate('/recipes')
  }

  return (
    <form className="add-form" noValidate onSubmit={submit}>
      <label htmlFor="add-url" className="visually-hidden">
        Recipe link
      </label>
      <input
        id="add-url"
        type="url"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="https://"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <button type="submit" disabled={!url.trim()}>
        Save recipe
      </button>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

/** How sharing a page to Sous works; the page arrives on its own. */
function FromShare() {
  return (
    <div className="panel add-share">
      <p>
        Open a recipe in your browser, tap <strong>Share</strong>, and choose{' '}
        <strong>Sous</strong>. Sous opens with the recipe, ready to save.
      </p>
      <p className="small muted">
        Sous needs to be installed on your phone to show up in Share.
      </p>
    </div>
  )
}

/** Dictate a recipe: tap to listen, tap to stop, then turn what was said
 *  into a draft. Uses the browser's speech recognition. */
function FromVoice({ onDraft }: { onDraft: (d: PhotoDraft) => void }) {
  const [state, setState] = useState<'idle' | 'listening' | 'done'>('idle')
  const [said, setSaid] = useState('')
  const [hearing, setHearing] = useState('')
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<Recognition | null>(null)
  const [supported] = useState(() => recognizer() !== null)

  // Stop listening when the sheet closes.
  useEffect(() => () => rec.current?.stop(), [])

  function toggle() {
    if (state === 'listening') {
      rec.current?.stop()
      return
    }
    const r = recognizer()
    if (!r) return
    r.continuous = true
    r.interimResults = true
    r.lang = navigator.language || 'en-US'
    r.onresult = (e) => {
      let final = ''
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const piece = e.results[i][0].transcript
        if (e.results[i].isFinal) final += piece
        else interim += piece
      }
      if (final) setSaid((s) => `${s} ${final}`.trim())
      setHearing(interim)
    }
    r.onerror = (e) =>
      setError(
        e.error === 'not-allowed'
          ? 'Sous needs the microphone to listen. Allow it in your browser.'
          : "We couldn't hear that. Try again.",
      )
    r.onend = () => {
      setHearing('')
      setState('done')
    }
    rec.current = r
    setError(null)
    setState('listening')
    r.start()
  }

  if (!supported)
    return (
      <p className="panel">
        This browser can't take dictation. Try Chrome, or type the recipe in.
      </p>
    )

  const transcript = `${said} ${hearing}`.trim()
  return (
    <div className="voice">
      <button
        type="button"
        className={state === 'listening' ? 'mic listening' : 'mic'}
        aria-label={
          state === 'listening' ? 'Stop listening' : 'Start listening'
        }
        aria-pressed={state === 'listening'}
        onClick={toggle}
      >
        <Mic size={40} strokeWidth={2.75} aria-hidden="true" />
      </button>
      <p className="voice-hint" role="status">
        {state === 'listening'
          ? 'Listening… tap to stop'
          : state === 'done' && said
            ? 'Got it.'
            : 'Tap and read the recipe aloud'}
      </p>
      <div className="panel voice-transcript">
        {transcript || (
          <span className="muted">
            Title, ingredients, then the steps. Sous sorts it out.
          </span>
        )}
      </div>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      {state === 'done' && said && (
        <button type="button" onClick={() => onDraft(draftFromSpeech(said))}>
          Turn this into a recipe
        </button>
      )}
    </div>
  )
}
