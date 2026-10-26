import type { PluginContext, Session } from '@quirky/protocol'

/** In-memory stand-in for quirky.session: records every setStatus call and emits `changed` like the real one. */
export function activate(context: PluginContext): void {
  const sessions = new Map<string, Session>()
  const setStatusCalls: { session: string; status: string }[] = []

  context.provide('method:quirky.session/seed', (params: Record<string, unknown>) => {
    const session = params as unknown as Session
    sessions.set(session.id, session)
    return session
  })
  context.provide('method:quirky.session/list', (params: Record<string, unknown>) =>
    [...sessions.values()].filter((s) => params.worktree === undefined || s.worktreeId === params.worktree)
  )
  context.provide('method:quirky.session/get', (params: Record<string, unknown>) => {
    const session = sessions.get(String(params.session))
    if (!session) throw context.error('not-found', `no session ${params.session}`)
    return session
  })
  context.provide('method:quirky.session/setStatus', (params: Record<string, unknown>) => {
    const session = sessions.get(String(params.session))
    if (!session) throw context.error('not-found', `no session ${params.session}`)
    setStatusCalls.push({ session: session.id, status: String(params.status) })
    const updated = { ...session, status: params.status as Session['status'], lastActivityAt: Date.now() }
    const changed = updated.status !== session.status
    sessions.set(session.id, updated)
    if (changed) context.emit('changed', { session: updated })
    return updated
  })
  context.provide('method:quirky.session/calls', () => setStatusCalls)
  context.provide('method:quirky.session/create', async (params: Record<string, unknown>) => {
    const worktreeId = String(params.worktree)
    return context.launch.hooks({
      sessionId: 's_new',
      worktreeId,
      repoId: 'r1',
      cwd: '/fake/alpha',
      agent: String(params.agent),
      ...(typeof params.prompt === 'string' ? { prompt: params.prompt } : {})
    })
  })
  context.provide('method:quirky.session/remove', (params: Record<string, unknown>) => {
    sessions.delete(String(params.session))
    context.emit('removed', { sessionId: params.session })
    return true
  })
}
