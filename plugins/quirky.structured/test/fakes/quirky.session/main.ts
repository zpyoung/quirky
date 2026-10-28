import type { PluginCaller } from '@quirky/protocol'
export function activate(context: any) {
  const world = (globalThis as any).__structuredFakes
  world.emitRemoved = (sessionId: string) => context.emit('removed', { sessionId })
  for (const name of ['register', 'setStatus', 'setProviderSession', 'get', 'list', 'close']) {
    context.provide(`method:quirky.session/${name}`, (params: any) => world.session[name](params, context))
  }
  context.provide('method:quirky.session/identity', (params: Record<string, unknown>) => {
    if (typeof params.session !== 'string') throw context.error('invalid-params', 'session must be a string')
    const session = world.session.get({ session: params.session }, context)
    const identity = context.launch.sessionIdentity(session.id)
    if (!identity) throw context.error('not-found', `session ${session.id} has no live identity`)
    return {
      ...identity,
      kind: session.kind,
      providerId: session.agent === 'shell' ? null : session.agent,
      worktreeId: session.worktreeId
    }
  })
  context.provide('method:quirky.session/callerAuthority', (_params: Record<string, unknown>, caller: PluginCaller) =>
    caller.role === 'plugin' ? {} : (caller.sessionAuthority ?? {})
  )
}
