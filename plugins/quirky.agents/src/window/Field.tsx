import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { Button, FormRow, TextField } from '@quirky/ui'
import { s } from './styles'

/**
 * A text field that saves on Enter or blur (Cmd/Ctrl+Enter for a multi-line one). `onSave`
 * resolves with an error message to show under the field, which then keeps the typed text.
 */
export function Field({
  label,
  value,
  overridden,
  multiline = false,
  onSave,
  onReset
}: {
  label: string
  value: string
  overridden: boolean
  multiline?: boolean
  onSave: (text: string) => Promise<string | null>
  onReset: () => void
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
      setError(await onSave(draft))
    } finally {
      saving.current = false
    }
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
              onBlur={() => void save()}
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
            onBlur={() => void save()}
            onKeyDown={onKeyDown}
          />
        )}
      </div>
      {overridden && (
        <Button type="button" onClick={onReset}>
          Reset
        </Button>
      )}
    </div>
  )
}
