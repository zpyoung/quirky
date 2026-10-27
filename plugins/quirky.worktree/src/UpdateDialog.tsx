import { useState, type FormEvent } from 'react'
import type { UiPluginContext, Worktree } from '@quirky/protocol'
import { setWorktree } from './actions'
import { Dialog } from './Dialog'

type Props = { context: UiPluginContext; worktree: Worktree; onClose(): void }

/** Edits a workspace's display name and Markdown notes. */
export function UpdateDialog({ context, worktree, onClose }: Props) {
  const [displayName, setDisplayName] = useState(worktree.displayName ?? '')
  const [notes, setNotes] = useState(worktree.comment)
  const [busy, setBusy] = useState(false)
  const folderName = worktree.path.split('/').filter(Boolean).pop() ?? worktree.name

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const ok = await setWorktree(context, worktree.id, { displayName: displayName.trim(), comment: notes })
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Dialog title="Workspace details" onClose={onClose}>
      <p className="muted">Attach reviews and tasks, and keep notes for this workspace.</p>
      <form className="form" onSubmit={save}>
        <label>
          <span>Display Name</span>
          <input autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={folderName} />
          <small className="muted">Shown in the sidebar. The folder name stays the same.</small>
        </label>
        <label>
          <span>Notes</span>
          <textarea rows={6} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Add notes" />
          <small className="muted">Markdown is supported.</small>
        </label>
        <div className="dialog-actions dialog-actions-spread">
          <span className="muted">Changes apply when you save</span>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}
