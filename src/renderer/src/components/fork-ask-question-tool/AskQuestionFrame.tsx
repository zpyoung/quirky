import { translate } from '@/i18n/i18n'
import type { AskQuestion } from '../../../../shared/fork-ask-question-tool/ask-question-schema'

export function AskQuestionFrame({
  question,
  error,
  children
}: {
  question: AskQuestion
  error?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-2 border-b border-border/60 p-4 last:border-b-0">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {question.header ?? question.question}
          {question.required ? null : (
            <span className="ml-1 font-normal text-muted-foreground">
              {translate('components.fork-ask-question-tool.askCard.optionalHint', '(optional)')}
            </span>
          )}
        </p>
        {question.header ? (
          <p className="text-xs text-muted-foreground">{question.question}</p>
        ) : null}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
