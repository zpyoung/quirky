import type { AskQuestion } from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskQuestionDraft } from './ask-question-draft'
import { AskOptionQuestion } from './AskOptionQuestion'
import { AskTextQuestion } from './AskTextQuestion'
import { AskNumberQuestion } from './AskNumberQuestion'
import { AskDateQuestion } from './AskDateQuestion'
import { AskConfirmQuestion } from './AskConfirmQuestion'

/** Dispatches one question to its type-specific renderer (tech.md § C8, Field renderers). */
export function AskFieldControl({
  question,
  draft,
  onChange,
  disabled,
  invalid
}: {
  question: AskQuestion
  draft: AskQuestionDraft
  onChange: (next: AskQuestionDraft) => void
  disabled: boolean
  invalid: boolean
}): React.JSX.Element {
  switch (question.type) {
    case 'select':
    case 'multiselect':
      return (
        <AskOptionQuestion
          question={question}
          draft={draft}
          onChange={onChange}
          disabled={disabled}
        />
      )
    case 'text':
      return (
        <AskTextQuestion
          question={question}
          draft={draft}
          onChange={onChange}
          disabled={disabled}
          invalid={invalid}
        />
      )
    case 'number':
      return (
        <AskNumberQuestion
          question={question}
          draft={draft}
          onChange={onChange}
          disabled={disabled}
          invalid={invalid}
        />
      )
    case 'date':
      return (
        <AskDateQuestion
          question={question}
          draft={draft}
          onChange={onChange}
          disabled={disabled}
          invalid={invalid}
        />
      )
    case 'confirm':
      return (
        <AskConfirmQuestion
          question={question}
          draft={draft}
          onChange={onChange}
          disabled={disabled}
        />
      )
  }
}
