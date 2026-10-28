import { describe, expect, test } from 'bun:test'
import type { PluginContext } from '@quirky/protocol'
import type { CommandResult, ControlPlane, FleetService, KernelControlHost } from '../src/control-contracts'
import { registerControlApi } from '../src/control-api'

describe('Heimdall control API', () => {
  test('returns an applied stop receipt while fleet publication is still pending', async () => {
    const handlers = new Map<string, (params: Record<string, unknown>) => unknown>()
    const events: string[] = []
    const logs: string[] = []
    const publish = Promise.withResolvers<void>()
    const context = {
      provide(id: string, handler: (params: Record<string, unknown>) => unknown) {
        handlers.set(id, handler)
      },
      error: (_code: string, message: string) => new Error(message),
      log: (message: string) => logs.push(message)
    } as unknown as PluginContext
    const host = { context } as KernelControlHost
    const result: CommandResult = { kind: 'applied', appliedAtMs: 123 }
    const controls = {
      command: async () => {
        events.push('applied')
        return result
      },
      pending: () => []
    } as unknown as ControlPlane
    const fleet = {
      fleet: async () => null,
      detail: async () => null,
      debugReport: async () => null,
      publish: () => {
        events.push('publish')
        return publish.promise
      },
      dispose: () => undefined
    } as unknown as FleetService
    registerControlApi(host, controls, fleet)

    const command = handlers.get('method:quirky.heimdall/command')
    if (!command) throw new Error('Heimdall command handler was not registered')
    const commandResult = command({
      target: { watcherId: 'watcher-1' },
      expectedOwner: { executionHostId: 'host-1', schedulerOwner: 'local', workspaceKey: 'host::/work', revision: 3 },
      command: { kind: 'stop-worker', identity: { dispatchId: 'dispatch-1', sessionId: 'session-1', processIncarnation: 'incarnation-1' } }
    }) as Promise<CommandResult>

    await Promise.resolve()
    const outcome = await Promise.race([
      commandResult.then(value => ({ kind: 'result' as const, value })),
      new Promise<{ kind: 'pending' }>(resolve => setImmediate(() => resolve({ kind: 'pending' })))
    ])

    expect(outcome).toEqual({ kind: 'result', value: result })
    expect(events).toEqual(['applied', 'publish'])
    expect(logs).toEqual([])
    publish.reject(new Error('fleet notification failed'))
    await Promise.resolve()
    expect(logs).toEqual(['Heimdall command applied but fleet push failed: fleet notification failed'])
  })
})
