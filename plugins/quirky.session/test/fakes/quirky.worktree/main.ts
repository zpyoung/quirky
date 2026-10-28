import type { PluginContext, Worktree } from '@quirky/protocol'

const head = 'a'.repeat(40)

const WORKTREE_DEFAULTS = {
  kind: 'git',
  displayName: null,
  comment: '',
  status: 'in-progress',
  pinned: false,
  unread: false,
  parentId: null,
  createdAt: 0,
  createdBy: 'external',
  baseRef: null,
  keepBranch: false,
  removing: false,
  groupId: null,
  projectGroupId: null,
  lastActivityAt: 0
} as const

export const WORKTREES: Worktree[] = [
  { id: 'wt_main', repoId: 'repo_alpha', path: '/fake/alpha', branch: 'main', head, isMain: true, name: 'main', ...WORKTREE_DEFAULTS, instanceId: 'instance:wt_main' },
  { id: 'wt_other', repoId: 'repo_alpha', path: '/fake/other', branch: 'other', head, isMain: false, name: 'other', ...WORKTREE_DEFAULTS, instanceId: 'instance:wt_other' },
  { id: 'wt_beta', repoId: 'repo_beta', path: '/fake/beta', branch: 'main', head, isMain: true, name: 'main', ...WORKTREE_DEFAULTS, instanceId: 'instance:wt_beta' }
]

const contains = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`)

/** The fixed worktrees, plus `wt_real` when a test points `QUIRKY_TEST_REAL_WORKTREE` at a directory that exists. */
const worktrees = (): Worktree[] => {
  const real = process.env.QUIRKY_TEST_REAL_WORKTREE
  return real
    ? [...WORKTREES, { id: 'wt_real', repoId: 'repo_alpha', path: real, branch: 'real', head, isMain: false, name: 'real', ...WORKTREE_DEFAULTS, instanceId: 'instance:wt_real' }]
    : WORKTREES
}

// ids listed here stop resolving, as a worktree whose directory was deleted does
const vanished = () => (process.env.QUIRKY_TEST_VANISHED_WORKTREES ?? '').split(',')

/** Stands in for quirky.worktree/resolve with a fixed set of worktrees and the selector forms the real one accepts. */
export function activate(context: PluginContext): void {
  context.provide('method:quirky.worktree/resolve', (params: Record<string, unknown>) => {
    const selector = params.selector as string
    const matches = (predicate: (worktree: Worktree) => boolean) =>
      worktrees().filter((w) => !vanished().includes(w.id) && predicate(w))
    let found: Worktree[]
    if (selector === 'current' || selector === 'active') {
      const byId = matches((w) => w.id === params.worktreeId)
      found = byId.length > 0 ? byId : matches((w) => typeof params.cwd === 'string' && contains(w.path, params.cwd))
    } else if (selector.startsWith('id:')) found = matches((w) => w.id === selector.slice(3))
    else if (selector.startsWith('name:')) found = matches((w) => w.name === selector.slice(5))
    else if (selector.startsWith('branch:')) found = matches((w) => w.branch === selector.slice(7))
    else if (selector.startsWith('path:')) found = matches((w) => contains(w.path, selector.slice(5)))
    else {
      found = matches((w) => w.id === selector)
      if (found.length === 0) found = matches((w) => w.name === selector)
    }
    if (found.length === 0) {
      throw context.error('not-found', `no worktree matches ${selector}; use id:, name:, branch:, path: or current`)
    }
    if (found.length > 1) {
      throw context.error('conflict', `${selector} matches ${found.length} worktrees: ${found.map((w) => `id:${w.id}`).join(', ')}`)
    }
    return found[0]
  })
}
