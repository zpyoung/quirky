import { useId, useState, type FormEvent } from 'react'
import { Button, FormRow } from '@quirky/ui'
import { Dialog } from './Dialog'

/** How an agent handles tool approvals, as Agent settings configures it. */
export type PermissionMode = 'manual' | 'auto' | 'yolo'

/** What a `+` menu row asks for: an agent session, optionally one that runs without a terminal. */
export type NewSessionRequest = { agent: string; background: boolean; label: string; permissions?: PermissionMode }

const PERMISSION_TEXT: Record<PermissionMode, string> = {
  manual: 'Permissions: Manual. The agent asks before acting.',
  auto: 'Permissions: Auto. The agent decides which actions need approval.',
  yolo: 'Permissions: Bypass. The agent acts without asking.'
}

type Props = {
  request: NewSessionRequest
  pending: boolean
  error: string | null
  onSubmit: (prompt: string) => void
  onClose: () => void
}

/** Asks for the first prompt of a new agent session; a background session cannot start without one. */
export function PromptDialog({ request, pending, error, onSubmit, onClose }: Props) {
  const promptId = useId()
  const [prompt, setPrompt] = useState('')
  const required = request.background
  const canSubmit = !pending && (!required || prompt.trim().length > 0)

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
        {request.permissions ? <p className="ui-help-text">{PERMISSION_TEXT[request.permissions]} Change it in Agent settings.</p> : null}
        {error !== null ? <div className="ui-error-text" role="alert">{error}</div> : null}
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
