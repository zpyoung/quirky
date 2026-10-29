import { useState, type FormEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Button, Dialog, TextField } from '@quirky/ui'
import { addProject, FolderPickerUnavailableError, importFolder, messageOf, pickNativeFolder, scanFolder } from './actions'
import type { DialogState } from './report'

type Props = {
  context: UiPluginContext
  onClose(): void
  /** Tells the section which question is showing, for `ui state`. */
  onStep(dialog: DialogState): void
}

type Step =
  | { kind: 'path' }
  | { kind: 'import'; path: string; count: number }
  | { kind: 'folder'; path: string }

const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path

/**
 * Adds a project from a path. A path that is not a repository leads to one of two questions: a
 * folder holding repositories is offered as a group to import, anything else as a plain folder.
 */
export function AddProjectDialog({ context, onClose, onStep }: Props) {
  const [step, setStep] = useState<Step>({ kind: 'path' })
  const [path, setPath] = useState('')
  const [group, setGroup] = useState('')
  const [busy, setBusy] = useState(false)
  const browse = async () => {
    setBusy(true)
    try {
      const selected = await pickNativeFolder(context, 'Choose project folder', path.trim() || undefined)
      if (selected !== null) setPath(selected)
    } catch (error) {
      context.toast(
        error instanceof FolderPickerUnavailableError ? 'Native folder picker unavailable' : 'Could not choose project folder',
        messageOf(error)
      )
    } finally {
      setBusy(false)
    }
  }

  const next = (value: Step) => {
    setStep(value)
    switch (value.kind) {
      case 'path':
        return onStep({ kind: 'add-project' })
      case 'import':
        return onStep({ kind: 'import', path: value.path })
      case 'folder':
        return onStep({ kind: 'open-as-folder', path: value.path })
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const typed = path.trim()
    if (!typed) return
    setBusy(true)
    const outcome = await addProject(context, typed)
    if (outcome === 'added') return onClose()
    if (outcome === 'not-a-repository') {
      const count = await scanFolder(context, typed)
      if (count === null) setBusy(false)
      else if (count > 0) {
        setGroup(basename(typed))
        next({ kind: 'import', path: typed, count })
      } else next({ kind: 'folder', path: typed })
    }
    setBusy(false)
  }

  const finish = async (run: () => Promise<boolean>) => {
    setBusy(true)
    const ok = await run()
    setBusy(false)
    if (ok) onClose()
  }

  if (step.kind === 'import') {
    const { path: folder, count } = step
    const name = group.trim()
    return (
      <Dialog open title="Import repositories" onClose={onClose}>
        <p className="ui-text-muted">{`Found ${count} ${count === 1 ? 'repository' : 'repositories'} in ${folder}`}</p>
        <form
          className="ui-stack"
          onSubmit={(event) => {
            event.preventDefault()
            if (name) void finish(() => importFolder(context, folder, name))
          }}
        >
          <p className="ui-text-muted">Group these repositories?</p>
          <TextField label="Group name" id="add-project-group-name" autoFocus value={group} onChange={(event) => setGroup(event.target.value)} />
          <div className="ui-actions">
            <Button type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" disabled={busy} onClick={() => void finish(() => importFolder(context, folder))}>
              No, import separately
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !name}>
              Yes, import as group
            </Button>
          </div>
        </form>
      </Dialog>
    )
  }

  if (step.kind === 'folder') {
    const folder = step.path
    return (
      <Dialog open title="Open as Folder" onClose={onClose}>
        <p className="ui-text-muted">
          This folder isn't a Git repository. You'll have the editor, terminal, and search, but Git-based features won't be available.
        </p>
        <div className="ui-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            autoFocus
            disabled={busy}
            onClick={() => void finish(async () => (await addProject(context, folder, true)) === 'added')}
          >
            Open as Folder
          </Button>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog open title="Add project" onClose={onClose}>
      <form className="ui-stack" onSubmit={submit}>
        <TextField
          label="Path"
          id="add-project-path"
          autoFocus
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/path/to/repository"
        />
        <div className="ui-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={() => void browse()}>
            Browse
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !path.trim()}>
            Add
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
