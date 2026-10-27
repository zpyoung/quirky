export function activate(context: any) {
  const world = (globalThis as any).__structuredFakes
  context.provide('method:quirky.agents/resolveLaunch', (params: any) => world.agents.resolveLaunch(params, context))
}
