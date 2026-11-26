import type {
  AskPartial,
  AskPartialQuestionDraft,
  AskSpec
} from '../../shared/fork-ask-question-tool/ask-question-schema'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeDraft(raw: Record<string, unknown>): AskPartialQuestionDraft {
  const draft: AskPartialQuestionDraft = {}
  if (Array.isArray(raw.selected)) {
    draft.selected = raw.selected.filter((value): value is string => typeof value === 'string')
  }
  if (typeof raw.other === 'string') {
    draft.other = raw.other
  }
  if (typeof raw.draft === 'string') {
    draft.draft = raw.draft
  }
  if (typeof raw.confirm === 'boolean') {
    draft.confirm = raw.confirm
  }
  if (typeof raw.note === 'string') {
    draft.note = raw.note
  }
  return draft
}

/**
 * Narrows an untrusted draft payload to the fields each known question can actually hold, so
 * persisted drafts never carry a shape the timeout resolution could choke on. Entries for
 * unknown questions or with a non-object value are dropped; malformed fields inside an entry are
 * dropped individually.
 */
export function sanitizeAskPartial(spec: AskSpec, raw: unknown): AskPartial {
  if (!isRecord(raw)) {
    return {}
  }
  const partial: AskPartial = {}
  for (const question of spec.questions) {
    if (!Object.hasOwn(raw, question.id)) {
      continue
    }
    const entry = raw[question.id]
    if (isRecord(entry)) {
      partial[question.id] = sanitizeDraft(entry)
    }
  }
  return partial
}
