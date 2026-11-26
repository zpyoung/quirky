import { Input } from '@/components/ui/input'
import type { AskNumberQuestion as AskNumberQuestionSpec } from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskQuestionDraft } from './ask-question-draft'

export function AskNumberQuestion({
  question,
  draft,
  onChange,
  disabled,
  invalid
}: {
  question: AskNumberQuestionSpec
  draft: AskQuestionDraft
  onChange: (next: AskQuestionDraft) => void
  disabled: boolean
  invalid: boolean
}): React.JSX.Element {
  return (
    <Input
      type="number"
      inputMode={question.integer ? 'numeric' : 'decimal'}
      min={question.min}
      max={question.max}
      step={question.integer ? 1 : 'any'}
      value={draft.text}
      disabled={disabled}
      aria-invalid={invalid}
      aria-label={question.header ?? question.question}
      onChange={(event) =>
        onChange({
          ...draft,
          text: event.target.value,
          numberBadInput: event.target.validity.badInput
        })
      }
    />
  )
}
