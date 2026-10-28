import type { PluginContext, QuirkyEvent, Session } from '@quirky/protocol'

/** Test operations for the session pointer's structured lease boundary. */
export function activate(context: PluginContext): void {
  const leases = new Map<string, { env: Record<string, string>; release(): void }>()
  const pointerSends: Record<string, unknown>[] = []
  const sessionOf = async (params: Record<string, unknown>): Promise<Session> =>
    (await context.call('quirky.session/register', {
      worktree: params.worktree ?? 'id:wt_main',
      cwd: params.cwd,
      agent: 'claude',
      kind: 'structured',
      title: 'Pointer'
    })) as Session

  context.provide('method:quirky.structured/create', async (params: Record<string, unknown>) =>
    context.call('quirky.session/register', {
      ...(params.worktree === undefined ? {} : { worktree: params.worktree }),
      agent: params.agent,
      kind: 'structured',
      title: 'Claude'
    })
  )
  context.provide('method:quirky.structured/resume', async (params: Record<string, unknown>) => {
    const old = (await context.call('quirky.session/get', { session: params.session })) as Session
    const providerSession = old.providerSession
    if (!providerSession) throw context.error('conflict', `session ${old.id} has no provider session`)
    const session = (await context.call('quirky.session/register', {
      worktree: old.worktreeId,
      cwd: old.cwd,
      resumedFrom: old.id,
      agent: old.agent,
      kind: 'structured',
      title: old.title
    })) as Session
    const lease = context.launch.openStructuredLease({
      sessionId: session.id,
      worktreeId: session.worktreeId,
      agent: session.agent
    })
    leases.set(session.id, lease)
    await context.call('quirky.session/setStatus', { session: session.id, status: 'running' })
    return context.call('quirky.session/setProviderSession', {
      session: session.id,
      id: providerSession.id,
      ...(providerSession.transcriptPath === null ? {} : { transcriptPath: providerSession.transcriptPath })
    })
  })

  context.provide('method:quirky.structured/pointerSession', async (params: Record<string, unknown>) => {
    const session = await sessionOf(params)
    const lease = context.launch.openStructuredLease({
      sessionId: session.id,
      worktreeId: session.worktreeId,
      agent: session.agent
    })
    leases.set(session.id, lease)
    await context.call('quirky.session/setStatus', {
      session: session.id,
      status: typeof params.status === 'string' ? params.status : 'running'
    })
    return session
  })
  context.provide('method:quirky.structured/send', (params: Record<string, unknown>) => {
    pointerSends.push(params)
    return { ok: true }
  })
  context.provide('method:quirky.structured/pointerSends', () => pointerSends)
  context.provide('method:quirky.structured/stop', async (params: Record<string, unknown>) => {
    const session = typeof params.session === 'string' ? params.session : ''
    const identity = session ? context.launch.sessionIdentity(session) : null
    const lease = leases.get(session)
    const expectedIncarnation = params.expectedIncarnation
    if (typeof expectedIncarnation === 'string') {
      if (!identity || !lease) return { ok: false, reason: 'recipient_gone' }
      if (identity.processIncarnation !== expectedIncarnation) return { ok: false, reason: 'recipient_changed' }
    }
    lease?.release()
    leases.delete(session)
    await context.call('quirky.session/setStatus', { session, status: 'exited' })
    return typeof expectedIncarnation === 'string'
      ? { ok: true, closed: true, sessionId: session, processIncarnation: expectedIncarnation }
      : { ok: true }
  })
  context.subscribe((event: QuirkyEvent) => {
    if (event.type !== 'quirky.session/removed' || typeof event.data !== 'object' || event.data === null) return
    if (!('sessionId' in event.data) || typeof event.data.sessionId !== 'string') return
    const sessionId = event.data.sessionId
    leases.get(sessionId)?.release()
    leases.delete(sessionId)
  })
}
