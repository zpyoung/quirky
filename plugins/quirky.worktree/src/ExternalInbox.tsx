import type { Repo, UiPluginContext } from '@quirky/protocol'
import type { WorktreeControl } from './control-types'
import { repoLabel } from './report'
import { messageOf } from './actions'

type Props = { context: UiPluginContext; repos: Repo[]; worktrees: WorktreeControl[] }

export function ExternalInbox({ context, repos, worktrees }: Props) {
  const projects = repos.flatMap((repo) => {
    const hidden = worktrees.filter((worktree) =>
      worktree.repoId === repo.id && worktree.kind === 'git' && !worktree.isMain &&
      worktree.createdBy === 'external' && !worktree.externalVisible
    )
    if (hidden.length === 0 || hidden[0]!.externalInboxSuppressed) return []
    return [{ repo, worktrees: hidden }]
  })
  if (projects.length === 0) return null
  const update = async (repo: Repo, patch: Record<string, unknown>, title: string) => {
    try {
      await context.call('quirky.worktree/setProjectMetadata', { repo: repo.id, ...patch })
    } catch (error) {
      context.toast(title, messageOf(error))
    }
  }
  const suppress = async (repo: Repo) => {
    try {
      await context.call('quirky.worktree/suppressExternalInbox', { repo: repo.id, suppressed: true })
    } catch (error) {
      context.toast('Could not hide external worktree review', messageOf(error))
    }
  }
  return (
    <section className="external-worktree-inbox" aria-label="Hidden external worktrees">
      <h3>Hidden worktree groups</h3>
      {projects.map(({ repo, worktrees: hidden }) => (
        <section className="external-worktree-group" key={repo.id} aria-label={`Hidden external worktrees in ${repoLabel(repo)}`}>
          <p>Review {hidden.length} hidden external {hidden.length === 1 ? 'worktree' : 'worktrees'} in {repoLabel(repo)}</p>
          <ul>
            {hidden.map((worktree) => <li key={worktree.id}>{worktree.name} · {worktree.branch ?? 'detached'} · {worktree.path}</li>)}
          </ul>
          <button type="button" onClick={() => void update(repo, { externalVisibility: 'show' }, 'Could not show external worktrees')}>Show in worktree list</button>
          <button type="button" onClick={() => void update(repo, { externalVisibility: 'hide' }, 'Could not keep external worktrees hidden')}>Keep hidden</button>
          <button type="button" onClick={() => void suppress(repo)}>Don’t show again</button>
        </section>
      ))}
    </section>
  )
}
