import { useState, type FormEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { addProject, importFolder, scanFolder } from './actions'
import { Dialog } from './Dialog'
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
      <Dialog title="Import repositories" onClose={onClose}>
        <p className="dialog-message">{`Found ${count} ${count === 1 ? 'repository' : 'repositories'} in ${folder}`}</p>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault()
            if (name) void finish(() => importFolder(context, folder, name))
          }}
        >
          <p className="dialog-message">Group these repositories?</p>
          <label>
            <span>Group name</span>
            <input autoFocus value={group} onChange={(event) => setGroup(event.target.value)} />
          </label>
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="button" disabled={busy} onClick={() => void finish(() => importFolder(context, folder))}>
              No, import separately
            </button>
            <button type="submit" className="primary" disabled={busy || !name}>
              Yes, import as group
            </button>
          </div>
        </form>
      </Dialog>
    )
  }

  if (step.kind === 'folder') {
    const folder = step.path
    return (
      <Dialog title="Open as Folder" onClose={onClose}>
        <p className="dialog-message">
          This folder isn't a Git repository. You'll have the editor, terminal, and search, but Git-based features won't be available.
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            autoFocus
            disabled={busy}
            onClick={() => void finish(async () => (await addProject(context, folder, true)) === 'added')}
          >
            Open as Folder
          </button>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title="Add project" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          <span>Path</span>
          <input autoFocus value={path} onChange={(event) => setPath(event.target.value)} placeholder="/path/to/repository" />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !path.trim()}>
            Add
          </button>
        </div>
      </form>
    </Dialog>
  )
}
