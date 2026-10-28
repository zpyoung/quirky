import type { PluginContext } from '@quirky/protocol'

const WORKTREES = [
  { id: 'wt1', repoId: 'repo-a', status: 'todo', kind: 'git', branch: 'main', head: 'a'.repeat(40) },
  { id: 'wt2', repoId: 'repo-b', status: 'in-review', kind: 'git', branch: 'feature', head: 'b'.repeat(40) },
  { id: 'wt3', repoId: 'repo-c', status: 'todo', kind: 'git', branch: 'unavailable', head: 'c'.repeat(40) }
]


const NAMES: Record<string, string> = { wt1: 'main', wt2: 'feature' }

/** Stand-in for quirky.worktree that resolves `id:wt1` and `id:wt2` only. */
export function activate(context: PluginContext): void {
  let gate: { entered: Promise<void>; released: Promise<void>; signalEntered: () => void; release: () => void } | null = null

  context.provide('method:quirky.worktree/testHoldResolve', () => {
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    gate = {
      entered: entered.promise,
      released: released.promise,
      signalEntered: () => entered.resolve(),
      release: () => released.resolve()
    }
    return true
  })
  context.provide('method:quirky.worktree/testWaitResolve', async () => {
    const current = gate
    if (!current) return false
    await current.entered
    return true
  })
  context.provide('method:quirky.worktree/testReleaseResolve', () => {
    const current = gate
    gate = null
    if (!current) return false
    current.release()
    return true
  })
  context.provide('method:quirky.worktree/resolve', async (params: Record<string, unknown>) => {
    const current = gate
    if (current) {
      current.signalEntered()
      await current.released
    }
    const id = String(params.selector).replace(/^id:/, '')
    const name = NAMES[id]
    if (!name) throw context.error('not-found', `no worktree matches ${params.selector}`)
    return { id, repoId: 'r1', path: `/fake/alpha/${name}`, branch: name, head: 'abc', isMain: id === 'wt1', name }
  })
  context.provide('method:quirky.worktree/list', (params: Record<string, unknown>) => {
    const repo = params.repo
    return typeof repo === 'string' ? WORKTREES.filter((worktree) => worktree.repoId === repo) : WORKTREES
  })
}
