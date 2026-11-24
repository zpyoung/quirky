import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOOPS_CHANNELS } from '../../../../../shared/fork-loops/api'
import { LOOPS_RUNTIME_CAPABILITY } from '../../../../../shared/fork-loops/capability'
import type {
  CheckOutcome,
  LoopConfig,
  LoopSnapshot
} from '../../../../../shared/fork-loops/loop-types'
import { RUNTIME_CAPABILITIES } from '../../../../../shared/protocol-version'
import { LoopDatabase } from '../../../../fork-loops/loop-database'
import { LoopService } from '../../../../fork-loops/loop-service'
import { LoopStore } from '../../../../fork-loops/loop-store'
import { QuirkyRuntimeService } from '../../../quirky-runtime'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { mapRuntimeError } from '../../errors'
import { ALL_RPC_METHODS } from '../index'
import { LOOPS_METHODS } from './loops'
import { bindLoopService } from './service-binding'

const CONFIG: LoopConfig = {
  promptSource: { kind: 'repeat', body: 'fix the failing tests' },
  pacing: { kind: 'on-idle' },
  sessionPolicy: 'continue',
  done: {},
  caps: {},
  noProgress: false,
  checkpointCommits: false,
  askBeforeNext: false,
  resumeAtLimitReset: false
}

const CHECK: CheckOutcome = {
  ran: true,
  pass: true,
  exitCode: 0,
  timedOut: false,
  stdoutTail: 'check out',
  stderrTail: 'check err',
  durationMs: 1
}

const CREATE_PARAMS = {
  worktreeId: 'wt-1',
  name: 'Fix tests',
  agent: 'claude',
  preset: 'queue',
  config: { ...CONFIG, promptSource: { kind: 'queue', repeatQueue: false } },
  queueItems: ['first', 'second']
}

const VALID_PARAMS: Record<string, Record<string, unknown>> = {
  [LOOPS_CHANNELS.create]: CREATE_PARAMS,
  [LOOPS_CHANNELS.list]: {},
  [LOOPS_CHANNELS.get]: { loopId: 'loop-seed' },
  [LOOPS_CHANNELS.pause]: { loopId: 'loop-seed', mode: 'after-iteration' },
  [LOOPS_CHANNELS.resume]: { loopId: 'loop-seed' },
  [LOOPS_CHANNELS.stop]: { loopId: 'loop-seed', mode: 'now' },
  [LOOPS_CHANNELS.steer]: { loopId: 'loop-seed', text: 'look at the parser' },
  [LOOPS_CHANNELS.edit]: { loopId: 'loop-seed', patch: { name: 'Renamed' } },
  [LOOPS_CHANNELS.queue]: { loopId: 'loop-seed', op: { op: 'add', body: 'next' } },
  [LOOPS_CHANNELS.bindTab]: { loopId: 'loop-seed', tabId: 'tab-0', paneKey: 'tab-0:leaf-0' },
  [LOOPS_CHANNELS.detach]: { loopId: 'loop-seed' },
  [LOOPS_CHANNELS.openTab]: { loopId: 'loop-seed' },
  [LOOPS_CHANNELS.iterations]: { loopId: 'loop-seed' }
}

const databases: LoopDatabase[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const database of databases.splice(0)) {
    database.close()
  }
})

function createHarness() {
  const database = new LoopDatabase(':memory:')
  databases.push(database)
  const store = new LoopStore(database)
  const service = new LoopService({
    store,
    runtime: {},
    driverDeps: {
      observer: { observeIteration: vi.fn() },
      inputAttribution: { noteLoopWrite: vi.fn(), userIdleFor: () => true },
      tools: {
        snapshotTree: vi.fn(async () => null),
        diffTrees: vi.fn(async () => ({ added: 0, removed: 0, files: [] })),
        runCheck: vi.fn(async () => CHECK),
        evaluate: vi.fn(async () => ({ verdict: 'met' as const, reason: 'ok' })),
        readUsage: vi.fn(async () => null),
        readUsageLimit: vi.fn(() => null)
      },
      targets: vi.fn(async () => {
        throw new Error('targets are not used by these tests')
      })
    },
    notify: vi.fn()
  })
  const runtime = new QuirkyRuntimeService()
  bindLoopService(runtime, service)
  store.insertLoop({
    id: 'loop-seed',
    worktreeId: 'wt-1',
    workspaceKind: 'git',
    executionHostId: 'local',
    name: 'Seed',
    slug: 'seed-1',
    agent: 'claude',
    preset: 'until-done',
    config: CONFIG,
    state: 'paused',
    pauseReason: 'user',
    tabId: 'tab-0',
    paneKey: 'tab-0:leaf-0',
    ptyId: 'pty-0'
  })
  return { service, store, ctx: { runtime } satisfies RpcContext }
}

function findMethod(name: string) {
  const method = eraseRpcMethods(LOOPS_METHODS).find((candidate) => candidate.name === name)
  if (!method?.params) {
    throw new Error(`Method not found: ${name}`)
  }
  return { handler: method.handler, params: method.params }
}

async function call(name: string, params: unknown, ctx: RpcContext): Promise<unknown> {
  const method = findMethod(name)
  return method.handler(method.params.parse(params), ctx)
}

function snapshotOf(overrides: Partial<LoopSnapshot> = {}): LoopSnapshot {
  return {
    id: 'loop-1',
    worktreeId: 'wt-1',
    name: 'Fix tests',
    agent: 'claude',
    preset: 'until-done',
    config: CONFIG,
    state: 'running',
    iterationsCompleted: 0,
    detached: false,
    skippedTicks: 0,
    activeMs: 0,
    queue: [],
    recentIterations: [],
    ...overrides
  }
}

describe('loops RPC registration', () => {
  it('registers every loops method as a workspace method', () => {
    const names = Object.values(LOOPS_CHANNELS)

    expect(LOOPS_METHODS.map((method) => method.name).sort()).toEqual([...names].sort())
    expect(LOOPS_METHODS.every((method) => method.permission === 'workspace')).toBe(true)
  })

  it('is part of the host method registry', () => {
    const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))

    for (const name of Object.values(LOOPS_CHANNELS)) {
      expect(registered.has(name)).toBe(true)
    }
  })

  it('advertises the loops capability', () => {
    expect(RUNTIME_CAPABILITIES).toContain(LOOPS_RUNTIME_CAPABILITY)
    expect(LOOPS_RUNTIME_CAPABILITY).toBe('loops.v1')
  })
})

describe('loops RPC params', () => {
  it('accepts the params the preload and CLI send', () => {
    for (const [name, params] of Object.entries(VALID_PARAMS)) {
      expect(findMethod(name).params.safeParse(params).success, name).toBe(true)
    }
    expect(findMethod(LOOPS_CHANNELS.list).params.safeParse({ worktreeId: 'wt-1' }).success).toBe(
      true
    )
    expect(
      findMethod(LOOPS_CHANNELS.resume).params.safeParse({ loopId: 'a', addIterations: 5 }).success
    ).toBe(true)
    expect(
      findMethod(LOOPS_CHANNELS.iterations).params.safeParse({ loopId: 'a', limit: 20 }).success
    ).toBe(true)
  })

  it.each<[string, Record<string, unknown>]>([
    [LOOPS_CHANNELS.create, { ...CREATE_PARAMS, agent: 'not-an-agent' }],
    [LOOPS_CHANNELS.create, { ...CREATE_PARAMS, queueItems: [''] }],
    [LOOPS_CHANNELS.list, { worktreeId: '' }],
    [LOOPS_CHANNELS.get, {}],
    [LOOPS_CHANNELS.get, { loopId: '' }],
    [LOOPS_CHANNELS.pause, { loopId: 'a', mode: 'now' }],
    [LOOPS_CHANNELS.resume, { loopId: 'a', addIterations: 0 }],
    [LOOPS_CHANNELS.stop, { loopId: 'a', mode: 'later' }],
    [LOOPS_CHANNELS.steer, { loopId: 'a', text: '' }],
    [LOOPS_CHANNELS.edit, { loopId: 'a', patch: { unknown: true } }],
    [LOOPS_CHANNELS.queue, { loopId: 'a', op: { op: 'rotate' } }],
    [LOOPS_CHANNELS.bindTab, { loopId: 'a', tabId: 'tab-0' }],
    [LOOPS_CHANNELS.detach, { loopId: 'a', extra: 1 }],
    [LOOPS_CHANNELS.openTab, { loopId: 3 }],
    [LOOPS_CHANNELS.iterations, { loopId: 'a', limit: 0 }]
  ])('rejects invalid params for %s', (name, params) => {
    expect(findMethod(name).params.safeParse(params).success).toBe(false)
  })
})

describe('loops RPC handlers', () => {
  it('reports an unbound runtime as loop_runtime_unavailable for every method', async () => {
    const ctx: RpcContext = { runtime: new QuirkyRuntimeService() }

    for (const [name, params] of Object.entries(VALID_PARAMS)) {
      await expect(call(name, params, ctx), name).rejects.toMatchObject({
        code: 'loop_runtime_unavailable'
      })
    }
  })

  it('creates a loop from the full input, queue items included', async () => {
    const { service, ctx } = createHarness()
    const created = snapshotOf({ preset: 'queue' })
    const create = vi.spyOn(service, 'create').mockResolvedValue(created)

    const result = await call(LOOPS_CHANNELS.create, CREATE_PARAMS, ctx)

    expect(result).toBe(created)
    expect(create).toHaveBeenCalledWith(CREATE_PARAMS)
  })

  it('lists and gets snapshots', async () => {
    const { ctx } = createHarness()

    expect(await call(LOOPS_CHANNELS.list, {}, ctx)).toMatchObject([{ id: 'loop-seed' }])
    expect(await call(LOOPS_CHANNELS.list, { worktreeId: 'other' }, ctx)).toEqual([])
    expect(await call(LOOPS_CHANNELS.get, { loopId: 'loop-seed' }, ctx)).toMatchObject({
      id: 'loop-seed',
      state: 'paused'
    })
  })

  it('keeps the loop error code for an unknown loop', async () => {
    const { ctx } = createHarness()

    await expect(call(LOOPS_CHANNELS.get, { loopId: 'missing' }, ctx)).rejects.toMatchObject({
      code: 'loop_not_found'
    })
    await expect(call(LOOPS_CHANNELS.iterations, { loopId: 'missing' }, ctx)).rejects.toMatchObject(
      { code: 'loop_not_found' }
    )
  })

  it('maps a thrown loop error to its own code over the wire', async () => {
    const { ctx } = createHarness()
    const error = await call(LOOPS_CHANNELS.get, { loopId: 'missing' }, ctx).catch(
      (thrown: unknown) => thrown
    )

    const failure = mapRuntimeError('req-1', { runtimeId: 'rt-1' }, error)

    expect(failure.error.code).toBe('loop_not_found')
  })

  it('keeps the loop error code for an invalid transition', async () => {
    const { ctx } = createHarness()
    await call(LOOPS_CHANNELS.stop, { loopId: 'loop-seed', mode: 'now' }, ctx)

    await expect(
      call(LOOPS_CHANNELS.steer, { loopId: 'loop-seed', text: 'too late' }, ctx)
    ).rejects.toMatchObject({ code: 'loop_invalid_transition' })
  })

  it('delegates each mutation to the service with the parsed arguments', async () => {
    const { service, ctx } = createHarness()
    const result = snapshotOf()
    const spies = {
      pause: vi.spyOn(service, 'pause').mockResolvedValue(result),
      resume: vi.spyOn(service, 'resume').mockResolvedValue(result),
      stop: vi.spyOn(service, 'stop').mockResolvedValue(result),
      steer: vi.spyOn(service, 'steer').mockResolvedValue(result),
      edit: vi.spyOn(service, 'edit').mockResolvedValue(result),
      queue: vi.spyOn(service, 'queue').mockResolvedValue(result),
      bindTab: vi.spyOn(service, 'bindTab').mockResolvedValue(result),
      detach: vi.spyOn(service, 'detach').mockResolvedValue(result),
      openTab: vi.spyOn(service, 'openTab').mockResolvedValue(result)
    }

    await call(LOOPS_CHANNELS.pause, { loopId: 'a', mode: 'after-iteration' }, ctx)
    await call(LOOPS_CHANNELS.resume, { loopId: 'a', addIterations: 4 }, ctx)
    await call(LOOPS_CHANNELS.resume, { loopId: 'b' }, ctx)
    await call(LOOPS_CHANNELS.stop, { loopId: 'a', mode: 'now' }, ctx)
    await call(LOOPS_CHANNELS.steer, { loopId: 'a', text: 'hello' }, ctx)
    await call(LOOPS_CHANNELS.edit, { loopId: 'a', patch: { name: 'New' } }, ctx)
    await call(LOOPS_CHANNELS.queue, { loopId: 'a', op: { op: 'remove', id: 'q1' } }, ctx)
    await call(LOOPS_CHANNELS.bindTab, { loopId: 'a', tabId: 't', paneKey: 't:l' }, ctx)
    await call(LOOPS_CHANNELS.detach, { loopId: 'a' }, ctx)
    await call(LOOPS_CHANNELS.openTab, { loopId: 'a' }, ctx)

    expect(spies.pause).toHaveBeenCalledWith('a', 'after-iteration')
    expect(spies.resume.mock.calls).toEqual([
      ['a', { addIterations: 4 }],
      ['b', {}]
    ])
    expect(spies.stop).toHaveBeenCalledWith('a', 'now')
    expect(spies.steer).toHaveBeenCalledWith('a', 'hello')
    expect(spies.edit).toHaveBeenCalledWith('a', { name: 'New' })
    expect(spies.queue).toHaveBeenCalledWith('a', { op: 'remove', id: 'q1' })
    expect(spies.bindTab).toHaveBeenCalledWith('a', { tabId: 't', paneKey: 't:l' })
    expect(spies.detach).toHaveBeenCalledWith('a')
    expect(spies.openTab).toHaveBeenCalledWith('a')
  })

  it('returns finished iterations with evidence tails, newest last', async () => {
    const { store, ctx } = createHarness()
    for (const n of [1, 2, 3]) {
      store.insertIteration('loop-seed', {
        n,
        attempt: 0,
        promptSent: `prompt ${n}`,
        startedAt: n * 1000,
        endedAt: n * 1000 + 500,
        endReason: 'settled',
        check: CHECK,
        outputTail: `agent out ${n}`
      })
    }

    const all = await call(LOOPS_CHANNELS.iterations, { loopId: 'loop-seed' }, ctx)
    const limited = await call(LOOPS_CHANNELS.iterations, { loopId: 'loop-seed', limit: 2 }, ctx)

    expect(all).toMatchObject([{ n: 1 }, { n: 2 }, { n: 3, outputTail: 'agent out 3' }])
    expect(all).toMatchObject([
      {},
      {},
      { check: { stdoutTail: 'check out', stderrTail: 'check err' } }
    ])
    expect(limited).toMatchObject([{ n: 2 }, { n: 3 }])
  })
})
