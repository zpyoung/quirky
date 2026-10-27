import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { RpcErrorCode, type LaunchSettings, type PluginCaller, type PluginContext, type Session } from '@quirky/protocol'
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
function launchContext(onSpawn: (service: SessionService, sessionId: string) => void, launchPlan: object | Error = plan) {
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
      if (method === 'quirky.agents/get') return { id: 'claude', label: 'Claude', resumable: true, canFork: true }
      if (method === 'quirky.agents/prepareLaunch') {
        if (launchPlan instanceof Error) throw launchPlan
        return launchPlan
      }
      if (method === 'quirky.agents/prepareResume') {
        const { record } = params as { record: Session['launch'] }
        return { command: 'claude --resume', env: {}, record }
      }
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

const settings: LaunchSettings = {
  agent: 'claude',
  options: { model: { value: 'opus', source: 'explicit' }, effort: { value: 'high', source: 'explicit' } },
  summary: 'Claude · Opus · Effort: high'
}
const picked = { ...plan, launchSettings: settings }
const prepareLaunchParams = (calls: { method: string; params: unknown }[]) =>
  calls.find((c) => c.method === 'quirky.agents/prepareLaunch')?.params as Record<string, unknown>

describe('SessionService.create launch settings', () => {
  test('forwards model, options and extraArgs to prepareLaunch and stores the plan\'s launchSettings', async () => {
    const { service, records, calls } = launchContext(() => {}, picked)
    const options = { effort: 'high' }

    const result = await service.create({ agent: 'claude', model: 'opus', options, extraArgs: '--add-dir docs' }, caller)

    expect(prepareLaunchParams(calls)).toMatchObject({ model: 'opus', options, extraArgs: '--add-dir docs' })
    expect(result.launchSettings).toEqual(settings)
    expect(records.get(result.id)?.launchSettings).toEqual(settings)
  })

  test('sends none of the three when the caller gave none', async () => {
    const { service, calls } = launchContext(() => {})

    await service.create({ agent: 'claude' }, caller)

    const params = prepareLaunchParams(calls)
    for (const key of ['model', 'options', 'extraArgs']) expect(key in params).toBe(false)
  })

  test('a plan without launchSettings stores null', async () => {
    const { service, records } = launchContext(() => {})

    const result = await service.create({ agent: 'claude', model: 'opus' }, caller)

    expect(result.launchSettings).toBeNull()
    expect(records.get(result.id)?.launchSettings).toBeNull()
  })

  test('a shell session has null launchSettings', async () => {
    const { service } = launchContext(() => {})

    expect((await service.create({ agent: 'shell' }, caller)).launchSettings).toBeNull()
  })

  for (const params of [{ model: 'opus' }, { options: { effort: 'high' } }, { extraArgs: '--add-dir docs' }]) {
    test(`SC-20: a shell with ${Object.keys(params)[0]} is refused before any record exists`, async () => {
      const { service, records, calls } = launchContext(() => {})

      await expect(service.create({ agent: 'shell', ...params }, caller)).rejects.toThrow(
        'invalid-params: Agent shell does not support launch-time model selection.'
      )

      expect(records.list()).toEqual([])
      expect(calls.map((c) => c.method)).not.toContain('quirky.agents/prepareLaunch')
    })
  }

  test('SC-20: a pick that prepareLaunch refuses leaves no record and spawns nothing', async () => {
    const refusal = Object.assign(new Error('Agent claude model haiku does not support effort low.'), { code: RpcErrorCode.InvalidParams })
    let spawned = false
    const { service, records } = launchContext(() => void (spawned = true), refusal)

    await expect(service.create({ agent: 'claude', model: 'haiku', options: { effort: 'low' } }, caller)).rejects.toBe(refusal)

    expect(records.list()).toEqual([])
    expect(spawned).toBe(false)
  })
})

describe('SessionService.resume launch settings', () => {
  const folder = tmpdir()
  const seed = (records: SessionRecords, launchSettings: LaunchSettings | null) =>
    records.insert(
      {
        id: 's_old',
        kind: 'terminal',
        agent: 'claude',
        worktreeId: 'wt',
        cwd: folder,
        title: 'Claude',
        status: 'exited',
        createdAt: 1,
        lastActivityAt: 1,
        exitCode: 0,
        launch: plan.record,
        providerSession: { id: 'abc', transcriptPath: null },
        promptDelivery: null,
        launchSettings,
        resumedFrom: null
      },
      'repo'
    )

  for (const fork of [false, true]) {
    test(`SC-21: ${fork ? 'fork' : 'resume'} copies the old session's launchSettings`, async () => {
      const { service, records } = launchContext(() => {})
      seed(records, settings)

      const result = await service.resume({ session: 's_old', ...(fork ? { fork: true } : {}) })

      expect(result.launchSettings).toEqual(settings)
      expect(records.get(result.id)?.launchSettings).toEqual(settings)
      expect(records.get('s_old')?.launchSettings).toEqual(settings)
    })
  }

  test('SC-21: a session recorded without launchSettings resumes with null', async () => {
    const { service, records } = launchContext(() => {})
    seed(records, null)
    records.update('s_old', { launchSettings: null })

    expect((await service.resume({ session: 's_old' })).launchSettings).toBeNull()
  })
})

describe('SessionService.register launch settings', () => {
  test('stores the given launchSettings on the structured record', async () => {
    const { service, records } = launchContext(() => {})

    const result = await service.register({ agent: 'claude', kind: 'structured', title: 'Claude', launchSettings: settings }, caller)

    expect(result.launchSettings).toEqual(settings)
    expect(records.get(result.id)?.launchSettings).toEqual(settings)
  })

  test('stores a copy built from the checked fields, not the caller\'s object', async () => {
    const { service } = launchContext(() => {})
    const given: LaunchSettings = { ...settings, args: { value: '--add-dir docs', source: 'inherited' } }

    const result = await service.register({ agent: 'claude', kind: 'structured', title: 'Claude', launchSettings: given }, caller)

    expect(result.launchSettings).toEqual(given)
    expect(result.launchSettings).not.toBe(given)
    expect(result.launchSettings!.options).not.toBe(given.options)
  })

  test('accepts boolean option values and options with no value', async () => {
    const { service, records } = launchContext(() => {})
    const given: LaunchSettings = { ...settings, options: { fast: { value: true, source: 'explicit' }, effort: { source: 'extra-args' } } }

    const result = await service.register({ agent: 'claude', kind: 'structured', title: 'Claude', launchSettings: given }, caller)

    expect(records.get(result.id)?.launchSettings).toEqual(given)
  })

  const malformed: [string, unknown][] = [
    ['summary is not a string', { ...settings, summary: 42 }],
    ['summary is missing', { agent: 'claude', options: {} }],
    ['agent is empty', { ...settings, agent: '' }],
    ['an option source is unknown', { ...settings, options: { model: { value: 'opus', source: 'guess' } } }],
    ['an option value is a number', { ...settings, options: { model: { value: 3, source: 'explicit' } } }],
    ['an option is not an object', { ...settings, options: { model: 'opus' } }],
    ['options is not an object', { ...settings, options: 'opus' }],
    ['options is an array', { ...settings, options: [] }],
    ['args source is extra-args', { ...settings, args: { value: '--x', source: 'extra-args' } }],
    ['args value is not a string', { ...settings, args: { value: 1, source: 'explicit' } }],
    ['there is an extra top-level key', { ...settings, extra: true }],
    ['it is an array', []],
    ['it is a string', 'claude']
  ]
  for (const [what, bad] of malformed) {
    test(`refuses launchSettings when ${what} and inserts no record`, async () => {
      const { service, records } = launchContext(() => {})

      await expect(
        service.register({ agent: 'claude', kind: 'structured', title: 'Claude', launchSettings: bad }, caller)
      ).rejects.toThrow('invalid-params: launchSettings is malformed:')

      expect(records.list()).toEqual([])
    })
  }

  test('without launchSettings the record stores null', async () => {
    const { service, records } = launchContext(() => {})

    const result = await service.register({ agent: 'claude', kind: 'structured', title: 'Claude' }, caller)

    expect(result.launchSettings).toBeNull()
    expect(records.get(result.id)?.launchSettings).toBeNull()
  })
})
