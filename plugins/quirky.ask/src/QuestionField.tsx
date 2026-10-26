import type { AskQuestion } from '@quirky/protocol'
import { OTHER, type Draft } from './askAnswers'

type Props = {
  question: AskQuestion
  draft: Draft
  name: string
  onChange: (draft: Draft) => void
}

export function QuestionField({ question, draft, name, onChange }: Props) {
  if (question.type === 'select' && draft.type === 'select') {
    return (
      <div className="options">
        {question.options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={name}
              checked={draft.choice === option.value}
              onChange={() => onChange({ ...draft, choice: option.value })}
            />
            <span>
              {option.label}
              {option.description && <small className="muted"> {option.description}</small>}
            </span>
          </label>
        ))}
        <label>
          <input
            type="radio"
            name={name}
            checked={draft.choice === OTHER}
            onChange={() => onChange({ ...draft, choice: OTHER })}
          />
          <span>Other</span>
        </label>
        {draft.choice === OTHER && (
          <input
            autoFocus
            value={draft.other}
            placeholder="Your answer"
            aria-label="Other answer"
            onChange={(event) => onChange({ ...draft, other: event.target.value })}
          />
        )}
      </div>
    )
  }
  if (question.type === 'multiselect' && draft.type === 'multiselect') {
    return (
      <div className="options">
        {question.options.map((option) => (
          <label key={option.value}>
            <input
              type="checkbox"
              checked={draft.values.includes(option.value)}
              onChange={(event) =>
                onChange({
                  ...draft,
                  values: event.target.checked
                    ? [...draft.values, option.value]
                    : draft.values.filter((v) => v !== option.value)
                })
              }
            />
            <span>
              {option.label}
              {option.description && <small className="muted"> {option.description}</small>}
            </span>
          </label>
        ))}
      </div>
    )
  }
  if (question.type === 'text' && draft.type === 'text') {
    return question.multiline ? (
      <textarea
        rows={3}
        value={draft.text}
        aria-label={question.question}
        onChange={(event) => onChange({ ...draft, text: event.target.value })}
      />
    ) : (
      <input
        value={draft.text}
        aria-label={question.question}
        onChange={(event) => onChange({ ...draft, text: event.target.value })}
      />
    )
  }
  if (question.type === 'confirm' && draft.type === 'confirm') {
    return (
      <div className="options inline">
        <label>
          <input
            type="radio"
            name={name}
            checked={draft.value === true}
            onChange={() => onChange({ ...draft, value: true })}
          />
          <span>Yes</span>
        </label>
        <label>
          <input
            type="radio"
            name={name}
            checked={draft.value === false}
            onChange={() => onChange({ ...draft, value: false })}
          />
          <span>No</span>
        </label>
      </div>
    )
  }
  return null
}
