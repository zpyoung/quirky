import type { PluginContext, Worktree } from '@quirky/protocol'

type FakeWorld = {
  worktree: Worktree
  resolveWorktree(params: Record<string, unknown>, context: Pick<PluginContext, 'error'>): Worktree
}
type TestGlobals = typeof globalThis & { __structuredFakes?: FakeWorld }

const globals = globalThis as TestGlobals

function world(): FakeWorld {
  const value = globals.__structuredFakes
  if (!value) throw new Error('owner acceptance fixture world is unavailable')
  return value
}

export function activate(context: PluginContext): void {
  context.provide('method:quirky.worktree/resolve', (params: Record<string, unknown>) =>
    world().resolveWorktree(params, context))

  context.provide('method:quirky.worktree/list', (params: { repo?: string; group?: string }) => {
    const worktree = world().worktree
    if (typeof params.repo === 'string' && params.repo !== worktree.repoId) return []
    if (typeof params.group === 'string') return []
    return [worktree]
  })
}
