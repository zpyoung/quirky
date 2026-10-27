import { useState } from 'react'
import type { Repo, Session, UiPluginContext, Worktree } from '@quirky/protocol'
import { removeProject } from './actions'
import { Dialog } from './Dialog'
import { repoLabel } from './report'

type Props = {
  context: UiPluginContext
  repo: Repo
  worktrees: Worktree[]
  /** Null while `quirky.session` is off, in which case there is nothing to close. */
  sessions: Session[] | null
  onClose(): void
}

/** Confirms forgetting a project, saying how many open terminals go with it. */
export function RemoveProjectDialog({ context, repo, worktrees, sessions, onClose }: Props) {
  const [busy, setBusy] = useState(false)
  const ids = new Set(worktrees.filter((w) => w.repoId === repo.id).map((w) => w.id))
  const terminals = (sessions ?? []).filter((s) => s.worktreeId !== null && ids.has(s.worktreeId)).length
  const name = repoLabel(repo)

  const remove = async () => {
    setBusy(true)
    const ok = await removeProject(context, repo.id)
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Dialog title="Remove Project" onClose={onClose}>
      <p className="dialog-message">
        {`This only removes ${name} from Quirky. It is still on your disk.`}
        {terminals > 0 && ` ${terminals} open ${terminals === 1 ? 'terminal' : 'terminals'} in this project will be closed.`}
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" autoFocus disabled={busy} onClick={() => void remove()}>
          Remove
        </button>
      </div>
    </Dialog>
  )
}
