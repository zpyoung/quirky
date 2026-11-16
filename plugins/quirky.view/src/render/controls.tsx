import { useState, type FormEvent } from 'react'
import { Button, TextArea, TextField } from '@quirky/ui'
import { textAnswerError } from '../core/catalog'
import { asItems, asNumber, asString, isRecord, oneOf, type Props } from './props'
import { useRuntime } from './runtime'
import { COLUMN, MUTED, ROW } from './styles'

const BUTTON_VARIANTS = ['primary', 'ghost'] as const

export function ViewButton({ props }: { props: Props }) {
  const { send } = useRuntime()
  const [busy, setBusy] = useState(false)
  const variant = oneOf(props.variant, BUTTON_VARIANTS, 'ghost')
  const click = async () => {
    setBusy(true)
    try {
      await send(asString(props.action), 'button')
    } finally {
      setBusy(false)
    }
  }
  return (
    <span data-view-node="button" style={{ display: 'inline-flex' }}>
      <Button variant={variant === 'primary' ? 'primary' : 'secondary'} disabled={busy} onClick={() => void click()}>
        {asString(props.label)}
      </Button>
    </span>
  )
}

type Option = { value: string; label: string; description: string }

type Draft = { selected: string[]; text: string; confirm: boolean | undefined }

function initialDraft(question: Props, type: string): Draft {
  const fallback = question.default
  return {
    selected: type === 'select' ? (typeof fallback === 'string' ? [fallback] : []) : type === 'multiselect' && Array.isArray(fallback) ? fallback.filter((entry): entry is string => typeof entry === 'string') : [],
    text: typeof fallback === 'string' ? fallback : typeof fallback === 'number' ? String(fallback) : '',
    confirm: typeof fallback === 'boolean' ? fallback : undefined
  }
}

/** The answer the draft holds, or undefined while it is not a valid one for the question. */
function answerOf(question: Props, type: string, draft: Draft): string | string[] | number | boolean | undefined {
  switch (type) {
    case 'select':
      return draft.selected[0]
    case 'multiselect':
      return draft.selected.length > 0 ? draft.selected : undefined
    case 'confirm':
      return draft.confirm
    case 'number': {
      if (draft.text.trim() === '') return undefined
      const value = Number(draft.text)
      const min = asNumber(question.min)
      const max = asNumber(question.max)
      if (!Number.isFinite(value) || (question.integer === true && !Number.isInteger(value))) return undefined
      if ((min !== undefined && value < min) || (max !== undefined && value > max)) return undefined
      return value
    }
    default:
      return draft.text.trim() === '' || textAnswerError(question, draft.text) !== undefined ? undefined : draft.text
  }
}

export function Field({ props }: { props: Props }) {
  const { send } = useRuntime()
  const question = isRecord(props.question) ? props.question : {}
  const type = oneOf(question.type, ['select', 'multiselect', 'text', 'number', 'confirm'] as const, 'text')
  const prompt = asString(question.question)
  const header = asString(question.header)
  const options: Option[] = asItems(question.options).map((option) => ({
    value: asString(option.value),
    label: asString(option.label),
    description: asString(option.description)
  }))
  const [draft, setDraft] = useState(() => initialDraft(question, type))
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const answer = answerOf(question, type, draft)
  const textError = type === 'text' && draft.text.trim() !== '' ? textAnswerError(question, draft.text) : undefined

  const change = (next: Partial<Draft>) => {
    setSent(false)
    setDraft({ ...draft, ...next })
  }
  const submit = async () => {
    if (answer === undefined || busy) return
    setBusy(true)
    try {
      setSent(await send(asString(question.id), 'field', { value: answer }))
    } finally {
      setBusy(false)
    }
  }
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void submit()
  }
  const toggle = (value: string) => {
    if (type === 'multiselect') change({ selected: draft.selected.includes(value) ? draft.selected.filter((entry) => entry !== value) : [...draft.selected, value] })
    else change({ selected: draft.selected.includes(value) ? [] : [value] })
  }

  let control
  if (type === 'select' || type === 'multiselect') {
    control = (
      <div role="group" aria-label={prompt} style={{ ...COLUMN, gap: 'var(--ui-space-6)' }}>
        {options.map((option) => (
          <Button key={option.value} variant={draft.selected.includes(option.value) ? 'primary' : 'secondary'} aria-pressed={draft.selected.includes(option.value)} onClick={() => toggle(option.value)}>
            {option.label}
            {option.description !== '' && <span> {option.description}</span>}
          </Button>
        ))}
      </div>
    )
  } else if (type === 'confirm') {
    control = (
      <div role="group" aria-label={prompt} style={ROW}>
        {([true, false] as const).map((value) => (
          <Button key={String(value)} variant={draft.confirm === value ? 'primary' : 'secondary'} aria-pressed={draft.confirm === value} onClick={() => change({ confirm: value })}>
            {value ? 'Yes' : 'No'}
          </Button>
        ))}
      </div>
    )
  } else if (type === 'number') {
    control = (
      <TextField type="number" step={question.integer === true ? '1' : 'any'} min={asNumber(question.min)} max={asNumber(question.max)} label={prompt} aria-label={prompt} value={draft.text} onChange={(event) => change({ text: event.target.value })} />
    )
  } else if (question.multiline === true) {
    control = <TextArea rows={3} label={prompt} aria-label={prompt} error={textError === undefined ? undefined : `This ${textError}`} value={draft.text} onChange={(event) => change({ text: event.target.value })} />
  } else {
    control = <TextField label={prompt} aria-label={prompt} error={textError === undefined ? undefined : `This ${textError}`} value={draft.text} onChange={(event) => change({ text: event.target.value })} />
  }

  return (
    <form data-view-node="field" onSubmit={onSubmit} style={{ ...COLUMN, gap: 'var(--ui-space-8)' }}>
      {header !== '' && <div style={MUTED}>{header}</div>}
      {(type === 'select' || type === 'multiselect' || type === 'confirm') && <div>{prompt}</div>}
      {control}
      <div style={ROW}>
        <Button variant="primary" disabled={answer === undefined || busy} onClick={() => void submit()}>Send</Button>
        {sent && <span role="status" style={MUTED}>Sent</span>}
      </div>
    </form>
  )
}
