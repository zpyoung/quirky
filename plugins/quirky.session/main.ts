import type { PluginContext } from '@quirky/protocol'
import { SessionRecords, sessionMigrations } from './src/records'
import { SessionService } from './src/sessions'

export async function activate(context: PluginContext): Promise<void> {
  const records = new SessionRecords(context.openStore(sessionMigrations(context.home)))
  const sessions = new SessionService(context, records)

  const methods = {
    list: sessions.list,
    get: sessions.get,
    create: sessions.create,
    resume: sessions.resume,
    setName: sessions.setName,
    setProviderSession: sessions.setProviderSession,
    register: sessions.register,
    close: sessions.close,
    setStatus: sessions.setStatus,
    restore: sessions.restore
  }
  for (const [name, handler] of Object.entries(methods)) context.provide(`method:${context.pluginId}/${name}`, handler)

  context.pty.onExit(
    (sessionId, exitCode, { exitSignal, exitCause }) =>
      void sessions.finish(sessionId, { exitCode, exitSignal, exitCause, restorable: exitCause === 'host-restart' })
  )
  context.pty.onReconnect(() => void sessions.reconcile({ startup: false }))
  await sessions.reconcile({ startup: true })
}
