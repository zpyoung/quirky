import { useEffect, useState } from 'react'
import type { UiPluginContext, Worktree } from '@quirky/protocol'
import { Badge, Button, Dialog } from '@quirky/ui'

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
    <Dialog open title="Delete Workspace" onClose={onClose}>
      <p className="ui-text-muted">
        {`Remove ${worktree.name} from git and delete its workspace folder. Any uncommitted or untracked changes in Git workspaces will be permanently deleted.`}
      </p>
      <p className="ui-text-mono">{worktree.path}</p>
      {changes !== null && changes > 0 && <Badge tone="failing">{changeLabel(changes)}</Badge>}
      {descendants && descendants.length > 0 && (
        <div className="ui-stack">
          <p className="ui-text-muted">Child workspaces will be deleted</p>
          <ul className="ui-tree">
            {descendants.map((child) => (
              <li className="ui-tree-item" key={child.id}>{child.name}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="ui-actions">
        <label className="ui-checkbox-label">
          <input type="checkbox" checked={dontAskAgain} onChange={(event) => setDontAskAgain(event.target.checked)} />
          <span>Don't ask again</span>
        </label>
        <Button type="button" autoFocus onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="destructive" onClick={() => onConfirm({ dontAskAgain })}>
          Delete Workspace
        </Button>
      </div>
    </Dialog>
  )
}
