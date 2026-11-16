import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { Button, FormRow, TextField } from '@quirky/ui'
import type { AgentsStore } from './model'
import { s } from './styles'

export type AgentField = 'command' | 'args' | 'env'

/** Reads `KEY=VALUE` lines; a line without a name or `=` is refused with a message. */
function parseEnv(text: string): { env: Record<string, string> } | { error: string } {
  const entries: [string, string][] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const separator = line.indexOf('=')
    if (separator <= 0) return { error: `Invalid environment line; expected KEY=VALUE: ${line}` }
    entries.push([line.slice(0, separator), line.slice(separator + 1)])
  }
  return { env: Object.fromEntries(entries) }
}

/** A text field that saves on Enter or blur (Cmd/Ctrl+Enter for a multi-line one). */
export function Field({
  label,
  value,
  overridden,
  multiline = false,
  agentId,
  field,
  store
}: {
  label: string
  value: string
  overridden: boolean
  multiline?: boolean
  agentId: string
  field: AgentField
  store: AgentsStore
}) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const saving = useRef(false)

  useEffect(() => {
    setDraft(value)
    setError(null)
  }, [value])

  const save = async () => {
    if (saving.current || draft === value) return
    saving.current = true
    try {
      if (field === 'env') {
        const parsed = parseEnv(draft)
        if ('error' in parsed) {
          setError(parsed.error)
          return
        }
        setError(await store.configure(agentId, parsed))
      } else if (field === 'command') {
        setError(await store.configure(agentId, { command: draft }))
      } else {
        setError(await store.configure(agentId, { args: draft }))
      }
    } finally {
      saving.current = false
    }
  }

  const onBlur = () => {
    void save()
  }

  const onChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setDraft(event.target.value)
    setError(null)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return
    if (multiline && !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    void save()
  }

  return (
    <div style={s.fieldRow}>
      <div style={s.fieldControl}>
        {multiline ? (
          <FormRow label={label} htmlFor={id} error={error ?? undefined}>
            <textarea
              id={id}
              aria-label={label}
              value={draft}
              spellCheck={false}
              rows={Math.max(2, draft.split('\n').length)}
              className="ui-text-field__input"
              style={s.mono}
              onChange={onChange}
              onBlur={onBlur}
              onKeyDown={onKeyDown}
            />
          </FormRow>
        ) : (
          <TextField
            id={id}
            label={label}
            aria-label={label}
            value={draft}
            error={error ?? undefined}
            spellCheck={false}
            style={s.mono}
            onChange={onChange}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
          />
        )}
      </div>
      {overridden && (
        <Button type="button" onClick={() => void store.configure(agentId, { reset: [field] })}>
          Reset
        </Button>
      )}
    </div>
  )
}
