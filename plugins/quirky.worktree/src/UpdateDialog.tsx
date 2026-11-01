import { useState, type FormEvent } from 'react'
import type { UiPluginContext, Worktree } from '@quirky/protocol'
import { Button, Dialog, FormRow, SectionHeader, TextField } from '@quirky/ui'
import type { WorktreeReference } from './parity-types'
import { setWorktree } from './actions'

type EditableWorktree = Worktree & { references?: WorktreeReference[] }
type Props = { context: UiPluginContext; worktree: EditableWorktree; onClose(): void }

/** Edits workspace notes and durable manual references without treating reference URLs as commands. */
export function UpdateDialog({ context, worktree, onClose }: Props) {
  const [displayName, setDisplayName] = useState(worktree.displayName ?? '')
  const [notes, setNotes] = useState(worktree.comment)
  const [references, setReferences] = useState<Array<Pick<WorktreeReference, 'url' | 'label'>>>(worktree.references ?? [])
  const [referencesChanged, setReferencesChanged] = useState(false)
  const [referenceUrl, setReferenceUrl] = useState('')
  const [referenceLabel, setReferenceLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const folderName = worktree.path.split('/').filter(Boolean).pop() ?? worktree.name

  const addReference = () => {
    const reference = { url: referenceUrl, label: referenceLabel.trim() }
    setReferences((current) => current.some((item) => item.url === reference.url)
      ? current.map((item) => item.url === reference.url ? reference : item)
      : [...current, reference])
    setReferencesChanged(true)
    setReferenceUrl('')
    setReferenceLabel('')
  }

  const unlinkReference = (url: string) => {
    setReferences((current) => current.filter((item) => item.url !== url))
    setReferencesChanged(true)
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const ok = await setWorktree(context, worktree.id, {
      displayName: displayName.trim(),
      comment: notes,
      ...(referencesChanged ? { references: references.map(({ url, label }) => ({ url, label: label === url ? '' : label })) } : {})
    })
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Dialog open title="Workspace details" onClose={onClose}>
      <p className="ui-text-muted">Attach reviews and tasks, and keep notes for this workspace.</p>
      <form className="ui-stack" onSubmit={save}>
        <TextField
          label="Display Name"
          id="workspace-display-name"
          autoFocus
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder={folderName}
          help="Shown in the sidebar. The folder name stays the same."
        />
        <FormRow label="Notes" htmlFor="workspace-notes" help="Markdown is supported.">
          <textarea
            id="workspace-notes"
            rows={6}
            className="ui-text-field__input"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Add notes"
          />
        </FormRow>
        <section className="ui-stack" aria-label="Linked references">
          <SectionHeader title="Linked work" />
          {references.length === 0 ? <p className="ui-text-muted">No references linked.</p> : (
            <ul className="ui-tree">
              {references.map((reference) => (
                <li className="ui-tree-item ui-cluster" key={reference.url}>
                  <span className="ui-text-ellipsis">{reference.label || reference.url} · {reference.url}</span>
                  <Button type="button" disabled={busy} aria-label={`Unlink ${reference.label || reference.url}`} onClick={() => unlinkReference(reference.url)}>Unlink</Button>
                </li>
              ))}
            </ul>
          )}
          <TextField label="Reference URL" id="workspace-reference-url" value={referenceUrl} onChange={(event) => setReferenceUrl(event.target.value)} placeholder="https://…" />
          <TextField label="Reference label" id="workspace-reference-label" value={referenceLabel} onChange={(event) => setReferenceLabel(event.target.value)} placeholder="APP-42" />
          <Button type="button" disabled={busy || referenceUrl.trim() === ''} onClick={addReference}>Add reference</Button>
          <p className="ui-help-text">Links are displayed as text here and are not opened.</p>
        </section>
        <div className="ui-actions">
          <span className="ui-text-muted">Changes apply when you save</span>
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>Save</Button>
        </div>
      </form>
    </Dialog>
  )
}
