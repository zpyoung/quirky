import type { AgentDisplayState, Repo, Session, Worktree } from '@quirky/protocol'
import { worktreeGlyph, worktreeStatus, type DisplayStatus } from './status'

/**
 * What the sidebar section reports to `ui.state`: the repos and worktrees it shows. `status` is the
 * coarse one; `display` and `label` are present when an agent's display state is what the card draws.
 */
export type WorktreesReport = {
  repos: {
    id: string
    name: string
    worktrees: {
      id: string
      name: string
      branch: string | null
      status: DisplayStatus | null
      display?: AgentDisplayState
      label?: string
      selected: boolean
    }[]
  }[]
}

/**
 * The report for what the section shows. `sessions` is null when `quirky.session` is off, in which
 * case no worktree has a status.
 */
export function buildReport(
  repos: Repo[],
  worktrees: Worktree[],
  sessions: Session[] | null,
  selectedId: string | null,
  now: number = Date.now()
): WorktreesReport {
  return {
    repos: repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      worktrees: worktrees
        .filter((worktree) => worktree.repoId === repo.id)
        .map((worktree) => {
          const glyph = sessions === null ? null : worktreeGlyph(sessions, worktree.id, now)
          return {
            id: worktree.id,
            name: worktree.name,
            branch: worktree.branch,
            status: sessions === null ? null : worktreeStatus(sessions, worktree.id),
            ...(glyph?.kind === 'agent' ? { display: glyph.display, label: glyph.label } : {}),
            selected: worktree.id === selectedId
          }
        })
    }))
  }
}
