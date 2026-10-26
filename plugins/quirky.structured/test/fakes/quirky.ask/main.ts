export function activate(context: any) {
  const world = (globalThis as any).__structuredFakes
  for (const name of ['create', 'wait', 'answer', 'cancel', 'list']) {
    context.provide(`method:quirky.ask/${name}`, (params: any) => world.ask[name](params, context))
  }
}
