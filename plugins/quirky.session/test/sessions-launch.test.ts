import { describe, expect, test } from 'bun:test'
import type { PluginCaller, PluginContext, Session } from '@quirky/protocol'
import { SessionRecords } from '../src/records'
import { SessionService } from '../src/sessions'
import { memoryStore } from './memory-store'

const worktree = { id: 'wt', repoId: 'repo', path: '/work', branch: 'main', head: 'abc', isMain: true, name: 'main' }
const caller = { role: 'cli' } as PluginCaller

const plan = {
  agent: 'claude',
  command: 'claude',
  env: {},
  record: { command: 'claude', args: '--model x', env: {} },
  promptDelivery: 'command-line',
  paste: null
}

/** A context whose `spawn` runs `onSpawn` with the service and session ID, as a process that exits early would. */
function launchContext(onSpawn: (service: SessionService, sessionId: string) => void, launchPlan: object = plan) {
  const calls: { method: string; params: unknown }[] = []
  const emitted: { event: string; status?: string; exitCode?: number | null }[] = []
  let service!: SessionService
  let sessionId = ''
  const context = {
    log() {},
    emit: (event: string, data?: { session?: Session }) => {
      emitted.push({ event, status: data?.session?.status, exitCode: data?.session?.exitCode })
      return true
    },
    error: (kind: string, message: string) => new Error(`${kind}: ${message}`),
    call: async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'quirky.agents/get') return { id: 'claude', label: 'Claude' }
      if (method === 'quirky.agents/prepareLaunch') return launchPlan
      if (method === 'quirky.agents/deliver') return { delivery: 'delivered' }
      return worktree
    },
    launch: {
      hooks: async (request: { sessionId: string }) => {
        sessionId = request.sessionId
        return { env: {}, args: [] }
      },
      shellArgv: () => ['/bin/sh'],
      commandArgv: () => ['/bin/sh'],
      env: () => ({})
    },
    pty: {
      spawn: async () => onSpawn(service, sessionId),
      forget: async () => {}
    }
  } as unknown as PluginContext
  const records = new SessionRecords(memoryStore())
  service = new SessionService(context, records)
  return { service, records, emitted, calls }
}

describe('SessionService.create', () => {
  test('a process that exits before the spawn call returns leaves the session exited', async () => {
    const { service, records, emitted } = launchContext((svc, id) => void svc.finish(id, 127))

    const result = await service.create({ agent: 'shell' }, caller)

    expect(result).toMatchObject({ status: 'exited', exitCode: 127 })
    expect(records.get(result.id)).toMatchObject({ status: 'exited', exitCode: 127 })
    expect(emitted.filter((e) => e.event === 'changed').map((e) => e.status)).toEqual(['exited'])
  })

  test('an agent that exits before the spawn call returns stays exited and keeps its launch record', async () => {
    const { service, records, emitted } = launchContext((svc, id) => void svc.finish(id, 1))

    const result = await service.create({ agent: 'claude', prompt: 'hi' }, caller)

    expect(result).toMatchObject({
      agent: 'claude',
      title: 'Claude',
      status: 'exited',
      exitCode: 1,
      launch: { command: 'claude', args: '--model x', env: {} },
      promptDelivery: 'command-line'
    })
    expect(records.get(result.id)).toEqual(result)
    expect(emitted.filter((e) => e.event === 'changed').map((e) => e.status)).toEqual(['exited'])
  })

  test('an agent that is still alive after spawn is running with its launch record', async () => {
    const { service, emitted } = launchContext(() => {})

    const result = await service.create({ agent: 'claude' }, caller)

    expect(result).toMatchObject({ status: 'running', launch: { command: 'claude', args: '--model x', env: {} } })
    expect(emitted.filter((e) => e.event === 'changed').map((e) => e.status)).toEqual(['running'])
  })

  test('an agent that exits before the spawn call returns gets no paste and no pending delivery', async () => {
    const pasted = { ...plan, promptDelivery: 'pending', paste: { text: 'hi', submit: true } }
    const { service, records, calls } = launchContext((svc, id) => void svc.finish(id, 1), pasted)

    const result = await service.create({ agent: 'claude', prompt: 'hi', waitForPrompt: true }, caller)

    expect(calls.map((c) => c.method)).not.toContain('quirky.agents/deliver')
    expect(result).toMatchObject({ status: 'exited', promptDelivery: 'not-delivered' })
    expect(records.get(result.id)).toMatchObject({ promptDelivery: 'not-delivered' })
  })

  test('an agent still alive after spawn gets its paste delivered', async () => {
    const pasted = { ...plan, promptDelivery: 'pending', paste: { text: 'hi', submit: true } }
    const { service, calls } = launchContext(() => {}, pasted)

    const result = await service.create({ agent: 'claude', prompt: 'hi', waitForPrompt: true }, caller)

    expect(calls.map((c) => c.method)).toContain('quirky.agents/deliver')
    expect(result).toMatchObject({ status: 'running', promptDelivery: 'delivered' })
  })

  test('a provider session saved while spawn is in flight survives the launch', async () => {
    const { service, records } = launchContext((svc, id) => {
      svc.setProviderSession({ session: id, id: 'provider-123' })
    })

    const result = await service.create({ agent: 'claude' }, caller)

    expect(result.providerSession).toEqual({ id: 'provider-123', transcriptPath: null })
    expect(records.get(result.id)?.providerSession).toEqual({ id: 'provider-123', transcriptPath: null })
  })
})
