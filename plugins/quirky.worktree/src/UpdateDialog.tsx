import { useState, type FormEvent } from 'react'
import type { UiPluginContext, Worktree } from '@quirky/protocol'
import type { WorktreeReference } from './parity-types'
import { messageOf, setWorktree } from './actions'
import { Dialog } from './Dialog'

type EditableWorktree = Worktree & { references?: WorktreeReference[] }
type Props = { context: UiPluginContext; worktree: EditableWorktree; onClose(): void }

/** Edits workspace notes and durable manual references without treating reference URLs as commands. */
export function UpdateDialog({ context, worktree, onClose }: Props) {
  const [displayName, setDisplayName] = useState(worktree.displayName ?? '')
  const [notes, setNotes] = useState(worktree.comment)
  const [references, setReferences] = useState(worktree.references ?? [])
  const [referenceUrl, setReferenceUrl] = useState('')
  const [referenceLabel, setReferenceLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const folderName = worktree.path.split('/').filter(Boolean).pop() ?? worktree.name

  const addReference = async () => {
    try {
      const reference = await context.call('quirky.worktree/linkReference', {
        worktree: worktree.id,
        url: referenceUrl,
        label: referenceLabel
      }) as WorktreeReference
      setReferences((current) => current.some((item) => item.id === reference.id)
        ? current.map((item) => item.id === reference.id ? reference : item)
        : [...current, reference])
      setReferenceUrl('')
      setReferenceLabel('')
    } catch (error) {
      context.toast('Could not link reference', messageOf(error))
    }
  }

  const unlinkReference = async (reference: WorktreeReference) => {
    try {
      await context.call('quirky.worktree/unlinkReference', { worktree: worktree.id, reference: reference.id })
      setReferences((current) => current.filter((item) => item.id !== reference.id))
    } catch (error) {
      context.toast('Could not unlink reference', messageOf(error))
    }
  }

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
        <section className="form-group" aria-label="Linked references">
          <h3>Linked work</h3>
          {references.length === 0 ? <p className="muted">No references linked.</p> : (
            <ul>
              {references.map((reference) => (
                <li key={reference.id}>
                  <span>{reference.label} · {reference.url}</span>
                  <button type="button" aria-label={`Unlink ${reference.label}`} onClick={() => void unlinkReference(reference)}>Unlink</button>
                </li>
              ))}
            </ul>
          )}
          <label>
            <span>Reference URL</span>
            <input value={referenceUrl} onChange={(event) => setReferenceUrl(event.target.value)} placeholder="https://…" />
          </label>
          <label>
            <span>Reference label</span>
            <input value={referenceLabel} onChange={(event) => setReferenceLabel(event.target.value)} placeholder="APP-42" />
          </label>
          <button type="button" disabled={referenceUrl.trim() === ''} onClick={() => void addReference()}>Add reference</button>
          <small className="muted">Links are displayed as text here and are never executed by the worktree plugin.</small>
        </section>
        <div className="dialog-actions dialog-actions-spread">
          <span className="muted">Changes apply when you save</span>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>Save</button>
        </div>
      </form>
    </Dialog>
  )
}
