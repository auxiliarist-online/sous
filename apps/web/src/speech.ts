// "Say it" (TYL-151): dictate a recipe with the browser's own speech
// recognition (no server transcription, no cost), then split what was said
// into a draft for the recipe form, in the photo draft's shape.
import type { PhotoDraft } from './sous.ts'

/** The bits of the Web Speech API Sous uses (not in TypeScript's DOM lib). */
export interface Recognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: RecognitionEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

export interface RecognitionEvent {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

/** A new recognizer, or null where the browser has none (Firefox). */
export function recognizer(): Recognition | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition
    webkitSpeechRecognition?: new () => Recognition
  }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  return Ctor ? new Ctor() : null
}

// Where the ingredients and the steps start, as people say it.
const INGREDIENTS = /\b(?:ingredients?|you(?:'ll)? need|you will need)\b[:,.]?/i
const STEPS =
  /\b(?:steps?|method|directions?|instructions?|to make it|how to make it)\b[:,.]?/i

/** Capitalize a phrase and trim stray punctuation. */
function tidy(text: string): string {
  const t = text.trim().replace(/^[,.;:\s]+|[,;:\s]+$/g, '')
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}

/** What was said, as a draft recipe: the title first, then the ingredients
 *  (split at commas, "and", or a new number), then the steps (split at
 *  sentences, or "then"). Anything it can't place is left for a check. */
export function draftFromSpeech(transcript: string): PhotoDraft {
  const text = transcript.replace(/\s+/g, ' ').trim()
  const ing = text.search(INGREDIENTS)
  const step = text.search(STEPS)
  const unsure: string[] = []

  let title = ''
  let ingredientsText = ''
  let stepsText = ''
  if (ing >= 0) {
    title = text.slice(0, ing)
    const afterIng = text.slice(ing).replace(INGREDIENTS, '')
    const s = afterIng.search(STEPS)
    ingredientsText = s >= 0 ? afterIng.slice(0, s) : afterIng
    stepsText = s >= 0 ? afterIng.slice(s).replace(STEPS, '') : ''
  } else if (step >= 0) {
    title = text.slice(0, step)
    stepsText = text.slice(step).replace(STEPS, '')
    unsure.push('No ingredients were heard: say “ingredients” before them.')
  } else {
    // No markers: the first sentence is the title, the rest the steps.
    const first = text.search(/[.!?]\s/)
    title = first >= 0 ? text.slice(0, first) : text
    stepsText = first >= 0 ? text.slice(first + 1) : ''
    unsure.push('Say “ingredients” and “steps” to sort it out next time.')
  }

  const ingredients = ingredientsText
    .split(/,|;|\band\b(?=\s+(?:a|an|one|two|three|four|five|six|\d))|\.\s/i)
    .map(tidy)
    .filter(Boolean)
  const instructions = stepsText
    .split(/(?<=[.!?])\s+|\bthen\b/i)
    .map(tidy)
    .filter((s) => s.length > 1)

  return {
    title: tidy(title)
      .replace(/[.!?]+$/, '')
      .slice(0, 200),
    ingredients,
    instructions,
    servings: null,
    totalMinutes: null,
    unsure,
    skipped: [],
  }
}
