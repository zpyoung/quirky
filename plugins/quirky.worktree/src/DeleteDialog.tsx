import { useEffect, useState } from 'react'
import type { UiPluginContext, Worktree } from '@quirky/protocol'
import { Dialog } from './Dialog'

type Props = {
  context: UiPluginContext
  worktree: Worktree
  /** Present when the delete takes the workspaces nested below it too. */
  descendants?: Worktree[]
  onConfirm(options: { dontAskAgain: boolean }): void
  onClose(): void
}

const changeLabel = (count: number) => `${count} uncommitted or untracked ${count === 1 ? 'change' : 'changes'}`

/** The count of changed files in a Git workspace; null for a folder workspace or when git can't say. */
async function changedFiles(context: UiPluginContext, worktree: Worktree): Promise<number | null> {
  if (worktree.kind === 'folder') return null
  try {
    const status = (await context.call('quirky.git/status', { worktree: worktree.id })) as { files: unknown[] }
    return status.files.length
  } catch {
    return null
  }
}

/** Warns what deleting a workspace discards, with the option to stop asking. */
export function DeleteDialog({ context, worktree, descendants, onConfirm, onClose }: Props) {
  const [changes, setChanges] = useState<number | null>(null)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  useEffect(() => {
    let live = true
    void changedFiles(context, worktree).then((count) => live && setChanges(count))
    return () => {
      live = false
    }
    // the count is for this workspace; a reload handing back a fresh object must not refetch
  }, [context, worktree.id])

  return (
    <Dialog title="Delete Workspace" onClose={onClose}>
      <p className="dialog-message">
        {`Remove ${worktree.name} from git and delete its workspace folder. Any uncommitted or untracked changes in Git workspaces will be permanently deleted.`}
      </p>
      <p className="delete-path">
        <code>{worktree.path}</code>
      </p>
      {changes !== null && changes > 0 && <p className="delete-changes">{changeLabel(changes)}</p>}
      {descendants && descendants.length > 0 && (
        <div className="delete-descendants">
          <p className="dialog-message">Child workspaces will be deleted</p>
          <ul className="delete-children">
            {descendants.map((child) => (
              <li key={child.id}>{child.name}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="dialog-actions dialog-actions-spread">
        <label className="check-row">
          <input type="checkbox" checked={dontAskAgain} onChange={(event) => setDontAskAgain(event.target.checked)} />
          <span>Don't ask again</span>
        </label>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" autoFocus onClick={() => onConfirm({ dontAskAgain })}>
          Delete Workspace
        </button>
      </div>
    </Dialog>
  )
}
