import { useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Dialog } from './Dialog'
import { isSafeIcon } from './safe-icon'
import { DEFAULT_WORKTREE_STATUSES } from './daemon/statuses'
import type { WorktreeStatusDefinition } from './parity-types'

type Props = {
  context: UiPluginContext
  statuses: WorktreeStatusDefinition[]
  onClose(): void
  onSaved(statuses: WorktreeStatusDefinition[]): void
}

const BUILTIN_IDS: Record<string, true> = { todo: true, 'in-progress': true, 'in-review': true, done: true }

export function StatusSettingsDialog({ context, statuses, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState(() => statuses.map((status) => ({ ...status })))
  const [busy, setBusy] = useState(false)

  const update = (index: number, key: 'id' | 'label' | 'color' | 'icon', value: string) => {
    setDraft((current) => current.map((status, row) => row === index ? { ...status, [key]: value } : status))
  }

  const save = async () => {
    if (draft.some((status) => status.icon !== undefined && !isSafeIcon(status.icon))) {
      context.toast('Invalid status icon', 'Use plain-text emoji or symbols; URLs, SVG and HTML are not allowed.')
      return
    }
    setBusy(true)
    try {
      const saved = await context.call('quirky.worktree/setStatusDefinitions', { statuses: draft })
      if (!Array.isArray(saved)) throw new Error('The workspace status owner returned an invalid result.')
      onSaved(saved as WorktreeStatusDefinition[])
    } catch (error) {
      context.toast('Could not save workspace statuses', error instanceof Error ? error.message : String(error))
      setBusy(false)
    }
  }

  return (
    <Dialog title="Workspace statuses" onClose={onClose}>
      <div className="form">
        {draft.map((status, index) => (
          <fieldset key={`${status.id}-${index}`} className="form-group">
            <legend>{status.label || status.id || `Status ${index + 1}`}</legend>
            <label>
              <span>Status ID</span>
              <input aria-label={`Status ID ${index + 1}`} value={status.id} disabled={BUILTIN_IDS[status.id] === true} onChange={(event) => update(index, 'id', event.target.value)} />
            </label>
            <label>
              <span>Status label</span>
              <input aria-label={`Status label ${index + 1}`} value={status.label} onChange={(event) => update(index, 'label', event.target.value)} />
            </label>
            <label>
              <span>Status color</span>
              <input aria-label={`Status color ${index + 1}`} value={status.color} onChange={(event) => update(index, 'color', event.target.value)} />
            </label>
            <label>
              <span>Status icon/avatar</span>
              <input aria-label={`Status icon ${index + 1}`} value={status.icon ?? ''} maxLength={32} onChange={(event) => update(index, 'icon', event.target.value)} placeholder="Emoji or symbol" />
              <small className="muted">Plain-text emoji or symbols only; URLs, SVG and HTML are rejected.</small>
            </label>
            {BUILTIN_IDS[status.id] !== true && <button type="button" disabled={busy} onClick={() => setDraft((current) => current.filter((_, row) => row !== index))}>Remove status</button>}
          </fieldset>
        ))}
        <button type="button" disabled={busy} onClick={() => setDraft((current) => {
          let suffix = current.length + 1
          while (current.some((status) => status.id === `custom-${suffix}`)) suffix += 1
          return [...current, { id: `custom-${suffix}`, label: 'Custom status', color: '#777777' }]
        })}>Add status</button>
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void save()}>Save statuses</button>
        </div>
      </div>
    </Dialog>
  )
}
