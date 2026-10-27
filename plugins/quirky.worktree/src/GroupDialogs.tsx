import { useState, type FormEvent } from 'react'
import type { ProjectGroup, Repo, UiPluginContext } from '@quirky/protocol'
import { changeGroup } from './actions'
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
  const remove = async () => {
    setBusy(true)
    const ok = await changeGroup(context, 'Could not delete group', () => context.call('quirky.repo/groupDelete', { group: group.id }))
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Dialog title="Delete Group" onClose={onClose}>
      <p className="dialog-message">{`Delete the group ${group.name}? Projects in this group stay in Quirky.`}</p>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" autoFocus disabled={busy} onClick={() => void remove()}>
          Delete Group
        </button>
      </div>
    </Dialog>
  )
}
