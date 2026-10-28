import { useId, useState, type FormEvent } from 'react'
import { Button, FormRow } from '@quirky/ui'
import { Dialog } from './Dialog'

/** What a `+` menu row asks for: an agent session, optionally one that runs without a terminal. */
export type NewSessionRequest = { agent: string; background: boolean; label: string }

type Props = {
  request: NewSessionRequest
  onSubmit: (prompt: string) => void
  onClose: () => void
}

/** Asks for the first prompt of a new agent session; a background session cannot start without one. */
export function PromptDialog({ request, onSubmit, onClose }: Props) {
  const promptId = useId()
  const [prompt, setPrompt] = useState('')
  const required = request.background
  const canSubmit = !required || prompt.trim().length > 0

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (canSubmit) onSubmit(prompt)
  }

  return (
    <Dialog title={`New ${request.label} session`} onClose={onClose}>
      <form className="qt-form" onSubmit={submit}>
        <FormRow label={required ? 'Prompt' : 'Initial prompt (optional)'} htmlFor={promptId}>
          <textarea
            id={promptId}
            className="ui-text-field__input"
            autoFocus
            rows={5}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSubmit) onSubmit(prompt)
            }}
          />
        </FormRow>
        <div className="ui-dialog__actions qt-dialog-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            Start
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
