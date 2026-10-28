import type { PluginCaller, PluginContext, Session } from '@quirky/protocol'
import { SessionRecords, sessionMigrations } from './src/records'
import { SessionService } from './src/sessions'

/** Launch plans contain environment credentials; only trusted local consumers receive them. */
function withoutLaunch(session: Session): Session {
  const { launch: _launch, ...visible } = session
  return visible
}

function sessionForCaller(result: Session | Promise<Session>, caller: PluginCaller): Session | Promise<Session> {
  if (caller.role !== 'mobile') return result
  return result instanceof Promise ? result.then(withoutLaunch) : withoutLaunch(result)
}

export async function activate(context: PluginContext): Promise<void> {
  const records = new SessionRecords(context.openStore(sessionMigrations(context.home)))
  const sessions = new SessionService(context, records)

  const methods = {
    list: (params: Record<string, unknown>, caller: PluginCaller) => {
      const result = sessions.list(params, caller)
      return caller.role === 'mobile' ? result.then((rows) => rows.map(withoutLaunch)) : result
    },
    get: (params: Record<string, unknown>, caller: PluginCaller) => sessionForCaller(sessions.get(params), caller),
    identity: sessions.identity,
    pointer: sessions.pointer,
    create: (params: Record<string, unknown>, caller: PluginCaller) => sessionForCaller(sessions.create(params, caller), caller),
    resume: (params: Record<string, unknown>, caller: PluginCaller) => sessionForCaller(sessions.resume(params), caller),
    resumeExternal: sessions.resumeExternal,
    setName: (params: Record<string, unknown>, caller: PluginCaller) => sessionForCaller(sessions.setName(params), caller),
    setProviderSession: sessions.setProviderSession,
    register: sessions.register,
    close: sessions.close,
    setStatus: sessions.setStatus,
    setUnread: sessions.setUnread,
    setBadge: sessions.setBadge,
    restore: (params: Record<string, unknown>, caller: PluginCaller) => sessionForCaller(sessions.restore(params), caller)
  }
  for (const [name, handler] of Object.entries(methods)) context.provide(`method:${context.pluginId}/${name}`, handler)

  context.pty.onExit(
    (sessionId, exitCode, { exitSignal, exitCause }) =>
      void sessions.finish(sessionId, { exitCode, exitSignal, exitCause, restorable: exitCause === 'host-restart' })
  )
  context.pty.onReconnect(() => void sessions.reconcile({ startup: false }))
  await sessions.reconcile({ startup: true })
}
