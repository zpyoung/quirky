import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Worktree } from '../../shared/worktree/types'

type LinkedWorkItemMetadata = Pick<
  Worktree,
  | 'linkedGitLabMR'
  | 'linkedGitLabIssue'
  | 'linkedWorkItem'
  | 'linkedItems'
  | 'linkedTaskSourceContext'
>

export function getLinkedWorkItemMetadata(meta: WorktreeMeta | undefined): LinkedWorkItemMetadata {
  return {
    linkedGitLabMR: meta?.linkedGitLabMR ?? null,
    linkedGitLabIssue: meta?.linkedGitLabIssue ?? null,
    linkedWorkItem: meta?.linkedWorkItem ?? null,
    ...(meta?.linkedItems !== undefined ? { linkedItems: meta.linkedItems } : {}),
    linkedTaskSourceContext: meta?.linkedTaskSourceContext ?? null
  }
}
