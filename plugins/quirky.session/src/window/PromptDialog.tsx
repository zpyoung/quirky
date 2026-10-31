import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { AgentKind } from '@quirky/protocol'
import { Button, Dialog, FormRow } from '@quirky/ui'

export type NewSessionRequest = { agent: AgentKind; background: boolean; label: string }

type Props = {
  request: NewSessionRequest
  onSubmit: (prompt: string) => Promise<void>
  onClose: () => void
}

const formStyle = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-12)', minWidth: 0 } satisfies CSSProperties
const textareaStyle = { fontFamily: 'var(--ui-font-body)', resize: 'vertical' } satisfies CSSProperties

export function PromptDialog({ request, onSubmit, onClose }: Props) {
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const id = useId()
  const formId = `${id}-form`
  const textarea = useRef<HTMLTextAreaElement>(null)
  const required = request.background
  const canSubmit = !submitting && (!required || prompt.trim().length > 0)

  useEffect(() => {
    queueMicrotask(() => textarea.current?.focus())
  }, [])

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await onSubmit(prompt)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      title={`New ${request.label} session`}
      onClose={onClose}
      actions={
        <>
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" form={formId} disabled={!canSubmit}>Start</Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => { event.preventDefault(); void submit() }} style={formStyle}>
        <FormRow label={required ? 'Prompt' : 'Initial prompt (optional)'} htmlFor={id}>
          <textarea
            ref={textarea}
            id={id}
            aria-label={required ? 'Prompt' : 'Initial prompt (optional)'}
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            rows={5}
            value={prompt}
            className="ui-text-field__input"
            style={textareaStyle}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void submit()
              }
            }}
          />
        </FormRow>
      </form>
    </Dialog>
  )
}
