import { useEffect, useState, type FormEvent } from 'react'
import type { ProjectGroup, Repo, UiPluginContext } from '@quirky/protocol'
import { changeGroup } from './actions'
import { expectedLedgerSnapshots, ledgerRetentionNotice, previewLedgerRemoval, type LedgerRemovalPreview } from './ledger'
import { Dialog } from './Dialog'
import { repoLabel } from './report'

type NameFormProps = {
  title: string
  submitLabel: string
  initial: string
  hint?: string
  onSubmit(name: string): Promise<boolean>
  onClose(): void
}

function NameForm({ title, submitLabel, initial, hint, onSubmit, onClose }: NameFormProps) {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const trimmed = name.trim()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!trimmed) return
    setBusy(true)
    const ok = await onSubmit(trimmed)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Dialog title={title} onClose={onClose}>
      {hint && <p className="muted">{hint}</p>}
      <form className="form" onSubmit={submit}>
        <label>
          <span>Group name</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !trimmed}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** Creates a group and puts `repo` in it. */
export function NewGroupDialog({ context, repo, onClose }: { context: UiPluginContext; repo: Repo; onClose(): void }) {
  return (
    <NameForm
      title="New Group"
      submitLabel="Create"
      initial=""
      hint={`${repoLabel(repo)} moves into the new group.`}
      onClose={onClose}
      onSubmit={(name) =>
        changeGroup(context, 'Could not create group', async () => {
          const created = (await context.call('quirky.repo/groupCreate', { name })) as ProjectGroup
          await context.call('quirky.repo/groupAdd', { group: created.id, repo: repo.id })
        })
      }
    />
  )
}

export function RenameGroupDialog({ context, group, onClose }: { context: UiPluginContext; group: ProjectGroup; onClose(): void }) {
  return (
    <NameForm
      title="Rename Group"
      submitLabel="Rename"
      initial={group.name}
      onClose={onClose}
      onSubmit={(name) =>
        name === group.name ? Promise.resolve(true) : changeGroup(context, 'Could not rename group', () => context.call('quirky.repo/groupRename', { group: group.id, name }))
      }
    />
  )
}

export function DeleteGroupDialog({ context, group, onClose }: { context: UiPluginContext; group: ProjectGroup; onClose(): void }) {
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<LedgerRemovalPreview[] | null>()
  const [previewError, setPreviewError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let live = true
    setPreview(undefined)
    setPreviewError('')
    previewLedgerRemoval(context, { groupIds: [group.id] })
      .then((result) => { if (live) setPreview(result) })
      .catch((error: unknown) => { if (live) setPreviewError(error instanceof Error ? error.message : String(error)) })
    return () => { live = false }
  }, [context, group.id, retry])

  const remove = async () => {
    if (preview === undefined || previewError) return
    setBusy(true)
    const expectedLedgers = expectedLedgerSnapshots(preview)
    const ok = await changeGroup(context, 'Could not delete group', () => context.call('quirky.repo/groupDelete', {
      group: group.id,
      ...(expectedLedgers === undefined ? {} : { expectedLedgers })
    }))
    setBusy(false)
    if (ok) onClose()
    else setRetry((value) => value + 1)
  }
  const retention = ledgerRetentionNotice(preview ?? null)
  return (
    <Dialog title="Delete Group" onClose={onClose}>
      <p className="dialog-message">{`Delete the group ${group.name}? Projects in this group stay in Quirky.`}</p>
      {retention && <p className="dialog-message">{retention}</p>}
      {preview === undefined && !previewError && <p className="muted">Checking retained ledger records…</p>}
      {previewError && <p className="error" role="alert">Could not check retained ledger records: {previewError} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" autoFocus disabled={busy || preview === undefined || Boolean(previewError)} onClick={() => void remove()}>
          Delete Group
        </button>
      </div>
    </Dialog>
  )
}
