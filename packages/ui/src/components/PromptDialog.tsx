import { useState, type FormEvent } from 'react'
import type { AgentKind } from '@quirky/protocol'
import { Dialog } from './Dialog'

export type NewSessionRequest = { agent: AgentKind; background: boolean; label: string }

type Props = {
  request: NewSessionRequest
  onSubmit: (prompt: string) => void
  onClose: () => void
}

export function PromptDialog({ request, onSubmit, onClose }: Props) {
  const [prompt, setPrompt] = useState('')
  const required = request.background
  const canSubmit = !required || prompt.trim().length > 0

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (canSubmit) onSubmit(prompt)
  }

  return (
    <Dialog title={`New ${request.label} session`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          {required ? 'Prompt' : 'Initial prompt (optional)'}
          <textarea
            autoFocus
            rows={5}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSubmit) onSubmit(prompt)
            }}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!canSubmit}>
            Start
          </button>
        </div>
      </form>
    </Dialog>
  )
}
