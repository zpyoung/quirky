import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as supervision from '@quirky/supervision'
import type { SupervisionClock, SupervisionEngine } from '@quirky/supervision'
import type { PluginContext, Session, StructuredMessage } from '@quirky/protocol'
import type { DispatchRow, RunId, TaskRow } from '../../src/contracts'
import type {
  CoordinatorEvidence, TerminalResource, TurnStart, WorkerPlacement, WorkerRecord, WorkerRuntime, WorkerStartParams,
} from '../../src/worker-contracts'
import type { SessionIdentity } from '../../src/runtime-contracts'
import { createWorkerRuntime } from '../../src/workers/runtime'

const SESSION_ID = 's1'
const WORKTREE_ID = 'w1'
const INCARNATION = 'inc-1'
const RUNTIME_EPOCH = 'runtime-1'
const THREAD_ID = 'thread-1'
const RUN_ID = 'run-1' as RunId
const SERVICE_CALLER: CoordinatorEvidence = {
  kind: 'service', pluginId: 'quirky.orchestration', runId: RUN_ID, authority: 'kernel_plugin',
}

type FakeTimer = { at: number; callback: () => void; cancelled: boolean; fired: boolean }
type EngineCall = { method: string; input: unknown }
type EngineSpy = {
  mockRestore(): void
  mockImplementation(fn: (...args: unknown[]) => unknown): unknown
}
type FactorySpy = {
  mockRestore(): void
  mockImplementation(
    fn: (context: Parameters<typeof supervision.createSupervision>[0]) => SupervisionEngine,
  ): unknown
}
type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>

interface Harness {
  runtime: WorkerRuntime
  engine: SupervisionEngine
  context: PluginContext
  calls: { method: string; params: Record<string, unknown> }[]
  sessions: Map<string, Session>
  identities: Map<string, SessionIdentity>
  identityErrors: Map<string, Error>
  journals: Map<string, StructuredMessage[]>
  journalResponses: unknown[]
  waitResponses: unknown[]
  handlers: Map<string, Handler>
  getCalls(method: string): { method: string; params: Record<string, unknown> }[]
  getEngineCalls(method: string): EngineCall[]
}

interface TestScope {
  makeHarness(): Harness
  readonly now: number
  readonly timersPending: number
  readonly engines: SupervisionEngine[]
  readonly engineCalls: EngineCall[]
  readonly factorySpy: FactorySpy
  advance(milliseconds: number): Promise<void>
  elapse(milliseconds: number): void
  flush(): Promise<void>
  restore(): void
}

let activeScope: TestScope | null = null

afterEach(() => {
  activeScope?.restore()
  activeScope = null
})

function createScope(startAt = 10_000): TestScope {
  let now = startAt
  const timers: FakeTimer[] = []
  const engines: SupervisionEngine[] = []
  const engineCalls: EngineCall[] = []
  const engineCallsByEngine = new Map<SupervisionEngine, EngineCall[]>()
  const runtimes: WorkerRuntime[] = []
  const methodSpies: EngineSpy[] = []
  const realFactory = supervision.createSupervision

  const schedule = (callback: () => void, delay: number): FakeTimer => {
    const timer = { at: now + Math.max(0, delay), callback, cancelled: false, fired: false }
    timers.push(timer)
    return timer
  }
  const dateNowSpy = spyOn(Date, 'now').mockImplementation(() => now)
  const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay = 0, ...args: unknown[]) => {
    if (typeof callback !== 'function') return 0 as unknown as ReturnType<typeof setTimeout>
    return schedule(() => callback(...args), Number(delay)) as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof globalThis.setTimeout)
  const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((handle: ReturnType<typeof setTimeout>) => {
    if (typeof handle === 'object' && handle !== null && 'cancelled' in handle) (handle as unknown as FakeTimer).cancelled = true
  }) as typeof globalThis.clearTimeout)

  const clock: SupervisionClock = {
    now: () => now,
    setTimer(callback, delay) {
      const timer = schedule(callback, delay)
      return () => { timer.cancelled = true }
    },
  }

  const factorySpy = spyOn(supervision, 'createSupervision') as unknown as FactorySpy
  factorySpy.mockImplementation((context: Parameters<typeof realFactory>[0]) => {
    const engine = realFactory(context, { clock })
    const callsForEngine: EngineCall[] = []
    engineCallsByEngine.set(engine, callsForEngine)
    engines.push(engine)
    const methods: (keyof SupervisionEngine)[] = [
      'create', 'resume', 'send', 'readMessages', 'watchStructured', 'waitTerminal', 'stop', 'stopOwned', 'dispose',
    ]
    const target = engine as unknown as Record<keyof SupervisionEngine, (...args: unknown[]) => unknown>
    for (const method of methods) {
      const actual = target[method].bind(engine)
      const methodSpy = spyOn(target, method) as unknown as EngineSpy
      methodSpy.mockImplementation((...args: unknown[]) => {
        const call = { method: String(method), input: args[0] }
        engineCalls.push(call)
        callsForEngine.push(call)
        return actual(...args)
      })
      methodSpies.push(methodSpy)
    }
    return engine
  })

  async function flush(): Promise<void> {
    for (let index = 0; index < 30; index++) await Promise.resolve()
  }

  async function advance(milliseconds: number): Promise<void> {
    const target = now + milliseconds
    for (;;) {
      const next = timers
        .filter(timer => !timer.cancelled && !timer.fired && timer.at <= target)
        .sort((left, right) => left.at - right.at)[0]
      if (!next) break
      now = Math.max(now, next.at)
      next.fired = true
      next.callback()
      await flush()
    }
    now = target
    await flush()
  }
  function elapse(milliseconds: number): void {
    now += milliseconds
  }

  function makeHarness(): Harness {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const sessions = new Map<string, Session>()
    const identities = new Map<string, SessionIdentity>()
    const identityErrors = new Map<string, Error>()
    const journals = new Map<string, StructuredMessage[]>()
    const journalResponses: unknown[] = []
    const waitResponses: unknown[] = []
    const handlers = new Map<string, Handler>()
    const context = {
      call: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
        calls.push({ method, params })
        const handler = handlers.get(method)
        if (handler) return handler(params)
        switch (method) {
          case 'quirky.worktree/show':
            return { id: WORKTREE_ID, repoId: 'repo-1', path: '/work/w1', kind: 'git' }
          case 'quirky.agents/list':
            return { defaultAgent: 'codex', agents: [{ id: 'codex', label: 'Codex', installed: true, enabled: true }] }
          case 'quirky.agents/options':
            return {
              supported: true,
              models: [{ id: 'gpt-5-codex', options: [{ id: 'effort', choices: [{ value: 'high' }] }] }],
              unlisted: 'refuse', unlistedOptions: [], structured: true,
            }
          case 'quirky.structured/create': {
            const session = makeSession('structured', 'starting')
            sessions.set(session.id, session)
            identities.set(session.id, makeIdentity('structured'))
            return session
          }
          case 'quirky.terminal/newTab': {
            const session = makeSession('terminal', 'running')
            sessions.set(session.id, session)
            identities.set(session.id, makeIdentity('terminal'))
            return { session: session.id, tab: 'tab-1' }
          }
          case 'quirky.terminal/renameTab':
            return { ok: true }
          case 'quirky.session/get': {
            const session = sessions.get(String(params.session))
            if (!session) throw codedError('terminal_not_found', 'missing session')
            return session
          }
          case 'quirky.session/list':
            return [...sessions.values()]
          case 'quirky.session/identity': {
            const id = String(params.session)
            const error = identityErrors.get(id)
            if (error) throw error
            const identity = identities.get(id)
            if (!identity) throw codedError('not-found', 'missing identity')
            return identity
          }
          case 'quirky.structured/messages': {
            if (journalResponses.length > 0) return journalResponses.shift()
            const messages = journals.get(String(params.session)) ?? []
            return params.afterSeq === undefined
              ? messages
              : messages.filter(message => message.seq > Number(params.afterSeq))
          }
          case 'quirky.agent-status/wait': {
            const result = waitResponses.shift() ?? { status: 'matched', state: 'idle' }
            if (result instanceof Error) throw result
            return result
          }
          case 'quirky.session/pointer':
            return { operationId: params.operationId, result: { status: 'submitted' } }
          case 'quirky.structured/stop':
          case 'quirky.session/close':
            return exactCloseReceipt(params.session, params.expectedIncarnation)
          default:
            throw codedError('method_not_found', `Unexpected public call: ${method}`)
        }
      },
      log: (_message: string) => undefined,
    } as unknown as PluginContext

    const runtime = createWorkerRuntime(context)
    runtimes.push(runtime)
    const engine = engines[engines.length - 1]!
    const callsForEngine = engineCallsByEngine.get(engine)!
    return {
      runtime, engine, context, calls, sessions, identities, identityErrors, journals, journalResponses, waitResponses, handlers,
      getCalls(method: string) { return calls.filter(call => call.method === method) },
      getEngineCalls(method: string) { return callsForEngine.filter(call => call.method === method) },
    }
  }

  function restore(): void {
    for (const runtime of runtimes) runtime.dispose()
    for (const spy of methodSpies.reverse()) spy.mockRestore()
    factorySpy.mockRestore()
    clearTimeoutSpy.mockRestore()
    setTimeoutSpy.mockRestore()
    dateNowSpy.mockRestore()
  }

  return {
    makeHarness,
    get now() { return now },
    get timersPending() { return timers.filter(timer => !timer.cancelled && !timer.fired).length },
    get engines() { return engines },
    get engineCalls() { return engineCalls },
    get factorySpy() { return factorySpy },
    advance,
    elapse,
    flush,
    restore,
  }
}

function makeSession(kind: 'structured' | 'terminal', status: string, overrides: Record<string, unknown> = {}): Session {
  return {
    id: SESSION_ID,
    kind,
    agent: 'codex',
    worktreeId: WORKTREE_ID,
    status,
    title: 'Worker: task-1',
    cwd: '/work/w1',
    createdAt: 1,
    lastActivityAt: 1,
    exitCode: null,
    providerSession: kind === 'structured' ? { id: THREAD_ID } : undefined,
    ...overrides,
  } as unknown as Session
}

function makeIdentity(kind: 'structured' | 'terminal', overrides: Partial<SessionIdentity> = {}): SessionIdentity {
  return {
    sessionId: SESSION_ID,
    live: true,
    runtimeEpoch: RUNTIME_EPOCH,
    processIncarnation: INCARNATION,
    source: kind === 'structured' ? 'structured_lease' : 'terminal_launch',
    kind,
    providerId: kind === 'structured' ? 'codex' : null,
    worktreeId: WORKTREE_ID,
    ...overrides,
  }
}

function codedError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function errorCode(value: unknown): string | null {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    ? value.code
    : null
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(errorCode(caught)).toBe(code)
}

function workerParams(mode: 'structured' | 'terminal' = 'structured', overrides: Partial<WorkerStartParams> = {}): WorkerStartParams {
  return {
    runId: RUN_ID,
    worktree: WORKTREE_ID,
    mode,
    agent: 'codex',
    ...overrides,
  } as WorkerStartParams
}

async function placeWorker(
  harness: Harness,
  mode: 'structured' | 'terminal' = 'structured',
  overrides: Partial<WorkerStartParams> = {},
): Promise<WorkerPlacement> {
  let placement: WorkerPlacement | null = null
  await harness.runtime.place(
    workerParams(mode, overrides),
    { id: 'task-1', displayName: 'task-1', taskTitle: 'task-1' } as unknown as TaskRow,
    {} as DispatchRow,
    SERVICE_CALLER,
    value => { placement = value },
  )
  if (!placement) throw new Error('worker placement callback was not invoked')
  return placement
}

function message(seq: number, role: string, text: string, data?: unknown): StructuredMessage {
  return { sessionId: SESSION_ID, seq, role, text, at: seq, ...(data === undefined ? {} : { data }) } as StructuredMessage
}

function exactCloseReceipt(session: unknown, incarnation: unknown): Record<string, unknown> {
  return { ok: true, closed: true, sessionId: session, processIncarnation: incarnation }
}

function runtimeRecord(mode: 'structured' | 'terminal' = 'structured'): WorkerRecord {
  return {
    sessionId: SESSION_ID,
    processIncarnation: INCARNATION,
    processRuntimeEpoch: RUNTIME_EPOCH,
    worktreeId: WORKTREE_ID,
    mode,
  } as unknown as WorkerRecord
}

function terminalResource(kind: 'structured' | 'terminal' = 'structured'): TerminalResource {
  return {
    id: 'resource-1', originDispatchId: 'dispatch-1', ownerDispatchId: 'dispatch-1', priorOwnerDispatchIds: [],
    worktreeId: WORKTREE_ID, sessionId: SESSION_ID, processIncarnation: INCARNATION,
    ownershipState: 'owned', releaseState: 'not_requested', retainedReason: null, releaseRequestedAt: null,
    releaseCompletedAt: null, releaseError: null, recoveryAttemptCount: 0, lastRecoveryAt: null,
    archiveSource: null, archiveStatus: null,
    kind,
  } as unknown as TerminalResource
}

function newScope(startAt?: number): TestScope {
  activeScope = createScope(startAt)
  return activeScope
}

describe('worker runtime supervision adapter', () => {
  test('retains worktree and setup custody when setup polling is cancelled', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const coordinator = makeSession('terminal', 'running', { id: 'coordinator', worktreeId: 'parent-wt' })
    const setup = makeSession('terminal', 'running', { id: 'setup-1', worktreeId: 'child-wt' })
    harness.handlers.set('quirky.session/list', () => [coordinator, setup])
    harness.handlers.set('quirky.worktree/show', () => ({ id: 'parent-wt', repoId: 'repo-1', path: '/repo', kind: 'git' }))
    harness.handlers.set('quirky.repo/list', () => [{ id: 'repo-1', name: 'repo', path: '/repo', kind: 'git' }])
    harness.handlers.set('quirky.worktree/create', () => ({
      worktree: { id: 'child-wt', repoId: 'repo-1', path: '/repo/child', kind: 'git' },
      setup: { ran: 'terminal', sessionId: 'setup-1' },
    }))
    harness.handlers.set('quirky.repo/hooks', () => ({
      setup: { text: 'run setup', source: 'repo' }, agentStartup: 'wait-for-setup',
    }))
    const params = workerParams('structured', { worktree: 'new-child', timeoutMs: 5_000 })
    const pending = harness.runtime.place(
      params,
      { id: 'task-1', displayName: 'task-1', taskTitle: 'task-1' } as unknown as TaskRow,
      {} as DispatchRow,
      { runtimeSessionId: 'coordinator', callerSessionId: 'coordinator' } as unknown as CoordinatorEvidence,
      () => undefined,
    ).then(() => null, cause => cause)
    await scope.flush()

    expect(harness.getCalls('quirky.worktree/create')).toHaveLength(1)
    expect(scope.timersPending).toBe(1)
    harness.runtime.dispose()
    await scope.advance(1_000)

    const cause = await pending
    expect(errorCode(cause)).toBe('runtime_inactive')
    expect(cause).toMatchObject({
      data: {
        effects: [
          { kind: 'worktree', action: 'created', role: 'agent', id: 'child-wt' },
          { kind: 'setup', action: 'started', role: 'setup', id: 'setup-1' },
        ],
        residualResources: [{ kind: 'worktree', id: 'child-wt', state: 'created' }],
      },
    })
  })

  test('retains structured session custody when disposed after create resolves', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    let releaseCreate!: (session: Session) => void
    let createStarted = false
    harness.handlers.set('quirky.structured/create', () => {
      createStarted = true
      const held = Promise.withResolvers<Session>()
      releaseCreate = held.resolve
      return held.promise
    })
    const pending = harness.runtime.place(
      workerParams('structured'),
      { id: 'task-1', displayName: 'task-1', taskTitle: 'task-1' } as unknown as TaskRow,
      {} as DispatchRow,
      SERVICE_CALLER,
      () => undefined,
    ).then(() => null, cause => cause)
    await scope.flush()
    expect(createStarted).toBe(true)

    releaseCreate(makeSession('structured', 'starting'))
    harness.runtime.dispose()

    const cause = await pending
    expect(errorCode(cause)).toBe('runtime_inactive')
    expect(cause).toMatchObject({
      data: {
        effects: [{ kind: 'terminal', action: 'created', role: 'agent', id: SESSION_ID }],
        residualResources: [
          { kind: 'worktree', id: WORKTREE_ID, state: 'created' },
          { kind: 'terminal', id: SESSION_ID, state: 'created', worktreeId: WORKTREE_ID },
        ],
      },
    })
  })

  test('creates structured sessions deferred through the engine and submits once from its journal baseline', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness, 'structured', { model: 'gpt-5-codex', effort: 'high' })
    harness.journalResponses.push([message(7, 'user', 'previous')], [message(8, 'assistant', 'started')])

    const result = await harness.runtime.submit(placement, 'begin the task', 'operation-1', scope.now + 5_000)

    expect(result).toBe('observed')
    expect(scope.factorySpy).toHaveBeenCalledTimes(1)
    expect(harness.getEngineCalls('create')).toHaveLength(1)
    const createInput = harness.getEngineCalls('create')[0]!.input as Record<string, unknown>
    expect(createInput).toEqual({
      worktree: WORKTREE_ID, agent: 'codex', title: 'Worker: task-1', deferStart: true,
      model: 'gpt-5-codex', options: { effort: 'high' },
    })
    expect('prompt' in createInput).toBe(false)
    expect(harness.getEngineCalls('readMessages')).toEqual([{ method: 'readMessages', input: { session: SESSION_ID } }])
    expect(harness.getCalls('quirky.session/pointer')).toHaveLength(1)
    expect(harness.getCalls('quirky.session/pointer')[0]!.params).toEqual({
      session: SESSION_ID, expectedIncarnation: INCARNATION, operationId: 'operation-1',
      purpose: 'worker_start', text: 'begin the task',
    })
    expect(harness.getEngineCalls('send')).toHaveLength(0)
    expect(harness.getEngineCalls('watchStructured')).toHaveLength(1)
    const watch = harness.getEngineCalls('watchStructured')[0]!.input as {
      target: unknown; journal(): { afterSeq?: number }
    }
    expect(watch.target).toEqual({ sessionId: SESSION_ID, worktreeId: WORKTREE_ID, agent: 'codex' })
    expect(watch.journal()).toEqual({ afterSeq: 7 })
    expect(harness.getCalls('quirky.structured/messages').map(call => call.params.afterSeq)).toEqual([undefined, 7])
    expect(scope.timersPending).toBe(0)
  })
  test('rejects structured turn evidence if identity changes after observation', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness)
    let identityReads = 0
    const current = harness.identities.get(SESSION_ID)!
    harness.handlers.set('quirky.session/identity', () => {
      identityReads++
      return identityReads >= 2 ? { ...current, processIncarnation: 'inc-2' } : current
    })
    harness.journalResponses.push([message(7, 'user', 'prior')], [message(8, 'assistant', 'started')])

    expect(await harness.runtime.submit(placement, 'prompt', 'operation-1', scope.now + 5_000)).toBe('unobserved')
    expect(identityReads).toBe(2)
  })

  test('accepts tool and result rows as structured turn evidence', async () => {
    const scope = newScope()
    for (const [index, role] of ['tool', 'result'].entries()) {
      const harness = scope.makeHarness()
      const placement = await placeWorker(harness)
      harness.journalResponses.push([message(7, 'user', 'prior')], [message(8, role, 'completed')])
      expect(await harness.runtime.submit(placement, 'prompt', `operation-${index}`, scope.now + 5_000)).toBe('observed')
    }
  })

  test('maps an invalid baseline journal to invalid_runtime_response before the pointer is accepted', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness)
    harness.journalResponses.push([message(0, 'assistant', 'invalid')])

    await rejectsWithCode(harness.runtime.submit(placement, 'start', 'operation-1', scope.now + 5_000), 'invalid_runtime_response')

    expect(harness.getEngineCalls('readMessages')).toHaveLength(1)
    expect(harness.getCalls('quirky.session/pointer')).toHaveLength(0)
  })
  test('rechecks custody identity before any baseline read or pointer submission', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness)
    harness.identities.set(SESSION_ID, makeIdentity('structured', { processIncarnation: 'changed' }))

    await rejectsWithCode(harness.runtime.submit(placement, 'start', 'operation-1', scope.now + 5_000), 'worker_identity_changed')

    expect(harness.getEngineCalls('readMessages')).toHaveLength(0)
    expect(harness.getCalls('quirky.session/pointer')).toHaveLength(0)
  })

  test('preserves pointer refusals, unknown receipts, and text-only interpretation without replay', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness)
    const outcomes: ({ status: string; errorCode: string } | { status: string; turnStart: TurnStart })[] = [
      { status: 'deferred', errorCode: 'agent_not_ready' },
      { status: 'released', errorCode: 'worker_identity_changed' },
      { status: 'outcome_unknown', turnStart: 'unobserved' },
      { status: 'text_only', turnStart: 'unobserved' },
    ]
    for (const [index, outcome] of outcomes.entries()) {
      harness.handlers.set('quirky.session/pointer', params => ({ operationId: params.operationId, result: { status: outcome.status } }))
      const pending = harness.runtime.submit(placement, 'start', `operation-${index}`, scope.now + 5_000)
      if ('errorCode' in outcome) await rejectsWithCode(pending, outcome.errorCode)
      else expect(await pending).toBe(outcome.turnStart)
    }

    expect(harness.getCalls('quirky.session/pointer')).toHaveLength(outcomes.length)
    expect(harness.getEngineCalls('watchStructured')).toHaveLength(0)
  })

  test('rejects terminal readiness at the deadline using engine-managed 1000ms slices', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness, 'terminal')
    harness.handlers.set('quirky.agent-status/wait', params => {
      scope.elapse(Number(params.timeoutMs))
      return { status: 'pending', state: 'unknown' }
    })

    await rejectsWithCode(harness.runtime.waitReady(placement, scope.now + 2_500, false), 'worker_readiness_timeout')

    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(1)
    expect(harness.getCalls('quirky.agent-status/wait').map(call => call.params.timeoutMs)).toEqual([1_000, 1_000, 500])
  })

  test('maps matched terminal startup outcomes and leaves structured provider startup adapter-local', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness, 'terminal')
    harness.waitResponses.push(
      { status: 'matched', state: 'blocked', kind: 'approval' },
      { status: 'matched', state: 'exited' },
      { status: 'matched', state: 'idle' },
    )

    await rejectsWithCode(harness.runtime.waitReady(placement, scope.now + 5_000, false), 'agent_startup_blocked')
    await rejectsWithCode(harness.runtime.waitReady(placement, scope.now + 5_000, false), 'terminal_not_found')
    await harness.runtime.waitReady(placement, scope.now + 5_000, false)

    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(3)
    expect(harness.getCalls('quirky.agent-status/wait')).toHaveLength(3)

    const structured = await placeWorker(harness, 'structured')
    const structuredSession = harness.sessions.get(SESSION_ID)!
    structuredSession.status = 'running'
    await harness.runtime.waitReady(structured, scope.now + 5_000, false)
    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(3)
  })

  test('rejects malformed startup journal reads through the engine validation boundary', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness)
    harness.sessions.get(SESSION_ID)!.status = 'exited'
    harness.journalResponses.push([message(0, 'system', 'could not start: invalid')])

    await rejectsWithCode(harness.runtime.waitReady(placement, scope.now + 5_000, false), 'invalid_runtime_response')
    expect(harness.getEngineCalls('readMessages')).toHaveLength(1)
  })

  test('waits through stale idle evidence and accepts only a fresh terminal prompt', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness, 'terminal')
    const session = harness.sessions.get(SESSION_ID)!
    ;(session as unknown as { agentStatus: { evidenceAt: number } }).agentStatus = { evidenceAt: 10_000 }
    let waits = 0
    harness.handlers.set('quirky.agent-status/wait', () => {
      waits++
      return { status: 'matched', state: 'idle' }
    })

    const submission = harness.runtime.submit(placement, 'prompt', 'operation-1', scope.now + 10_000)
    await scope.flush()
    expect(waits).toBe(1)
    expect(harness.getEngineCalls('waitTerminal')[0]!.input).toMatchObject({
      session: SESSION_ID, until: ['working', 'blocked', 'idle', 'exited'], timeoutMs: 10_000,
    })
    ;(session as unknown as { agentStatus: { evidenceAt: number } }).agentStatus = { evidenceAt: 10_001 }
    await scope.advance(1_000)

    expect(await submission).toBe('observed')
    expect(waits).toBe(2)
    expect(scope.timersPending).toBe(0)
    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(1)
  })
  test('returns unobserved when stale idle evidence persists to the terminal deadline', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness, 'terminal')
    const session = harness.sessions.get(SESSION_ID)!
    ;(session as unknown as { agentStatus: { evidenceAt: number } }).agentStatus = { evidenceAt: 10_000 }
    harness.handlers.set('quirky.agent-status/wait', () => ({ status: 'matched', state: 'idle' }))
    const submission = harness.runtime.submit(placement, 'prompt', 'operation-1', scope.now + 5_000)
    await scope.flush()

    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(1)
    await scope.advance(5_000)

    expect(await submission).toBe('unobserved')
    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(1)
  })

  test('maps terminal turn observation categories and never waits past an expired deadline', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness, 'terminal')
    harness.waitResponses.push(
      { status: 'matched', state: 'working' },
      { status: 'matched', state: 'blocked', kind: 'approval' },
      codedError('method_not_found', 'wait unavailable'),
      codedError('capability_unsupported', 'wait unsupported'),
      { status: 'matched', state: 'unexpected' },
    )

    expect(await harness.runtime.submit(placement, 'one', 'operation-1', scope.now + 5_000)).toBe('observed')
    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(1)
    expect(await harness.runtime.submit(placement, 'two', 'operation-2', scope.now + 5_000)).toBe('permission')
    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(2)
    expect(await harness.runtime.submit(placement, 'three', 'operation-3', scope.now + 5_000)).toBe('unsupported')
    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(3)
    expect(await harness.runtime.submit(placement, 'four', 'operation-4', scope.now + 5_000)).toBe('unsupported')
    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(4)
    expect(await harness.runtime.submit(placement, 'five', 'operation-5', scope.now + 5_000)).toBe('unobserved')
    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(5)
    const beforeExpired = harness.getEngineCalls('waitTerminal').length
    expect(await harness.runtime.submit(placement, 'six', 'operation-6', scope.now)).toBe('unobserved')

    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(beforeExpired)
    expect(harness.getCalls('quirky.session/pointer')).toHaveLength(6)
  })

  test('proves Codex user receipts only with exact method, thread, text, identity, and steer turn ID', async () => {
    const scope = newScope()
    const accepted: { method: string; data: Record<string, unknown> }[] = [
      { method: 'turn/start', data: { method: 'turn/start', threadId: THREAD_ID } },
      { method: 'turn/steer', data: { method: 'turn/steer', threadId: THREAD_ID, expectedTurnId: 'turn-1' } },
    ]
    for (const [index, receipt] of accepted.entries()) {
      const harness = scope.makeHarness()
      const placement = await placeWorker(harness)
      harness.journalResponses.push([message(7, 'user', 'prior')], [message(8, 'user', 'prompt', receipt.data)])
      expect(await harness.runtime.submit(placement, 'prompt', `operation-${index}`, scope.now + 2_000)).toBe('observed')
      expect(harness.getEngineCalls('watchStructured')).toHaveLength(1)
    }
  })

  test('does not accept malformed, unsupported, or mismatched structured observations as proof', async () => {
    const scope = newScope()
    const candidates: { label: string; row: StructuredMessage; mutate?(harness: Harness): void }[] = [
      { label: 'wrong text', row: message(8, 'user', 'other', { method: 'turn/start', threadId: THREAD_ID }) },
      { label: 'wrong method', row: message(8, 'user', 'prompt', { method: 'other', threadId: THREAD_ID }) },
      { label: 'empty thread', row: message(8, 'user', 'prompt', { method: 'turn/start', threadId: '' }) },
      { label: 'wrong provider thread', row: message(8, 'user', 'prompt', { method: 'turn/start', threadId: 'wrong-thread' }) },
      {
        label: 'wrong provider identity', row: message(8, 'user', 'prompt', { method: 'turn/start', threadId: THREAD_ID }),
        mutate(harness) {
          let identityReads = 0
          const current = harness.identities.get(SESSION_ID)!
          harness.handlers.set('quirky.session/identity', () => {
            identityReads++
            return identityReads >= 2 ? { ...current, providerId: 'claude' } : current
          })
        },
      },
      {
        label: 'changed current identity', row: message(8, 'user', 'prompt', { method: 'turn/start', threadId: THREAD_ID }),
        mutate(harness) {
          let identityReads = 0
          const current = harness.identities.get(SESSION_ID)!
          harness.handlers.set('quirky.session/identity', () => {
            identityReads++
            return identityReads >= 2 ? { ...current, processIncarnation: 'inc-2' } : current
          })
        },
      },
      { label: 'steer without expected turn ID', row: message(8, 'user', 'prompt', { method: 'turn/steer', threadId: THREAD_ID }) },
      { label: 'malformed journal row', row: message(0, 'assistant', 'invalid') },
    ]

    for (const [index, candidate] of candidates.entries()) {
      const harness = scope.makeHarness()
      const placement = await placeWorker(harness)
      candidate.mutate?.(harness)
      harness.journalResponses.push([message(7, 'user', 'prior')], [candidate.row])
      const result = harness.runtime.submit(placement, 'prompt', `operation-${index}`, scope.now + 1_000)
      await scope.flush()
      await scope.advance(1_000)
      expect(await result, candidate.label).toBe('unobserved')
      expect(harness.getCalls('quirky.session/pointer')).toHaveLength(1)
    }

    const unreadable = scope.makeHarness()
    const unreadablePlacement = await placeWorker(unreadable)
    unreadable.handlers.set('quirky.structured/messages', params => {
      if (params.afterSeq === undefined) return [message(7, 'user', 'prior')]
      throw codedError('connection_lost', 'journal transport failed')
    })
    const inconclusive = unreadable.runtime.submit(unreadablePlacement, 'prompt', 'unreadable-op', scope.now + 1_000)
    await scope.flush()
    await scope.advance(1_000)
    expect(await inconclusive).toBe('unobserved')

    const unsupported = scope.makeHarness()
    const placement = await placeWorker(unsupported)
    unsupported.handlers.set('quirky.structured/messages', params => {
      if (params.afterSeq === undefined) return [message(7, 'user', 'prior')]
      throw codedError('method_not_found', 'messages unsupported')
    })
    expect(await unsupported.runtime.submit(placement, 'prompt', 'unsupported-op', scope.now + 1_000)).toBe('unsupported')
  })

  test('aborts a held structured journal probe at the absolute deadline and clears its timer', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const logs: string[] = []
    Object.assign(harness.context, { log: (entry: string) => logs.push(entry) })
    const placement = await placeWorker(harness)
    let releaseRead!: (rows: StructuredMessage[]) => void
    let readStarted = false
    harness.handlers.set('quirky.structured/messages', params => {
      if (params.afterSeq === undefined) return [message(7, 'user', 'prior')]
      readStarted = true
      const held = Promise.withResolvers<StructuredMessage[]>()
      releaseRead = held.resolve
      return held.promise
    })

    const submission = harness.runtime.submit(placement, 'prompt', 'operation-1', scope.now + 500)
    for (let turn = 0; turn < 30 && !readStarted; turn++) await Promise.resolve()
    expect(readStarted).toBe(true)
    await scope.advance(500)

    expect(await submission).toBe('unobserved')
    const callsAtDeadline = harness.getCalls('quirky.structured/messages').length
    releaseRead([message(8, 'assistant', 'late')])
    await scope.flush()
    expect(harness.getCalls('quirky.structured/messages')).toHaveLength(callsAtDeadline)
    expect(harness.getCalls('quirky.session/pointer')).toHaveLength(1)
    expect(scope.timersPending).toBe(0)
    expect(logs).toEqual([])
  })
  test('logs provider AbortErrors while the structured watch is still active', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const logs: string[] = []
    Object.assign(harness.context, { log: (entry: string) => logs.push(entry) })
    const placement = await placeWorker(harness)
    const current = harness.identities.get(SESSION_ID)!
    let identityReads = 0
    const providerAbort = new Error('provider callback aborted')
    providerAbort.name = 'AbortError'
    harness.handlers.set('quirky.session/identity', () => {
      identityReads++
      if (identityReads >= 2) throw providerAbort
      return current
    })
    harness.journalResponses.push(
      [message(7, 'user', 'prior')],
      [message(8, 'user', 'prompt', { method: 'turn/start', threadId: THREAD_ID })],
    )

    expect(await harness.runtime.submit(placement, 'prompt', 'operation-1', scope.now + 5_000)).toBe('unobserved')
    expect(logs).toEqual([`Turn-start observation for ${SESSION_ID} was inconclusive: provider callback aborted`])
  })

  test('disposal fences a late terminal readiness reply and disposes the engine once', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness, 'terminal')
    let releaseWait!: (result: unknown) => void
    let waitStarted = false
    harness.handlers.set('quirky.agent-status/wait', () => {
      waitStarted = true
      const held = Promise.withResolvers<unknown>()
      releaseWait = held.resolve
      return held.promise
    })

    const readiness = harness.runtime.waitReady(placement, scope.now + 5_000, false)
    for (let turn = 0; turn < 30 && !waitStarted; turn++) await Promise.resolve()
    expect(waitStarted).toBe(true)
    harness.runtime.dispose()
    harness.runtime.dispose()
    await rejectsWithCode(readiness, 'runtime_inactive')
    const callsAfterAbort = harness.calls.length
    releaseWait({ status: 'matched', state: 'idle' })
    await scope.flush()

    expect(harness.calls).toHaveLength(callsAfterAbort)
    expect(harness.getEngineCalls('dispose')).toHaveLength(1)
  })

  test('disposal after pointer acceptance returns unobserved without replaying or trusting a late journal row', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const logs: string[] = []
    Object.assign(harness.context, { log: (entry: string) => logs.push(entry) })
    const placement = await placeWorker(harness)
    let releaseRead!: (rows: StructuredMessage[]) => void
    let readStarted = false
    harness.handlers.set('quirky.structured/messages', params => {
      if (params.afterSeq === undefined) return [message(7, 'user', 'prior')]
      readStarted = true
      const held = Promise.withResolvers<StructuredMessage[]>()
      releaseRead = held.resolve
      return held.promise
    })

    const submission = harness.runtime.submit(placement, 'prompt', 'operation-1', scope.now + 5_000)
    for (let turn = 0; turn < 30 && !readStarted; turn++) await Promise.resolve()
    expect(readStarted).toBe(true)
    harness.runtime.dispose()

    expect(await submission).toBe('unobserved')
    expect(harness.getCalls('quirky.session/pointer')).toHaveLength(1)
    const callsAfterAbort = harness.calls.length
    releaseRead([message(8, 'assistant', 'late')])
    await scope.flush()
    expect(harness.calls).toHaveLength(callsAfterAbort)
    expect(harness.getEngineCalls('dispose')).toHaveLength(1)
    expect(scope.timersPending).toBe(0)
    expect(logs).toEqual([])
  })

  test('rechecks cancellation after structured readiness identity awaits', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const placement = await placeWorker(harness)
    harness.sessions.get(SESSION_ID)!.status = 'running'
    let releaseIdentity!: (identity: SessionIdentity) => void
    let identityStarted = false
    harness.handlers.set('quirky.session/identity', () => {
      identityStarted = true
      const held = Promise.withResolvers<SessionIdentity>()
      releaseIdentity = held.resolve
      return held.promise
    })

    const readiness = harness.runtime.waitReady(placement, scope.now + 5_000, false)
    for (let turn = 0; turn < 30 && !identityStarted; turn++) await Promise.resolve()
    expect(identityStarted).toBe(true)
    harness.runtime.dispose()
    releaseIdentity(makeIdentity('structured'))
    await rejectsWithCode(readiness, 'runtime_inactive')
    await scope.flush()
  })

  test('routes exact guarded closes through the engine and refuses mismatched identities or receipts', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    harness.identities.set(SESSION_ID, makeIdentity('structured'))
    const exact = exactCloseReceipt(SESSION_ID, INCARNATION)
    const receipts = [
      exact,
      { ok: true },
      { ok: false, closed: false, sessionId: SESSION_ID, processIncarnation: INCARNATION },
      exactCloseReceipt('other-session', INCARNATION),
      exactCloseReceipt(SESSION_ID, 'other-incarnation'),
    ]
    for (const receipt of receipts) {
      harness.handlers.set('quirky.structured/stop', () => receipt)
      const result = await harness.runtime.close(terminalResource('structured'))
      expect(result.closed).toBe(receipt === exact)
    }
    expect(harness.getEngineCalls('stop').map(call => call.input)).toEqual(receipts.map(() => ({
      kind: 'structured', session: SESSION_ID, expectedIncarnation: INCARNATION,
    })))

    const beforeMismatch = harness.getEngineCalls('stop').length
    const beforeMismatchRpc = harness.getCalls('quirky.structured/stop').length
    harness.identities.set(SESSION_ID, makeIdentity('structured', { processIncarnation: 'other-incarnation' }))
    expect((await harness.runtime.close(terminalResource('structured'))).closed).toBe(false)
    expect(harness.getEngineCalls('stop')).toHaveLength(beforeMismatch)
    expect(harness.getCalls('quirky.structured/stop')).toHaveLength(beforeMismatchRpc)

    harness.identities.set(SESSION_ID, makeIdentity('structured', { live: false }))
    expect((await harness.runtime.close(terminalResource('structured'))).closed).toBe(false)
    expect(harness.getCalls('quirky.structured/stop')).toHaveLength(beforeMismatchRpc)

    harness.identities.set(SESSION_ID, makeIdentity('structured', { worktreeId: 'other-worktree' }))
    expect((await harness.runtime.close(terminalResource('structured'))).closed).toBe(false)
    expect(harness.getCalls('quirky.structured/stop')).toHaveLength(beforeMismatchRpc)

    harness.identities.set(SESSION_ID, makeIdentity('terminal'))
    harness.handlers.set('quirky.session/close', (_params) => exactCloseReceipt(SESSION_ID, INCARNATION))
    expect((await harness.runtime.close(terminalResource('terminal'))).closed).toBe(true)
    expect(harness.getEngineCalls('stop').at(-1)!.input).toEqual({
      kind: 'terminal', session: SESSION_ID, expectedIncarnation: INCARNATION,
    })
  })
  test('returns an exact guarded close receipt after disposal', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    harness.identities.set(SESSION_ID, makeIdentity('structured'))
    let releaseStop!: (receipt: unknown) => void
    let stopStarted = false
    harness.handlers.set('quirky.structured/stop', () => {
      stopStarted = true
      const held = Promise.withResolvers<unknown>()
      releaseStop = held.resolve
      return held.promise
    })

    const closing = harness.runtime.close(terminalResource('structured'))
    for (let turn = 0; turn < 30 && !stopStarted; turn++) await Promise.resolve()
    expect(stopStarted).toBe(true)
    harness.runtime.dispose()
    releaseStop(exactCloseReceipt(SESSION_ID, INCARNATION))

    expect(await closing).toEqual({ closed: true })
  })

  test('inspects live worker state with one zero-time engine wait and preserves observation categories', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    const dispatch = { assigneeSessionId: SESSION_ID } as DispatchRow
    const record = runtimeRecord()

    expect((await harness.runtime.observe(record, dispatch)).status).toBe('missing')

    harness.sessions.set(SESSION_ID, makeSession('structured', 'running'))
    harness.identities.set(SESSION_ID, makeIdentity('structured', { processIncarnation: 'changed' }))
    expect((await harness.runtime.observe(record, dispatch)).status).toBe('identity_changed')

    harness.identities.set(SESSION_ID, makeIdentity('structured'))
    harness.identityErrors.set(SESSION_ID, codedError('runtime_unavailable', 'identity unavailable'))
    expect((await harness.runtime.observe(record, dispatch)).status).toBe('unverifiable')
    harness.identityErrors.delete(SESSION_ID)

    harness.waitResponses.push({ status: 'matched', state: 'blocked', kind: 'approval' })
    const live = await harness.runtime.observe(record, dispatch)
    expect(live.status).toBe('live')
    expect(live.agentWait).toEqual({ waiting: true, source: 'quirky.agent-status/wait', reason: 'approval' })
    expect(harness.getEngineCalls('waitTerminal').at(-1)!.input).toMatchObject({
      session: SESSION_ID, until: ['working', 'blocked', 'idle'], timeoutMs: 0,
    })

    harness.waitResponses.push({ status: 'matched', state: 'exited' })
    const stillLive = await harness.runtime.observe(record, dispatch)
    expect(stillLive.status).toBe('live')
    expect(stillLive.agentWait?.waiting).toBe(false)

    harness.sessions.set(SESSION_ID, makeSession('structured', 'exited', { exitCause: 'complete' }))
    harness.identities.set(SESSION_ID, makeIdentity('structured', { live: false }))
    expect((await harness.runtime.observe(record, dispatch)).status).toBe('exited')
    expect(harness.getCalls('quirky.agent-status/wait')).toHaveLength(2)
  })

  test('keeps session inventory and exact identity reconciliation local when exit evidence disagrees', async () => {
    const scope = newScope()
    const harness = scope.makeHarness()
    harness.sessions.set(SESSION_ID, makeSession('structured', 'exited'))
    harness.identities.set(SESSION_ID, makeIdentity('structured', { live: true }))

    const observation = harness.runtime.observe(runtimeRecord(), { assigneeSessionId: SESSION_ID } as DispatchRow)
    await scope.flush()
    await scope.advance(5_000)

    expect((await observation).status).toBe('unverifiable')
    expect(harness.getCalls('quirky.session/list').length).toBeGreaterThan(1)
    expect(harness.getEngineCalls('waitTerminal')).toHaveLength(0)
  })
})
