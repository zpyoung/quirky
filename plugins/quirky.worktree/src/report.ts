import type { Repo, Session, Worktree } from '@quirky/protocol'
import { worktreeStatus, type DisplayStatus } from './status'

/** What the sidebar section reports to `ui.state`: the repos and worktrees it shows. */
export type WorktreesReport = {
  repos: {
    id: string
    name: string
    worktrees: {
      id: string
      name: string
      branch: string | null
      status: DisplayStatus | null
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
  selectedId: string | null
): WorktreesReport {
  return {
    repos: repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      worktrees: worktrees
        .filter((worktree) => worktree.repoId === repo.id)
        .map((worktree) => ({
          id: worktree.id,
          name: worktree.name,
          branch: worktree.branch,
          status: sessions === null ? null : worktreeStatus(sessions, worktree.id),
          selected: worktree.id === selectedId
        }))
    }))
  }
}
