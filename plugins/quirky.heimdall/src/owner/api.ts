import type { PluginContext } from '@quirky/protocol'
import type { KernelStore, Runner } from '../contracts'
import type { OwnerController } from './contracts'

export interface OwnerApiHost {
  store: KernelStore
  runner(watcherId: string): Runner | undefined
  changed(watcherId: string): void
}

export function provideOwnerMethods(context: PluginContext, host: OwnerApiHost, controller: OwnerController): void {
  context.provide('method:quirky.heimdall/ownerInspect', (params: Record<string, unknown>) => {
    if (typeof params.watcherId !== 'string' || !host.store.get(params.watcherId)) throw context.error('not-found', 'watcher not found')
    return controller.inspect(params.watcherId)
  })
  context.provide('method:quirky.heimdall/ownerReady', async (params: Record<string, unknown>) => {
    const watcherId = params.watcherId
    const reportKey = params.reportKey
    if (typeof watcherId !== 'string' || typeof reportKey !== 'string' || reportKey.length === 0 || reportKey.length > 128) throw context.error('invalid-params', 'watcherId and an issued reportKey of at most 128 characters are required')
    if (!host.store.get(watcherId)) throw context.error('not-found', 'watcher not found')
    const runner = host.runner(watcherId)
    if (!runner?.withControl) return { kind: 'refused', reason: 'watcher-not-executable' }
    const result = await runner.withControl(async () => {
      const current = host.store.get(watcherId)
      if (!current || current.terminalAtMs !== null) return { kind: 'refused' as const, reason: 'watcher-terminal-or-removed' }
      if (!current.owner) return { kind: 'refused' as const, reason: 'owner-not-configured' }
      return controller.ready(watcherId, reportKey)
    }, true)
    if (result.kind === 'accepted') {
      // The control barrier suppresses scheduling while held; wake only after it has released.
      runner.schedule(0)
      host.changed(watcherId)
    }
    return result
  })
}
