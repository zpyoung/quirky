export function activate(context: any) {
  const git = (globalThis as any).__chatFakes.git
  context.provide('method:quirky.git/snapshotTree', (params: any) => git.snapshotTree(params, context))
  context.provide('method:quirky.git/treeChanges', (params: any) => git.treeChanges(params, context))
}
