import type { AskPartial, AskPartialQuestionDraft, AskSpec } from '@quirky/protocol'
import { isPlainObject } from './values'

const MAX_DRAFT_STRING_LENGTH = 10000

type Checked = { ok: true; draft: AskPartialQuestionDraft } | { ok: false; message: string }

function checkDraft(path: string, raw: unknown): Checked {
  if (!isPlainObject(raw)) return { ok: false, message: `${path}: must be an object` }
  const draft: AskPartialQuestionDraft = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const keyPath = `${path}.${key}`
    switch (key) {
      case 'selected':
        if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
          return { ok: false, message: `${keyPath}: must be an array of strings` }
        }
        if (value.some((item) => item.length > MAX_DRAFT_STRING_LENGTH)) {
          return { ok: false, message: `${keyPath}: entries must be at most ${MAX_DRAFT_STRING_LENGTH} characters` }
        }
        draft.selected = value
        break
      case 'other':
      case 'note':
      case 'draft':
        if (typeof value !== 'string') return { ok: false, message: `${keyPath}: must be a string` }
        if (value.length > MAX_DRAFT_STRING_LENGTH) {
          return { ok: false, message: `${keyPath}: must be at most ${MAX_DRAFT_STRING_LENGTH} characters` }
        }
        draft[key] = value
        break
      case 'confirm':
        if (typeof value !== 'boolean') return { ok: false, message: `${keyPath}: must be a boolean` }
        draft.confirm = value
        break
      default:
        return { ok: false, message: `${keyPath}: unknown draft key` }
    }
  }
  return { ok: true, draft }
}

/**
 * Checks a window's saved draft against the stored spec. Entries for questions the spec doesn't
 * have are dropped; every kept entry must hold only the five draft keys with the right types and
 * bounded strings, or the whole partial is refused so nothing half-valid is stored.
 */
export function validatePartial(
  spec: AskSpec,
  raw: unknown
): { ok: true; partial: AskPartial } | { ok: false; message: string } {
  if (!isPlainObject(raw)) return { ok: false, message: 'partial: must be an object' }
  const known = new Set(spec.questions.map((question) => question.id))
  const partial: AskPartial = {}
  for (const [id, entry] of Object.entries(raw)) {
    if (!known.has(id)) continue
    const checked = checkDraft(`partial.${id}`, entry)
    if (!checked.ok) return checked
    partial[id] = checked.draft
  }
  return { ok: true, partial }
}
