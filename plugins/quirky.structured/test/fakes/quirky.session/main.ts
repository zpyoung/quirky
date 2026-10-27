export function activate(context: any) {
  const world = (globalThis as any).__structuredFakes
  world.emitRemoved = (sessionId: string) => context.emit('removed', { sessionId })
  for (const name of ['register', 'setStatus', 'get', 'list', 'close']) {
    context.provide(`method:quirky.session/${name}`, (params: any) => world.session[name](params, context))
  }
}
