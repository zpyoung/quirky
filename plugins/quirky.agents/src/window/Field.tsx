import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
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

  const common = {
    id,
    'aria-label': label,
    'aria-invalid': error !== null,
    'aria-describedby': error === null ? undefined : `${id}-error`,
    value: draft,
    spellCheck: false,
    style: s.mono,
    onChange: (event: { target: { value: string } }) => {
      setDraft(event.target.value)
      setError(null)
    },
    onBlur: () => void save()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return
    if (multiline && !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    void save()
  }

  return (
    <div style={s.field}>
      <label htmlFor={id} style={s.fieldLabel}>
        {label}
      </label>
      <div style={s.fieldRow}>
        {multiline ? (
          <textarea {...common} rows={Math.max(2, draft.split('\n').length)} onKeyDown={onKeyDown} />
        ) : (
          <input {...common} onKeyDown={onKeyDown} />
        )}
        {overridden && (
          <button type="button" className="icon-button" aria-label={`Reset ${label.toLowerCase()}`} onClick={onReset}>
            Reset
          </button>
        )}
      </div>
      {error !== null && (
        <p id={`${id}-error`} className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
