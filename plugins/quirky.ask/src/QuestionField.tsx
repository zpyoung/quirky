import { useState, type CSSProperties } from 'react'
import type { AskOption, AskQuestion } from '@quirky/protocol'
import type { QuestionDraft } from './core/submission'
import { PreviewFrame } from './PreviewFrame'

type Props = {
  question: AskQuestion
  draft: QuestionDraft
  onChange: (draft: QuestionDraft) => void
}

const OWN_ANSWER = 'Add your own answer'

const PRESSED_STYLE: CSSProperties = { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff', fontWeight: 600 }

/** The controls for one question, edited through its `QuestionDraft`. */
export function QuestionField({ question, draft, onChange }: Props) {
  switch (question.type) {
    case 'select':
    case 'multiselect': {
      const multiple = question.type === 'multiselect'
      const toggle = (value: string) => {
        const picked = draft.selected.includes(value)
        if (multiple) {
          onChange({ ...draft, selected: picked ? draft.selected.filter((v) => v !== value) : [...draft.selected, value] })
        } else {
          onChange({ ...draft, selected: picked ? [] : [value] })
        }
      }
      return (
        <div className="options">
          {question.options.map((option) => (
            <OptionRow key={option.value} option={option} pressed={draft.selected.includes(option.value)} onPress={() => toggle(option.value)} />
          ))}
          <input
            value={draft.freeText}
            placeholder={OWN_ANSWER}
            aria-label={OWN_ANSWER}
            onChange={(event) => onChange({ ...draft, freeText: event.target.value })}
          />
        </div>
      )
    }
    case 'text':
      return question.multiline ? (
        <textarea rows={3} value={draft.text} aria-label={question.question} onChange={(event) => onChange({ ...draft, text: event.target.value })} />
      ) : (
        <input value={draft.text} aria-label={question.question} onChange={(event) => onChange({ ...draft, text: event.target.value })} />
      )
    case 'number':
      return (
        <input
          type="number"
          step={question.integer ? '1' : 'any'}
          min={question.min}
          max={question.max}
          value={draft.text}
          aria-label={question.question}
          onChange={(event) => onChange({ ...draft, text: event.target.value })}
        />
      )
    case 'date':
      return <input type="date" value={draft.text} aria-label={question.question} onChange={(event) => onChange({ ...draft, text: event.target.value })} />
    case 'confirm':
      return (
        <div className="options inline">
          {([true, false] as const).map((value) => (
            <button
              key={String(value)}
              type="button"
              className={draft.confirm === value ? 'active' : undefined}
              aria-pressed={draft.confirm === value}
              style={draft.confirm === value ? PRESSED_STYLE : undefined}
              onClick={() => onChange({ ...draft, confirm: value })}
            >
              {value ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      )
  }
}

function OptionRow({ option, pressed, onPress }: { option: AskOption; pressed: boolean; onPress: () => void }) {
  const [previewing, setPreviewing] = useState(false)
  return (
    <div>
      <div className="options inline" style={{ gap: 6 }}>
        <button type="button" className={pressed ? 'active' : undefined} aria-pressed={pressed} onClick={onPress} style={{ flex: 1, textAlign: 'left', ...(pressed ? PRESSED_STYLE : {}) }}>
          {option.label}
          {option.description && <small className="muted"> {option.description}</small>}
        </button>
        {option.preview && (
          <button type="button" onClick={() => setPreviewing(!previewing)}>
            {previewing ? 'Hide preview' : 'Show preview'}
          </button>
        )}
      </div>
      {option.preview && previewing && <PreviewFrame preview={option.preview} />}
    </div>
  )
}
