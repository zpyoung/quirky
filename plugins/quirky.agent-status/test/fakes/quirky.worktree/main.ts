import type { PluginContext } from '@quirky/protocol'

const NAMES: Record<string, string> = { wt1: 'main', wt2: 'feature' }

/** Stand-in for quirky.worktree that resolves `id:wt1` and `id:wt2` only. */
export function activate(context: PluginContext): void {
  context.provide('method:quirky.worktree/resolve', (params: Record<string, unknown>) => {
    const id = String(params.selector).replace(/^id:/, '')
    const name = NAMES[id]
    if (!name) throw context.error('not-found', `no worktree matches ${params.selector}`)
    return { id, repoId: 'r1', path: `/fake/alpha/${name}`, branch: name, head: 'abc', isMain: id === 'wt1', name }
  })
}
