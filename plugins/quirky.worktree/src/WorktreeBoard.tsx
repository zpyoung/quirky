import type { Worktree } from '@quirky/protocol'
import type { WorktreeStatusDefinition } from './parity-types'

export type WorktreeBoardProps = {
  worktrees: Worktree[]
  statuses: WorktreeStatusDefinition[]
  open(worktree: Worktree): void
  setStatus(worktree: Worktree, status: string): void
}

export function WorktreeBoard({ worktrees, statuses, open, setStatus }: WorktreeBoardProps) {
  return (
    <section className="worktree-board" aria-label="Workspace board">
      {statuses.map((status) => (
        <section className="worktree-board-column" key={status.id} aria-label={`${status.label} workspaces`} style={{ borderColor: status.color }}>
          <h3>{status.label}</h3>
          <ul className="worktree-list">
            {worktrees.filter((worktree) => worktree.status === status.id).map((worktree) => (
              <li className="worktree-board-card" key={worktree.id}>
                <button type="button" onClick={() => open(worktree)} aria-label={`Open ${worktree.name}`}>{worktree.name}</button>
                <label>
                  Move to status
                  <select aria-label={`Move ${worktree.name} to status`} value={status.id} onChange={(event) => setStatus(worktree, event.currentTarget.value)}>
                    {statuses.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
                  </select>
                </label>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  )
}
