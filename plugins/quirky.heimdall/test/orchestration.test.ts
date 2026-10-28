import { describe, expect, test } from 'bun:test'
import type { PluginContext, QuirkyEvent } from '@quirky/protocol'
import { budgetUsage } from '../src/budget'
import { createRunner } from '../src/runner'
import type { Attempt, Enrollment, JournalAppend, JournalEntry, KernelStore, KindRegistry, WatcherKind, WorkerRequest } from '../src/contracts'
import { createOrchestrationAdapter, orchestrationRequestIdForAttemptFingerprint } from '../src/orchestration'

describe('Heimdall orchestration adapter', () => {
  test('maps the SHA-256 dispatch identity to a stable UUIDv8 mutation request', () => {
    expect(orchestrationRequestIdForAttemptFingerprint('fp-1')).toBe('5731a55c-52dd-8cf8-bea3-0ae115069b14')
    expect(orchestrationRequestIdForAttemptFingerprint('fp-1')).toBe(orchestrationRequestIdForAttemptFingerprint('fp-1'))
    expect(orchestrationRequestIdForAttemptFingerprint('fp-2')).not.toBe(orchestrationRequestIdForAttemptFingerprint('fp-1'))
  })

  test('creates an owner-scoped run and dispatches with the prepared request identity', async () => {
    const enrollment = makeEnrollment()
    const store = makeStore(enrollment)
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const request: WorkerRequest = {
      spec: 'fixture task',
      worktree: '/tmp/fixture-worktree',
      agent: 'codex',
      runId: 'run_attacker',
      from: 'session_attacker',
      terminal: 'terminal_attacker'
    }
    const adapter = createOrchestrationAdapter(makeContext(async (method, params = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.orchestration/serviceRegisterSubmissionPreflight') return undefined
      if (method === 'quirky.orchestration/serviceRunCreate') {
        return { run: { id: 'run_fixture' }, mutation: { requestId: params.requestId, replayed: false } }
      }
      if (method === 'quirky.orchestration/serviceWorkerStart') {
        return readyReceipt(params.runId, params.requestId)
      }
      throw new Error(`unexpected method ${method}`)
    }), store, () => {})

    const result = await adapter.dispatch(enrollment, preparedAttempt(request), request)

    expect(result).toEqual({ kind: 'dispatched', dispatchId: 'ctx_fixture' })
    expect(store.get(enrollment.watcherId)?.orchestrationRunId).toBe('run_fixture')
    expect(calls.map((call) => call.method)).toEqual([
      'quirky.orchestration/serviceRunCreate',
      'quirky.orchestration/serviceRegisterSubmissionPreflight',
      'quirky.orchestration/serviceWorkerStart'
    ])
    expect(calls[1]?.params).toEqual({
      runId: 'run_fixture',
      method: 'quirky.heimdall/submissionPreflight'
    })
    expect(calls[0]?.params).toMatchObject({
      contractVersion: 1,
      key: enrollment.watcherId,
      objective: expect.stringContaining(enrollment.watcherId)
    })
    const start = calls[2]!.params
    expect(start).toMatchObject({
      runId: 'run_fixture',
      requestId: orchestrationRequestIdForAttemptFingerprint('fp-1'),
      contractVersion: 1,
      spec: 'fixture task',
      worktree: '/tmp/fixture-worktree',
      agent: 'codex'
    })
    expect(start).not.toHaveProperty('from')
    expect(start).not.toHaveProperty('terminal')
  })
  test('restores the submission hook for an existing owned Run', async () => {
    const enrollment = makeEnrollment({ orchestrationRunId: 'run_fixture' })
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const adapter = createOrchestrationAdapter(makeContext(async (method, params = {}) => {
      calls.push({ method, params })
      return undefined
    }), makeStore(enrollment), () => {})

    await adapter.restore(enrollment)

    expect(calls).toEqual([{
      method: 'quirky.orchestration/serviceRegisterSubmissionPreflight',
      params: { runId: 'run_fixture', method: 'quirky.heimdall/submissionPreflight' }
    }])
    adapter.dispose()
  })

  test('returns refused and indeterminate worker receipts without converting either to success', async () => {
    const failed = await adapterForReceipt({ state: 'failed', lastError: 'placement refused' }).dispatch(
      makeEnrollment(), preparedAttempt(), { spec: 'fixture task', worktree: '/tmp/fixture-worktree' }
    )
    expect(failed).toMatchObject({ kind: 'refused', reason: expect.any(String) })

    const unknown = await adapterForReceipt({ state: 'outcome_unknown' }).dispatch(
      makeEnrollment(), preparedAttempt(), { spec: 'fixture task', worktree: '/tmp/fixture-worktree' }
    )
    expect(unknown).toEqual({
      kind: 'indeterminate',
      requestId: orchestrationRequestIdForAttemptFingerprint('fp-1'),
      detail: expect.any(String)
    })
  })
  test('reports a lost worker-start reply as indeterminate with the persisted request ID', async () => {
    const adapter = createOrchestrationAdapter(makeContext(async (method, params = {}) => {
      if (method === 'quirky.orchestration/serviceRunCreate') {
        return { run: { id: 'run_fixture' }, mutation: { requestId: params.requestId, replayed: false } }
      }
      if (method === 'quirky.orchestration/serviceRegisterSubmissionPreflight') return undefined
      if (method === 'quirky.orchestration/serviceWorkerStart') throw new Error('connection closed after request')
      throw new Error(`unexpected method ${method}`)
    }), makeStore(makeEnrollment()), () => {})

    const result = await adapter.dispatch(makeEnrollment(), preparedAttempt(), {
      spec: 'fixture task', worktree: '/tmp/fixture-worktree'
    })

    expect(result).toMatchObject({
      kind: 'indeterminate',
      requestId: orchestrationRequestIdForAttemptFingerprint('fp-1'),
      detail: expect.stringContaining('connection closed after request')
    })
  })
  test('replays run creation with the same mutation key after a lost reply', async () => {
    const enrollment = makeEnrollment()
    const store = makeStore(enrollment)
    const runRequestIds: unknown[] = []
    let createAttempts = 0
    const adapter = createOrchestrationAdapter(makeContext(async (method, params = {}) => {
      if (method === 'quirky.orchestration/serviceRunCreate') {
        runRequestIds.push(params.requestId)
        createAttempts++
        if (createAttempts === 1) throw new Error('run creation reply lost')
        return { run: { id: 'run_fixture' }, mutation: { requestId: params.requestId, replayed: true } }
      }
      if (method === 'quirky.orchestration/serviceRegisterSubmissionPreflight') return undefined
      if (method === 'quirky.orchestration/serviceWorkerStart') return readyReceipt(params.runId, params.requestId)
      throw new Error(`unexpected method ${method}`)
    }), store, () => {})
    const attempt = preparedAttempt()
    const request = { spec: 'fixture task', worktree: '/tmp/fixture-worktree' }

    expect(await adapter.dispatch(enrollment, attempt, request)).toMatchObject({ kind: 'indeterminate' })
    expect(await adapter.dispatch(enrollment, attempt, request)).toMatchObject({ kind: 'dispatched', dispatchId: 'ctx_fixture' })
    expect(runRequestIds).toHaveLength(2)
    expect(runRequestIds[1]).toBe(runRequestIds[0])
  })
  test('does not persist a late run receipt or dispatch after adapter disposal', async () => {
    const enrollment = makeEnrollment()
    const store = makeStore(enrollment)
    const calls: string[] = []
    const { promise: runReply, resolve: finishRun } = Promise.withResolvers<unknown>()
    let runRequestId: unknown
    const adapter = createOrchestrationAdapter(makeContext(async (method, params = {}) => {
      calls.push(method)
      if (method === 'quirky.orchestration/serviceRunCreate') {
        runRequestId = params.requestId
        return runReply
      }
      throw new Error(`unexpected method ${method}`)
    }), store, () => {})
    const attempt = preparedAttempt()
    const request = attempt.workerRequest
    if (!request) throw new Error('prepared test attempt has no replay request')
    const dispatch = adapter.dispatch(enrollment, attempt, request)
    adapter.dispose()
    finishRun({ run: { id: 'run_fixture' }, mutation: { requestId: runRequestId, replayed: false } })
    const result = await dispatch

    expect(result).toMatchObject({ kind: 'indeterminate' })
    expect(store.get(enrollment.watcherId)?.orchestrationRunId).toBeNull()
    expect(calls).toEqual(['quirky.orchestration/serviceRunCreate'])
  })

  test('recovery repeats the exact prepared request key instead of minting another dispatch', async () => {
    const enrollment = makeEnrollment({ orchestrationRunId: 'run_fixture' })
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const adapter = createOrchestrationAdapter(makeContext(async (method, params = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.orchestration/serviceRunShow') return { run: { id: 'run_fixture' }, workers: [], questions: [] }
      if (method === 'quirky.orchestration/serviceRegisterSubmissionPreflight') return undefined
      if (method === 'quirky.orchestration/serviceWorkerStart') return readyReceipt(params.runId, params.requestId)
      throw new Error(`unexpected method ${method}`)
    }), makeStore(enrollment), () => {})

    const result = await adapter.recover(enrollment, preparedAttempt())

    expect(result).toMatchObject({ kind: 'dispatched', dispatchId: 'ctx_fixture' })
    expect(calls.map((call) => call.method)).toEqual([
      'quirky.orchestration/serviceRegisterSubmissionPreflight',
      'quirky.orchestration/serviceWorkerStart'
    ])
    expect(calls[0]?.params).toEqual({ runId: 'run_fixture', method: 'quirky.heimdall/submissionPreflight' })
  })

  test('owner-run worker evidence drives billable contact and malformed rows cannot appear live', async () => {
    let nowMs = 1_000
    let workerState: 'live' | 'exited' = 'live'
    let omitWorkers = false
    const enrollment = makeEnrollment({ orchestrationRunId: 'run_fixture' })
    const store = makeStore(enrollment)
    const attempt = preparedAttempt()
    if (!attempt.requestId || !attempt.workerRequest) throw new Error('prepared fixture has no worker replay data')
    store.append(enrollment.watcherId, {
      kind: 'attempt',
      class: 'fact',
      origin: 'owner',
      resolved: false,
      eventId: 'seed-running-worker',
      attemptId: attempt.attemptId,
      fingerprint: attempt.fingerprint,
      action: attempt.action,
      state: 'running',
      requestId: attempt.requestId,
      workerRequest: attempt.workerRequest
    })
    const context = makeContext(async (method, params = {}) => {
      if (method === 'quirky.orchestration/serviceWorkerStart') return readyReceipt(params.runId, params.requestId)
      if (method === 'quirky.orchestration/serviceCheck') return checkResult(params.requestId)
      if (method === 'quirky.orchestration/serviceRunShow') {
        return {
          run: { id: params.runId },
          questions: [],
          ...(omitWorkers ? {} : {
            workers: [{
              dispatchId: 'ctx_fixture',
              sessionId: 'session-fixture',
              processIncarnation: 'process-fixture',
              state: workerState,
              assignmentActive: true,
              lastContactAtMs: nowMs
            }]
          })
        }
      }
      throw new Error(`unexpected method ${method}`)
    })
    const adapter = createOrchestrationAdapter(context, store, () => {})
    const kind: WatcherKind = {
      id: 'fixture',
      displayName: 'Fixture',
      enrollmentPayloadSchema: {} as never,
      authorizeEnrollment: async () => { throw new Error('unused') },
      read: async () => ({
        freshness: 'live',
        contentIdentity: 'fixture-world',
        observedAtMs: nowMs,
        world: {}
      }),
      decide: () => ({ action: null, reason: 'waiting' }),
      execute: async () => ({ effect: 'landed' })
    }
    const registry: KindRegistry = {
      get: (id) => id === kind.id ? kind : undefined,
      register: () => {},
      registerDescriptor: () => {},
      descriptors: () => []
    }
    const runner = createRunner({
      context,
      store,
      registry,
      orchestration: adapter,
      enrollment,
      now: () => nowMs
    })
    try {
      await runner.pulse()
      expect(store.journal(enrollment.watcherId).some((entry) =>
        entry.kind === 'interval-open' && entry.cause === 'worker-dispatched' && entry.class === 'fact'
      )).toBe(true)

      nowMs = 1_500
      await runner.pulse()
      expect(budgetUsage(store.journal(enrollment.watcherId), nowMs).activeMs).toBe(500)

      nowMs = 2_000
      workerState = 'exited'
      await runner.pulse()
      expect(budgetUsage(store.journal(enrollment.watcherId), nowMs).activeMs).toBe(500)
      expect(store.journal(enrollment.watcherId).filter((entry) => entry.kind === 'interval-close')).toHaveLength(1)
      expect(store.journal(enrollment.watcherId).filter((entry) => entry.kind === 'attempt').at(-1))
        .toMatchObject({ state: 'running', dispatchId: 'ctx_fixture' })
      expect(runner.status()).toMatchObject({ state: 'held', reason: 'worker-contact-unverifiable' })

      nowMs = 3_000
      omitWorkers = true
      await runner.pulse()
      expect(runner.status()).toMatchObject({
        state: 'held',
        reason: 'tick-error',
        detail: expect.stringContaining('worker')
      })
      expect(store.journal(enrollment.watcherId).some((entry) =>
        entry.kind === 'interval-open' && entry.cause === 'worker-dispatched' &&
        !store.journal(enrollment.watcherId).some((closed) =>
          closed.kind === 'interval-close' && closed.intervalId === entry.intervalId
        )
      )).toBe(false)
      expect(store.journal(enrollment.watcherId).filter((entry) => entry.kind === 'attempt').at(-1))
        .toMatchObject({ state: 'running', dispatchId: 'ctx_fixture' })
    } finally {
      await runner.shutdown(0)
      adapter.dispose()
    }
  })

  test('drains committed mailbox evidence, acknowledges the exact delivery, and wakes only its run', async () => {
    const enrollment = makeEnrollment({ orchestrationRunId: 'run_fixture' })
    const store = makeStore(enrollment)
    const calls: { method: string; params: Record<string, unknown> }[] = []
    let listener: ((event: QuirkyEvent) => void | Promise<void>) | undefined
    let unsubscribed = false
    const adapter = createOrchestrationAdapter(makeContext(async (method, params = {}) => {
      calls.push({ method, params })
      if (method !== 'quirky.orchestration/serviceCheck') throw new Error(`unexpected method ${method}`)
      if (params.ackDeliveryId === 'delivery_fixture') return checkResult(params.requestId, { acknowledged: 'delivery_fixture' })
      return checkResult(params.requestId, {
        deliveryId: 'delivery_fixture',
        messages: [
          message('msg_done', 'worker_done', { outcome: 'succeeded', dispatchId: 'ctx_worker' }, { kind: 'dispatch', dispatchId: 'ctx_worker' }),
          message('msg_question', 'question', null, { kind: 'dispatch', dispatchId: 'ctx_worker' })
        ],
        questions: [{ messageId: 'msg_question', dispatchId: 'ctx_worker', status: 'answered', answerBody: 'Proceed' }]
      })
    }, (callback) => {
      listener = callback
      return () => { unsubscribed = true }
    }), store, (watcherId) => { wakes.push(watcherId) })
    const wakes: string[] = []

    const messages = await adapter.mailbox(enrollment)
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'msg_done', type: 'worker_done', dispatchId: 'ctx_worker', outcome: 'succeeded', raw: expect.any(Object) }),
      expect.objectContaining({ id: 'msg_question', type: 'question', dispatchId: 'ctx_worker', resolved: true, raw: expect.any(Object) })
    ]))
    expect(await adapter.mailbox(enrollment)).toEqual(messages)
    expect(calls.filter((call) => call.method === 'quirky.orchestration/serviceCheck')).toHaveLength(1)
    await adapter.acknowledge(enrollment, messages)
    expect(calls.filter((call) => call.method === 'quirky.orchestration/serviceCheck').map((call) => call.params.ackDeliveryId)).toEqual([undefined, 'delivery_fixture'])
    expect(calls[1]?.params.contractVersion).toBe(1)

    listener?.({ type: 'quirky.orchestration/message-arrived', data: { runId: 'run_other', messageId: 'msg_x', type: 'question' } })
    listener?.({ type: 'quirky.orchestration/message-arrived', data: { runId: 'run_fixture', messageId: 'msg_x', type: 'status' } })
    listener?.({ type: 'quirky.orchestration/message-arrived', data: { runId: 'run_fixture', messageId: 'msg_x', type: 'question' } })
    expect(wakes).toEqual([enrollment.watcherId])

    adapter.dispose()
    expect(unsubscribed).toBe(true)
  })

  test('delegates archive-before-close release and refuses an unknown release outcome', async () => {
    const enrollment = makeEnrollment({ orchestrationRunId: 'run_fixture' })
    let releaseParams: Record<string, unknown> | undefined
    const adapter = createOrchestrationAdapter(makeContext(async (method, params = {}) => {
      if (method !== 'quirky.orchestration/serviceWorkerRelease') throw new Error(`unexpected method ${method}`)
      releaseParams = params
      return { dispatchId: 'ctx_worker', state: 'released', processAction: 'none', mutation: { requestId: params.requestId, replayed: false } }
    }), makeStore(enrollment), () => {})

    await adapter.release(enrollment, 'ctx_worker')
    expect(releaseParams).toMatchObject({
      runId: 'run_fixture', dispatchId: 'ctx_worker', contractVersion: 1,
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })

    const unknown = createOrchestrationAdapter(makeContext(async (_method, params = {}) => ({
      dispatchId: 'ctx_worker',
      state: 'unknown',
      processAction: 'unknown',
      lastError: 'release cannot be verified',
      mutation: { requestId: params.requestId, replayed: false }
    })), makeStore(enrollment), () => {})
    await expect(unknown.release(enrollment, 'ctx_worker')).rejects.toThrow(/unknown|unverifiable/i)
  })
})

function adapterForReceipt(overrides: Record<string, unknown>) {
  const enrollment = makeEnrollment()
  return createOrchestrationAdapter(makeContext(async (method, params = {}) => {
    if (method === 'quirky.orchestration/serviceRunCreate') {
      return { run: { id: 'run_fixture' }, mutation: { requestId: params.requestId, replayed: false } }
    }
    if (method === 'quirky.orchestration/serviceRegisterSubmissionPreflight') return undefined
    if (method === 'quirky.orchestration/serviceWorkerStart') return { ...readyReceipt(params.runId, params.requestId), ...overrides }
    throw new Error(`unexpected method ${method}`)
  }), makeStore(enrollment), () => {})
}

function makeContext(
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  subscribe: (listener: (event: QuirkyEvent) => void | Promise<void>) => () => void = () => () => {}
): PluginContext {
  return {
    pluginId: 'quirky.heimdall',
    dir: '/tmp/heimdall',
    workerEntrypoint: () => { throw new Error('workerEntrypoint is unsupported in the orchestration fixture') },
    dataDir: '/tmp/heimdall-data',
    home: '/tmp/quirky-home',
    createFileResource: () => { throw new Error('unexpected file resource request') },
    clients: { accept: () => { throw new Error('unexpected remote client admission') } },
    call,
    subscribe,
    log: () => {},
    provide: () => {},
    emit: () => true,
    openStore: () => { throw new Error('not used') },
    getSetting: () => undefined,
    storedSettingValue: () => undefined,
    error: (_kind, message) => new Error(message),
    pty: null as never,
    notify: () => {},
    launch: null as never
  }
}

function makeEnrollment(overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    watcherId: 'watcher_fixture',
    kind: 'fixture',
    workspaceKey: 'fixture-host::/tmp/worktree',
    workspacePath: '/tmp/worktree',
    executionHostId: 'fixture-host',
    schedulerOwner: 'local',
    kindPayload: {},
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: { 'fixture.write': 'on' },
    budget: { wallClockActiveMs: null, turns: null },
    coordinator: { handle: 'coord_fixture', paneKey: 'pane_fixture' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null,
    parkReason: null,
    haltReason: null,
    ...overrides
  }
}

function makeStore(initial: Enrollment): KernelStore {
  let enrollment = initial
  const rows: JournalEntry[] = []
  return {
    readOnly: false,
    list: () => [enrollment],
    get: (watcherId) => watcherId === enrollment.watcherId ? enrollment : null,
    live: (workspaceKey) => workspaceKey === enrollment.workspaceKey ? enrollment : null,
    save: (next) => { enrollment = next },
    transaction: (work) => work(),
    journal: (watcherId) => rows.filter((row) => row.watcherId === watcherId),
    append: (watcherId, entry: JournalAppend) => {
      const row = {
        ...entry,
        seq: rows.filter((item) => item.watcherId === watcherId).length + 1,
        eventId: entry.eventId ?? `event-${rows.length + 1}`,
        watcherId,
        atMs: entry.atMs ?? Date.now()
      } as JournalEntry
      rows.push(row)
      return row
    },
    traces: () => [],
    trace: () => {},
    nextTraceSeq: () => 1,
    retain: () => {},
    terminal: () => {},
    summary: () => null,
    registrations: () => [],
    saveRegistration: () => {},
    close: () => {}
  }
}

function preparedAttempt(workerRequest: WorkerRequest = { spec: 'fixture task', worktree: '/tmp/fixture-worktree' }): Attempt {
  const requestId = orchestrationRequestIdForAttemptFingerprint('fp-1')
  return {
    seq: 1,
    eventId: 'attempt-fixture',
    watcherId: 'watcher_fixture',
    atMs: 1,
    class: 'fact',
    origin: 'owner',
    kind: 'attempt',
    resolved: false,
    attemptId: 'attempt_fixture',
    fingerprint: 'fp-1',
    action: {
      kind: 'fixture-worker', capability: 'fixture.write', visibility: 'external',
      contentIdentity: 'world-v1', evidenceKey: 'worker-evidence-v1',
      expectedState: { target: 'worker', before: { state: 'absent' } }
    },
    state: 'running',
    requestId,
    workerRequest
  }
}

function readyReceipt(runId: unknown, requestId: unknown): Record<string, unknown> {
  return {
    runId,
    taskId: 'task_fixture',
    dispatchId: 'ctx_fixture',
    state: 'ready',
    stage: 'ready',
    turnStart: 'observed',
    setup: { requested: 'default', effective: 'default', source: 'default', hookFound: false, startupPolicy: 'none', state: 'ready' },
    launch: { requested: { agent: null, model: null, effort: null }, effective: { agent: null, model: null, effort: null } },
    mode: { mode: 'terminal', preferred: 'terminal', reason: 'fixture', detail: 'fixture' },
    timeoutMs: 1000,
    effects: [],
    residualResources: [],
    mutation: { requestId, replayed: false }
  }
}

function checkResult(
  requestId: unknown,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    mode: 'consume',
    runId: 'run_fixture',
    messages: [],
    count: 0,
    acknowledged: null,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
    deliveryId: null,
    replayed: false,
    questions: [],
    mutation: { requestId, replayed: false },
    ...overrides
  }
}

function message(
  id: string,
  type: string,
  payload: unknown,
  sender: { kind: 'dispatch'; dispatchId: string }
): Record<string, unknown> {
  return {
    id,
    runId: 'run_fixture',
    fromSessionId: 'session_fixture',
    sender,
    mailbox: { kind: 'run', runId: 'run_fixture' },
    subject: id,
    body: id === 'msg_question' ? 'Need confirmation?' : 'Worker completed',
    type,
    payload,
    read: true,
    createdAt: '2026-10-27T00:00:00.000Z',
    deliveredAt: '2026-10-27T00:00:00.000Z'
  }
}
