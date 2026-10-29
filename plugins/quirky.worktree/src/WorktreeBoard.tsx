import { FormRow, ListRow, SectionHeader } from '@quirky/ui'
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
    <section className="worktree-board ui-cluster" aria-label="Workspace board">
      {statuses.map((status) => (
        <section className="worktree-board-column ui-stack ui-grow" key={status.id} aria-label={`${status.label} workspaces`}>
          <SectionHeader title={`${status.icon ? `${status.icon} ` : ''}${status.label}`} />
          <ul className="worktree-list ui-tree">
            {worktrees.filter((worktree) => worktree.status === status.id).map((worktree) => {
              const selectId = `worktree-status-${worktree.id}`
              return (
                <li className="worktree-board-card ui-tree-item" key={worktree.id}>
                  <ListRow
                    title={worktree.name}
                    mainLabel={`Open ${worktree.name}`}
                    onClick={() => open(worktree)}
                    trailing={
                      <FormRow label="Move to status" htmlFor={selectId}>
                        <select
                          id={selectId}
                          className="ui-text-field__input"
                          aria-label={`Move ${worktree.name} to status`}
                          value={status.id}
                          onChange={(event) => setStatus(worktree, event.currentTarget.value)}
                        >
                          {statuses.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.icon ? `${candidate.icon} ` : ''}{candidate.label}
                            </option>
                          ))}
                        </select>
                      </FormRow>
                    }
                  />
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </section>
  )
}
