import type { PluginContext, Worktree } from '@quirky/protocol'

const head = 'a'.repeat(40)

function fixture(fields: Pick<Worktree, 'id' | 'repoId' | 'path' | 'branch' | 'isMain' | 'name'>): Worktree {
  return {
    ...fields,
    head,
    kind: 'git',
    displayName: null,
    comment: '',
    status: 'todo',
    pinned: false,
    unread: false,
    parentId: null,
    createdAt: 0,
    createdBy: 'external',
    baseRef: null,
    keepBranch: false,
    removing: false,
    groupId: null
  }
}

/** The worktrees the terminal tests use; `wt_main` and `wt_other` share a repo, `wt_beta` has its own. */
export const WORKTREES: Worktree[] = [
  fixture({ id: 'wt_main', repoId: 'repo_alpha', path: '/fake/alpha', branch: 'main', isMain: true, name: 'main' }),
  fixture({ id: 'wt_other', repoId: 'repo_alpha', path: '/fake/other', branch: 'other', isMain: false, name: 'other' }),
  fixture({ id: 'wt_beta', repoId: 'repo_beta', path: '/fake/beta', branch: 'main', isMain: true, name: 'beta' })
]

/** Stands in for `quirky.worktree/resolve`: a selector is `current`, `id:`, `name:` or a bare ID or name. */
export function activate(context: PluginContext): void {
  context.provide('method:quirky.worktree/resolve', (params: Record<string, unknown>) => {
    const selector = params.selector as string
    let found: Worktree[]
    if (selector === 'current' || selector === 'active') found = WORKTREES.filter((w) => w.id === params.worktreeId)
    else if (selector.startsWith('id:')) found = WORKTREES.filter((w) => w.id === selector.slice(3))
    else if (selector.startsWith('name:')) found = WORKTREES.filter((w) => w.name === selector.slice(5))
    else found = WORKTREES.filter((w) => w.id === selector || w.name === selector)
    if (found.length === 0) throw context.error('not-found', `no worktree matches ${selector}; use id:, name:, branch:, path: or current`)
    return found[0]
  })
}
