import { useState, type CSSProperties } from 'react'
import { Button, TextArea, TextField } from '@quirky/ui'
import type { AskOption, AskQuestion } from '@quirky/protocol'
import type { QuestionDraft } from './core/submission'
import { PreviewFrame } from './PreviewFrame'

type Props = {
  question: AskQuestion
  draft: QuestionDraft
  onChange: (draft: QuestionDraft) => void
}

const OWN_ANSWER = 'Add your own answer'

const OPTIONS_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-8)',
  minWidth: 0
}

const OPTION_LINE_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'stretch',
  gap: 'var(--ui-space-8)',
  minWidth: 0
}

const OPTION_BUTTON_STYLE: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  textAlign: 'left'
}

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
        <div style={OPTIONS_STYLE}>
          {question.options.map((option) => (
            <OptionRow key={option.value} option={option} pressed={draft.selected.includes(option.value)} onPress={() => toggle(option.value)} />
          ))}
          <TextField
            label={OWN_ANSWER}
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
        <TextArea
          rows={3}
          label={question.question}
          value={draft.text}
          aria-label={question.question}
          onChange={(event) => onChange({ ...draft, text: event.target.value })}
        />
      ) : (
        <TextField
          label={question.question}
          value={draft.text}
          aria-label={question.question}
          onChange={(event) => onChange({ ...draft, text: event.target.value })}
        />
      )
    case 'number':
      return (
        <TextField
          type="number"
          step={question.integer ? '1' : 'any'}
          min={question.min}
          max={question.max}
          label={question.question}
          value={draft.text}
          aria-label={question.question}
          onChange={(event) => onChange({ ...draft, text: event.target.value })}
        />
      )
    case 'date':
      return (
        <TextField
          type="date"
          label={question.question}
          value={draft.text}
          aria-label={question.question}
          onChange={(event) => onChange({ ...draft, text: event.target.value })}
        />
      )
    case 'confirm':
      return (
        <div style={OPTION_LINE_STYLE}>
          {([true, false] as const).map((value) => (
            <Button
              key={String(value)}
              variant={draft.confirm === value ? 'primary' : 'secondary'}
              aria-pressed={draft.confirm === value}
              onClick={() => onChange({ ...draft, confirm: value })}
            >
              {value ? 'Yes' : 'No'}
            </Button>
          ))}
        </div>
      )
  }
}

function OptionRow({ option, pressed, onPress }: { option: AskOption; pressed: boolean; onPress: () => void }) {
  const [previewing, setPreviewing] = useState(false)
  return (
    <div style={OPTIONS_STYLE}>
      <div style={OPTION_LINE_STYLE}>
        <Button
          variant={pressed ? 'primary' : 'secondary'}
          aria-pressed={pressed}
          onClick={onPress}
        >
          {option.label}
          {option.description && <span> {option.description}</span>}
        </Button>
        {option.preview && (
          <Button
            aria-expanded={previewing}
            onClick={() => setPreviewing(!previewing)}
          >
            {previewing ? 'Hide preview' : 'Show preview'}
          </Button>
        )}
      </div>
      {option.preview && previewing && <PreviewFrame preview={option.preview} />}
    </div>
  )
}
