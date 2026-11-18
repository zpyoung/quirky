import { FormRow, ListRow, SectionHeader } from '@quirky/ui'
import type { Repo, Worktree } from '@quirky/protocol'
import { repoLabel } from './report'
import type { WorktreeStatusDefinition } from './parity-types'

type WorktreeBoardBaseProps = {
  worktrees: Worktree[]
  statuses: WorktreeStatusDefinition[]
  repos: Repo[]
}

export type WorktreeBoardProps = WorktreeBoardBaseProps & (
  | { open(worktree: Worktree): void; setStatus(worktree: Worktree, status: string): void; onOpen?: (worktree: Worktree) => void; onSetStatus?: (worktree: Worktree, status: string) => void }
  | { onOpen(worktree: Worktree): void; onSetStatus(worktree: Worktree, status: string): void; open?: (worktree: Worktree) => void; setStatus?: (worktree: Worktree, status: string) => void }
)

export function WorktreeBoard(props: WorktreeBoardProps) {
  const { worktrees, statuses, repos } = props
  const onOpenWorktree = props.onOpen ?? props.open!
  const onStatusChange = props.onSetStatus ?? props.setStatus!
  const reposById = new Map(repos.map((repo) => [repo.id, repo] as const))
  return (
    <section className="worktree-tree-board ui-cluster" aria-label="Workspace board">
      {statuses.map((status) => (
        <section className="worktree-tree-board-column ui-stack" key={status.id} aria-label={`${status.label} workspaces`}>
          <SectionHeader title={`${status.icon ? `${status.icon} ` : ''}${status.label}`} />
          <ul className="worktree-list ui-tree">
            {worktrees.filter((worktree) => worktree.status === status.id).map((worktree) => {
              const repo = reposById.get(worktree.repoId)
              const projectName = repo ? repoLabel(repo) : worktree.repoId
              const selectId = `worktree-status-${worktree.id}`
              return (
                <li className="worktree-board-card ui-tree-item" key={worktree.id}>
                  <ListRow
                    title={worktree.name}
                    description={<span className="ui-text-ellipsis" title={projectName}>{projectName}</span>}
                    mainLabel={`Open ${worktree.name} in ${projectName}`}
                    onClick={() => onOpenWorktree(worktree)}
                    trailing={
                      <FormRow label="Move to status" htmlFor={selectId}>
                        <select
                          id={selectId}
                          className="ui-text-field__input"
                          aria-label={`Move ${worktree.name} in ${projectName} to status`}
                          value={status.id}
                          onChange={(event) => onStatusChange(worktree, event.currentTarget.value)}
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
