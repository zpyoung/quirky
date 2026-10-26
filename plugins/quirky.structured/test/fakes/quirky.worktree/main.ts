export function activate(context: any) {
  const world = (globalThis as any).__structuredFakes
  context.provide('method:quirky.worktree/resolve', (params: any) => world.resolveWorktree(params, context))
}
