import type {
  AskPartial,
  AskPartialQuestionDraft
} from '../../../../shared/fork-ask-question-tool/ask-question-schema'

/** Local widget state for one question, keyed by question id in `AskCard`. */
export type AskQuestionDraft = {
  /** Option `value`s currently picked (0 or 1 for `select`, 0..n for `multiselect`). */
  selected: string[]
  /** Free text: the escape hatch when no option is picked, or a note alongside one. */
  freeText: string
  /** Raw input for `text` / `number` / `date`; parsed against the question's domain on submit. */
  text: string
  confirm: boolean | null
  /** The browser holds in-progress number text (`1e`, `-`) it reports as an empty value. */
  numberBadInput?: boolean
}

export function initialDraftFor(partial: AskPartialQuestionDraft | undefined): AskQuestionDraft {
  return {
    selected: partial?.selected ?? [],
    freeText: (partial?.selected?.length ? partial.note : partial?.other) ?? '',
    text: partial?.draft ?? '',
    confirm: partial?.confirm ?? null
  }
}

/** Inverse of `initialDraftFor`: normalizes one question's widget state back to its persisted shape. */
function draftToPartial(draft: AskQuestionDraft): AskPartialQuestionDraft | undefined {
  const partial: AskPartialQuestionDraft = {}
  if (draft.selected.length > 0) {
    partial.selected = draft.selected
    if (draft.freeText) {
      partial.note = draft.freeText
    }
  } else if (draft.freeText) {
    partial.other = draft.freeText
  }
  if (draft.text) {
    partial.draft = draft.text
  }
  if (draft.confirm !== null) {
    partial.confirm = draft.confirm
  }
  return Object.keys(partial).length > 0 ? partial : undefined
}

/** Normalizes every question's draft into the `AskPartial` shape `ask.updatePartial` sends. */
export function draftsToPartial(drafts: Record<string, AskQuestionDraft>): AskPartial {
  const partial: AskPartial = {}
  for (const [questionId, draft] of Object.entries(drafts)) {
    const normalized = draftToPartial(draft)
    if (normalized) {
      partial[questionId] = normalized
    }
  }
  return partial
}
