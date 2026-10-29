import { useState, type FormEvent } from 'react'
import type { Repo, UiPluginContext, Worktree } from '@quirky/protocol'
import { Button, Dialog, FormRow } from '@quirky/ui'
import { setWorktree } from './actions'
import { workspaceOption } from './report'

type Props = { context: UiPluginContext; worktree: Worktree; worktrees: Worktree[]; repos: Repo[]; onClose(): void }

/** `worktree` and every workspace nested below it: none of them may become its parent. */
function selfAndDescendants(worktree: Worktree, worktrees: Worktree[]): Set<string> {
  const excluded = new Set([worktree.id])
  for (let grew = true; grew; ) {
    grew = false
    for (const other of worktrees) {
      if (other.parentId && excluded.has(other.parentId) && !excluded.has(other.id)) {
        excluded.add(other.id)
        grew = true
      }
    }
  }
  return excluded
}

/** Chooses the workspace `worktree` nests under. */
export function ParentDialog({ context, worktree, worktrees, repos, onClose }: Props) {
  const excluded = selfAndDescendants(worktree, worktrees)
  const candidates = worktrees.filter((w) => !excluded.has(w.id))
  const [parent, setParent] = useState(candidates[0]?.id ?? '')
  const [busy, setBusy] = useState(false)

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!parent) return
    setBusy(true)
    const ok = await setWorktree(context, worktree.id, { parent })
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <Dialog open title="Set parent worktree" onClose={onClose}>
      <form className="ui-stack" onSubmit={save}>
        <FormRow label="Parent worktree" htmlFor="worktree-parent">
          <select id="worktree-parent" autoFocus className="ui-text-field__input" value={parent} onChange={(event) => setParent(event.target.value)}>
            {candidates.map((w) => (
              <option key={w.id} value={w.id}>
                {workspaceOption(w, repos)}
              </option>
            ))}
          </select>
        </FormRow>
        <div className="ui-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !parent}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
