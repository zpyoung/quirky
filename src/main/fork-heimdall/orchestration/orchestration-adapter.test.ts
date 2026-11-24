import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import { hashCanonical } from '../../runtime/rpc/orchestration-mutation-receipt'
import {
  CoordinatorSeatLostError,
  QuestionAlreadyAnsweredError,
  RuntimeHeimdallOrchestrationAdapter,
  orchestrationRequestIdForAttemptFingerprint,
  type HeimdallOrchestrationPersistence
} from './orchestration-adapter'

const upstream = vi.hoisted(() => ({
  startLocalWorker: vi.fn(),
  listWorkers: vi.fn(),
  stopWorker: vi.fn(),
  releaseWorker: vi.fn(),
  resolveRunScope: vi.fn(),
  mutationRun: vi.fn(),
  inspectWorkerTerminal: vi.fn(),
  assertPromptBudget: vi.fn(),
  decideWorkerStartMode: vi.fn(() => ({
    mode: 'terminal',
    preferred: 'terminal',
    reason: 'user_default',
    detail: 'test mode'
  })),
  readWorkerStartModeSettings: vi.fn(() => null)
}))

vi.mock('../../runtime/rpc/methods/orchestration/worker/local-worker-start', () => ({
  startLocalWorker: upstream.startLocalWorker
}))
vi.mock('../../runtime/rpc/methods/orchestration/worker/worker-list-method', () => ({
  ORCHESTRATION_WORKER_LIST_METHOD: {
    name: 'orchestration.workerList',
    params: { parse: (value: unknown) => value },
    handler: upstream.listWorkers
  }
}))
vi.mock('../../runtime/rpc/methods/orchestration/worker/worker-stop', () => ({
  ORCHESTRATION_WORKER_STOP_METHODS: [
    {
      name: 'orchestration.workerStop',
      params: { parse: (value: unknown) => value },
      handler: upstream.stopWorker
    }
  ]
}))
vi.mock('../../runtime/rpc/methods/orchestration/worker/worker-release', () => ({
  ORCHESTRATION_WORKER_RELEASE_METHODS: [
    {
      name: 'orchestration.workerRelease',
      handler: upstream.releaseWorker
    }
  ]
}))
vi.mock('../../runtime/rpc/methods/orchestration/worker/worker-observation', () => ({
  inspectWorkerTerminal: upstream.inspectWorkerTerminal
}))
vi.mock('../../runtime/rpc/methods/orchestration/runs/run-scope', () => ({
  resolveRunScope: upstream.resolveRunScope,
  // Why: the real builder reads the orchestration db; a terminal-handle caller maps 1:1.
  orchestrationCallerIdentity: (
    _runtime: unknown,
    caller: { handle: string; paneKey: string | null | undefined }
  ) => ({
    address: caller.handle,
    terminalHandle: caller.handle,
    paneKey: caller.paneKey ?? null,
    quirkySessionId: null
  })
}))
vi.mock('../../runtime/rpc/orchestration-mutation-executor', () => ({
  getOrchestrationMutationExecutor: () => ({ run: upstream.mutationRun })
}))
vi.mock('../../runtime/rpc/methods/orchestration/worker/worker-start-prompt-budget', () => ({
  assertWorkerStartTaskSpecWithinPromptBudget: upstream.assertPromptBudget
}))
vi.mock('../../runtime/rpc/methods/orchestration-worker-start-mode', () => ({
  decideWorkerStartMode: upstream.decideWorkerStartMode,
  readWorkerStartModeSettings: upstream.readWorkerStartModeSettings
}))

const IDENTITY = {
  handle: 'heimdall-coordinator-persisted',
  paneKey: 'heimdall-pane-persisted'
}

function enrollment(overrides: Partial<WatcherEnrollment> = {}): WatcherEnrollment {
  return {
    watcherId: 'watcher-1',
    kind: 'hosted-review',
    workspaceKey: 'local::/repo',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'repo-1::/repo',
    workspacePath: '/repo',
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    coordinatorIdentity: IDENTITY,
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null,
    ...overrides
  }
}

type FakeRun = {
  id: string
  consumer_generation: number
  coordinator_handle: string
  coordinator_pane_key: string
}

type FakeDatabase = {
  db: { prepare: Mock }
  createRun: Mock
  getCurrentRunForPane: Mock
  getRun: Mock
  getDispatchContextById: Mock
  getWorkerDispatch: Mock
  getFederatedDispatch: Mock
  enqueueFederationRelay: Mock
  listTasks: Mock
  listWorkerTerminalResources: Mock
  listFederatedDispatchesByIds: Mock
  getMutationReceipt: Mock
  getQuestion: Mock
  answerQuestion: Mock
}

function fakeDb(id: string): FakeDatabase {
  let run: FakeRun | undefined
  return {
    db: { prepare: vi.fn(() => ({ all: vi.fn(() => []) })) },
    createRun: vi.fn(
      (params: { coordinatorHandle: string; coordinatorPaneKey: string }) =>
        (run = {
          id,
          consumer_generation: 1,
          coordinator_handle: params.coordinatorHandle,
          coordinator_pane_key: params.coordinatorPaneKey
        })
    ),
    getCurrentRunForPane: vi.fn(() => run),
    getRun: vi.fn((runId: string) => (runId === run?.id ? run : undefined)),
    getDispatchContextById: vi.fn(),
    getWorkerDispatch: vi.fn(),
    getFederatedDispatch: vi.fn(),
    enqueueFederationRelay: vi.fn(),
    listTasks: vi.fn(() => []),
    listWorkerTerminalResources: vi.fn(() => []),
    listFederatedDispatchesByIds: vi.fn(() => []),
    getMutationReceipt: vi.fn(),
    getQuestion: vi.fn(),
    answerQuestion: vi.fn(() => ({
      message: { id: 'message-answer' },
      question: { status: 'answered' },
      duplicate: false
    }))
  }
}

function fakeRuntime(firstDb = fakeDb('run-1')) {
  let db = firstDb
  const realShowTerminal = vi.fn(async (handle: string) => ({ handle, worktreeId: 'unrelated' }))
  const runtime = {
    mutationCount: 0,
    getOrchestrationDb: vi.fn(() => db),
    showTerminal: realShowTerminal,
    getTerminalPaneKey: vi.fn(() => null),
    getClientSettings: vi.fn(() => null),
    ensureStructuredAgentSessionHost: vi.fn(async () => undefined),
    inspectTerminalProcessIncarnationLiveness: vi.fn(
      async (): Promise<'live' | 'exited' | 'unverifiable'> => 'unverifiable'
    ),
    ensureOrchestrationFederationRelay: vi.fn(),
    notifyMessageArrived: vi.fn(),
    recordRuntimeMutation() {
      this.mutationCount += 1
    }
  }
  return {
    runtime,
    realShowTerminal,
    replaceDb(next: FakeDatabase) {
      db = next
    }
  }
}

function createAdapter(
  world: ReturnType<typeof fakeRuntime>,
  persistence: HeimdallOrchestrationPersistence = {
    persistOrchestrationRunId: async () => undefined
  }
): RuntimeHeimdallOrchestrationAdapter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fakeRuntime() implements only the QuirkyRuntimeService members this adapter calls, not the full interface.
  return new RuntimeHeimdallOrchestrationAdapter(world.runtime as never, persistence)
}

function invokeMutation() {
  upstream.mutationRun.mockImplementation(
    async (
      request: { method: string },
      _params: unknown,
      invoke: (mutation: {
        identity: {
          callerFingerprint: string
          requestId: string
          method: string
          payloadHash: string
        }
      }) => Promise<unknown>
    ) =>
      invoke({
        identity: {
          callerFingerprint: 'caller-fingerprint',
          requestId: 'request-id',
          method: request.method,
          payloadHash: 'payload-hash'
        }
      })
  )
}

describe('Heimdall orchestration adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invokeMutation()
    upstream.startLocalWorker.mockResolvedValue({ state: 'ready', dispatchId: 'dispatch-1' })
    upstream.resolveRunScope.mockReturnValue({
      id: 'run-1',
      consumer_generation: 1,
      coordinator_handle: IDENTITY.handle,
      coordinator_pane_key: IDENTITY.paneKey
    })
    upstream.inspectWorkerTerminal.mockResolvedValue({
      terminal: null,
      exact: true,
      status: 'live'
    })
    upstream.listWorkers.mockResolvedValue({
      workers: [],
      counts: {},
      page: { limit: 100, total: 0, hasMore: false, nextCursor: null }
    })
    upstream.stopWorker.mockResolvedValue({
      state: 'stopped',
      alreadySettled: false,
      processAction: 'closed_agent_terminal'
    })
  })

  it('creates one run, persists it, and reuses the pane-bound run on a second call', async () => {
    const { runtime } = fakeRuntime()
    const persist = vi.fn(async () => undefined)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fakeRuntime() implements only the QuirkyRuntimeService members this adapter calls, not the full interface.
    const adapter = new RuntimeHeimdallOrchestrationAdapter(runtime as never, {
      persistOrchestrationRunId: persist
    })
    const watched = enrollment()

    await expect(adapter.ensureRun(watched)).resolves.toEqual({ runId: 'run-1' })
    await expect(adapter.ensureRun(watched)).resolves.toEqual({ runId: 'run-1' })

    const db = runtime.getOrchestrationDb()
    expect(db.createRun).toHaveBeenCalledOnce()
    expect(db.createRun).toHaveBeenCalledWith({
      objective: 'Supervise Heimdall watcher watcher-1',
      coordinatorHandle: IDENTITY.handle,
      coordinatorPaneKey: IDENTITY.paneKey
    })
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('fetches the current orchestration database for every call', async () => {
    const first = fakeDb('run-1')
    const second = fakeDb('run-2')
    const world = fakeRuntime(first)
    const adapter = createAdapter(world)

    await adapter.ensureRun(enrollment())
    world.replaceDb(second)
    await adapter.ensureRun(
      enrollment({
        watcherId: 'watcher-2',
        coordinatorIdentity: {
          handle: 'heimdall-coordinator-2',
          paneKey: 'heimdall-pane-2'
        }
      })
    )

    expect(first.createRun).toHaveBeenCalledOnce()
    expect(second.createRun).toHaveBeenCalledOnce()
    expect(world.runtime.getOrchestrationDb).toHaveBeenCalledTimes(2)
  })

  it('uses the stable attempt-derived mutation request and the exact enrolled workspace', async () => {
    const world = fakeRuntime()
    const adapter = createAdapter(world)
    const watched = enrollment({ orchestrationRunId: 'run-1' })

    await expect(
      adapter.dispatchWorker({
        enrollment: watched,
        spec: 'Commit locally; do not publish.',
        agent: 'codex',
        taskKey: 'prepare-fix',
        deps: ['task-plan', 'task-schema'],
        attemptFingerprint: 'content:prepare-fix:evidence'
      })
    ).resolves.toEqual({ status: 'dispatched', dispatchId: 'dispatch-1' })

    const [request, params] = upstream.mutationRun.mock.calls[0]!
    expect(request).toMatchObject({
      method: 'orchestration.workerStart',
      orchestrationRequestId: orchestrationRequestIdForAttemptFingerprint(
        'content:prepare-fix:evidence'
      )
    })
    expect(params).toMatchObject({
      from: IDENTITY.handle,
      worktree: 'id:repo-1::/repo',
      spec: 'Commit locally; do not publish.',
      agent: 'codex',
      deps: JSON.stringify(['task-plan', 'task-schema']),
      taskTitle: 'prepare-fix'
    })

    const workerArgs = upstream.startLocalWorker.mock.calls[0]![0]
    await expect(workerArgs.runtime.showTerminal(IDENTITY.handle)).resolves.toMatchObject({
      worktreeId: 'repo-1::/repo'
    })
    await expect(workerArgs.runtime.showTerminal('real-terminal')).resolves.toMatchObject({
      worktreeId: 'unrelated'
    })
    expect(workerArgs.runtime.getTerminalPaneKey(IDENTITY.handle)).toBe(IDENTITY.paneKey)
    expect(workerArgs.runtime.getTerminalPaneKey('real-terminal')).toBeNull()
    workerArgs.runtime.recordRuntimeMutation()
    expect(world.runtime.mutationCount).toBe(1)
    expect(workerArgs.coordinator).toMatchObject({
      terminalHandle: IDENTITY.handle,
      paneKey: IDENTITY.paneKey
    })
  })

  it('returns a typed refusal when orchestration dependencies are not startable', async () => {
    const world = fakeRuntime()
    upstream.mutationRun.mockRejectedValueOnce(
      new OrchestrationError('task_not_startable', 'dependency task failed')
    )
    const adapter = createAdapter(world)

    await expect(
      adapter.dispatchWorker({
        enrollment: enrollment({ orchestrationRunId: 'run-1' }),
        spec: 'Implement the ready node.',
        deps: ['failed-task'],
        attemptFingerprint: 'blocked-dependency'
      })
    ).resolves.toEqual({
      status: 'refused',
      reason: 'capability-invalid',
      detail: 'dependency task failed'
    })
  })

  it('settles a pre-dispatch database failure and permits later work', async () => {
    const db = fakeDb('run-1')
    const world = fakeRuntime(db)
    world.runtime.getOrchestrationDb
      .mockImplementationOnce(() => db)
      .mockImplementationOnce(() => {
        throw new Error('database unavailable')
      })
    const adapter = createAdapter(world)
    const watched = enrollment()

    await expect(
      adapter.dispatchWorker({
        enrollment: watched,
        spec: 'first work',
        attemptFingerprint: 'pre-dispatch-database-failure'
      })
    ).resolves.toEqual({
      status: 'refused',
      reason: 'pre-dispatch-failure',
      detail: 'database unavailable'
    })
    expect(upstream.mutationRun).not.toHaveBeenCalled()
    expect(upstream.startLocalWorker).not.toHaveBeenCalled()

    await expect(
      adapter.dispatchWorker({
        enrollment: watched,
        spec: 'later work',
        attemptFingerprint: 'later-work'
      })
    ).resolves.toEqual({ status: 'dispatched', dispatchId: 'dispatch-1' })
    expect(upstream.mutationRun).toHaveBeenCalledOnce()
    expect(upstream.startLocalWorker).toHaveBeenCalledOnce()
  })

  it('routes a folder repo through its authoritative root worktree identity', async () => {
    const world = fakeRuntime()
    const adapter = createAdapter(world)

    await adapter.dispatchWorker({
      enrollment: enrollment({
        repoId: 'folder-1',
        worktreeId: null,
        orchestrationRunId: 'run-1'
      }),
      spec: 'work in this folder',
      attemptFingerprint: 'folder-attempt'
    })

    expect(upstream.mutationRun.mock.calls[0]![1]).toMatchObject({
      worktree: 'id:folder-1::/repo'
    })
    const workerArgs = upstream.startLocalWorker.mock.calls[0]![0]
    await expect(workerArgs.runtime.showTerminal(IDENTITY.handle)).resolves.toMatchObject({
      worktreeId: 'folder-1::/repo'
    })
  })

  it('answers through the currently fenced consumer generation', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getQuestion.mockReturnValue({
      message_id: 'message-question',
      run_id: 'run-1',
      dispatch_id: 'dispatch-1'
    })
    const adapter = createAdapter(world)

    await adapter.answerQuestion(
      enrollment({ orchestrationRunId: 'run-1' }),
      'message-question',
      'Use the prepared commit.'
    )

    expect(db.answerQuestion).toHaveBeenCalledWith({
      messageId: 'message-question',
      runId: 'run-1',
      consumerGeneration: 1,
      body: 'Use the prepared commit.'
    })
    expect(world.runtime.notifyMessageArrived).toHaveBeenCalledWith('dispatch:dispatch-1', 'status')
    expect(db.enqueueFederationRelay).not.toHaveBeenCalled()
  })

  it('translates an answer race without writing a second answer', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getQuestion.mockReturnValue({
      message_id: 'message-question',
      run_id: 'run-1',
      dispatch_id: 'dispatch-1'
    })
    db.answerQuestion.mockImplementation(() => {
      throw new OrchestrationError('answer_conflict', 'another answer won')
    })
    const adapter = createAdapter(world)

    await expect(
      adapter.answerQuestion(
        enrollment({ orchestrationRunId: 'run-1' }),
        'message-question',
        'Use the prepared commit.'
      )
    ).rejects.toBeInstanceOf(QuestionAlreadyAnsweredError)
    expect(db.answerQuestion).toHaveBeenCalledOnce()
  })

  it('returns no workers without opening an orchestration database or Run', async () => {
    const world = fakeRuntime()
    const adapter = createAdapter(world)

    await expect(adapter.listWorkers(enrollment())).resolves.toEqual([])
    expect(world.runtime.getOrchestrationDb).not.toHaveBeenCalled()
    expect(upstream.listWorkers).not.toHaveBeenCalled()
  })

  it('aggregates active Run workers across stable inventory pages', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    const dispatches: Record<string, Record<string, unknown>> = {
      'dispatch-live': {
        id: 'dispatch-live',
        run_id: 'run-1',
        dispatched_at: '2026-09-15 12:00:00',
        created_at: '2026-09-15 11:59:00',
        last_heartbeat_at: '2026-09-15 12:02:00'
      },
      'dispatch-unreachable': {
        id: 'dispatch-unreachable',
        run_id: 'run-1',
        dispatched_at: '2026-09-15 12:03:00',
        created_at: '2026-09-15 12:03:00',
        last_heartbeat_at: '2026-09-15 12:04:00'
      }
    }
    db.getDispatchContextById.mockImplementation((dispatchId: string) => dispatches[dispatchId])
    db.listTasks.mockReturnValue([
      {
        id: 'task-live',
        display_name: 'Implement fleet controls',
        task_title: 'fleet controls',
        spec: 'Full implementation spec'
      },
      {
        id: 'task-unreachable',
        display_name: null,
        task_title: null,
        spec: 'Inspect the unreachable worker'
      }
    ])
    db.db.prepare.mockReturnValue({
      all: vi.fn(() => [
        {
          message_id: 'question-1',
          dispatch_id: 'dispatch-live',
          body: 'Which host should own this?'
        }
      ])
    })
    upstream.listWorkers
      .mockResolvedValueOnce({
        workers: [
          {
            dispatchId: 'dispatch-live',
            taskId: 'task-live',
            runId: 'run-1',
            dispatchStatus: 'dispatched',
            projection: {
              liveness: { verdict: 'live' },
              evidence: { lastObservedAt: Date.parse('2026-09-15T12:01:00Z') }
            }
          },
          {
            dispatchId: 'dispatch-settled',
            taskId: 'task-settled',
            runId: 'run-1',
            dispatchStatus: 'completed',
            projection: {
              liveness: { verdict: 'exited' },
              evidence: { lastObservedAt: null }
            }
          }
        ],
        page: { hasMore: true, nextCursor: 'stable-page-2' }
      })
      .mockResolvedValueOnce({
        workers: [
          {
            dispatchId: 'dispatch-unreachable',
            taskId: 'task-unreachable',
            runId: 'run-1',
            dispatchStatus: 'dispatched',
            projection: {
              liveness: { verdict: 'unverifiable', reason: 'host_unavailable' },
              evidence: { lastObservedAt: null }
            }
          }
        ],
        page: { hasMore: false, nextCursor: null }
      })
    const adapter = createAdapter(world)

    await expect(adapter.listWorkers(enrollment({ orchestrationRunId: 'run-1' }))).resolves.toEqual(
      [
        {
          dispatchId: 'dispatch-live',
          task: 'Implement fleet controls',
          dispatchedAtMs: Date.parse('2026-09-15T12:00:00Z'),
          lastContactAtMs: Date.parse('2026-09-15T12:02:00Z'),
          liveness: 'live',
          reason: null,
          question: { messageId: 'question-1', body: 'Which host should own this?' },
          navigation: null
        },
        {
          dispatchId: 'dispatch-unreachable',
          task: 'Inspect the unreachable worker',
          dispatchedAtMs: Date.parse('2026-09-15T12:03:00Z'),
          lastContactAtMs: Date.parse('2026-09-15T12:04:00Z'),
          liveness: 'unverifiable',
          reason: 'host_unavailable',
          question: null,
          navigation: null
        }
      ]
    )
    expect(upstream.listWorkers.mock.calls).toEqual([
      [{ run: 'run-1', includeRemote: true, paginate: true }, { runtime: world.runtime }],
      [
        {
          run: 'run-1',
          includeRemote: true,
          paginate: true,
          cursor: 'stable-page-2'
        },
        { runtime: world.runtime }
      ]
    ])
  })

  it('stops only an exact worker in the watcher Run through the durable host path', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getDispatchContextById.mockReturnValue({
      id: 'dispatch-1',
      run_id: 'run-1',
      process_incarnation: 'runtime:pty:incarnation-1'
    })
    db.getWorkerDispatch.mockReturnValue({ state: 'ready' })
    const adapter = createAdapter(world)

    await expect(
      adapter.stopWorker(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-1')
    ).resolves.toMatchObject({ status: 'applied', appliedAtMs: expect.any(Number) })
    expect(upstream.mutationRun.mock.calls[0]![0]).toMatchObject({
      method: 'orchestration.workerStop',
      params: { dispatch: 'dispatch-1' },
      orchestrationRequestId: expect.stringMatching(/^heimdall-stop-worker-/)
    })
    expect(upstream.stopWorker).toHaveBeenCalledWith(
      { dispatch: 'dispatch-1' },
      {
        runtime: world.runtime,
        orchestrationMutation: expect.objectContaining({
          method: 'orchestration.workerStop'
        })
      }
    )
  })

  it('accepts a federated worker only with its exact remote process identity', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getDispatchContextById.mockReturnValue({
      id: 'dispatch-remote',
      run_id: 'run-1',
      process_incarnation: null
    })
    db.getWorkerDispatch.mockReturnValue({ state: 'ready' })
    db.getFederatedDispatch.mockReturnValue({
      remote_runtime_epoch: 'remote-epoch',
      remote_terminal_handle: 'terminal-remote'
    })
    const adapter = createAdapter(world)

    await expect(
      adapter.stopWorker(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-remote')
    ).resolves.toMatchObject({ status: 'applied' })
    expect(upstream.stopWorker).toHaveBeenCalledWith(
      { dispatch: 'dispatch-remote' },
      expect.objectContaining({ runtime: world.runtime })
    )
  })

  it('refuses a pre-send host failure without claiming the worker stopped', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getDispatchContextById.mockReturnValue({
      id: 'dispatch-1',
      run_id: 'run-1',
      process_incarnation: 'runtime:pty:incarnation-1'
    })
    db.getWorkerDispatch.mockReturnValue({ state: 'ready' })
    upstream.stopWorker.mockRejectedValue(
      new OrchestrationError('server_required', 'Worker host is unavailable')
    )
    const adapter = createAdapter(world)

    await expect(
      adapter.stopWorker(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-1')
    ).resolves.toEqual({
      status: 'refused',
      reason: 'worker-unverifiable',
      detail: 'Worker host is unavailable'
    })
  })

  it('rechecks the coordinator seat inside the durable stop invocation', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getDispatchContextById.mockReturnValue({
      id: 'dispatch-1',
      run_id: 'run-1',
      process_incarnation: 'runtime:pty:incarnation-1'
    })
    db.getWorkerDispatch.mockReturnValue({ state: 'ready' })
    upstream.resolveRunScope
      .mockReturnValueOnce({
        id: 'run-1',
        consumer_generation: 1,
        coordinator_handle: IDENTITY.handle,
        coordinator_pane_key: IDENTITY.paneKey
      })
      .mockImplementationOnce(() => {
        throw new OrchestrationError('consumer_fenced', 'Coordinator seat changed')
      })
    const adapter = createAdapter(world)

    await expect(
      adapter.stopWorker(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-1')
    ).rejects.toBeInstanceOf(CoordinatorSeatLostError)
    expect(upstream.stopWorker).not.toHaveBeenCalled()
  })

  it.each([
    [
      { state: 'stop_unknown', processAction: 'none', lastError: 'identity changed' },
      {
        status: 'refused',
        reason: 'worker-unverifiable',
        detail: 'identity changed'
      }
    ],
    [
      { state: 'stop_unknown', processAction: 'unknown', lastError: 'connection lost' },
      { status: 'indeterminate', detail: 'connection lost' }
    ]
  ])('preserves an unconfirmed stop receipt as %j', async (receipt, expected) => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getDispatchContextById.mockReturnValue({
      id: 'dispatch-1',
      run_id: 'run-1',
      process_incarnation: 'runtime:pty:incarnation-1'
    })
    db.getWorkerDispatch.mockReturnValue({ state: 'ready' })
    upstream.stopWorker.mockResolvedValue(receipt)
    const adapter = createAdapter(world)

    await expect(
      adapter.stopWorker(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-1')
    ).resolves.toEqual(expected)
  })

  it('refuses a dispatch outside the watcher Run before invoking the stop path', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getDispatchContextById.mockReturnValue({
      id: 'dispatch-other',
      run_id: 'run-other',
      process_incarnation: 'runtime:pty:other'
    })
    const adapter = createAdapter(world)

    await expect(
      adapter.stopWorker(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-other')
    ).resolves.toMatchObject({ status: 'refused', reason: 'worker-unverifiable' })
    expect(upstream.mutationRun).not.toHaveBeenCalled()
    expect(upstream.stopWorker).not.toHaveBeenCalled()
  })

  it('refuses a dispatch outside the watcher Run before invoking the release path', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getDispatchContextById.mockReturnValue({
      id: 'dispatch-other',
      run_id: 'run-other'
    })
    const adapter = createAdapter(world)

    await expect(
      adapter.releaseWorker(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-other')
    ).rejects.toMatchObject({
      code: 'dispatch_run_mismatch',
      message: 'Dispatch dispatch-other could not be verified in watcher Run run-1'
    })
    expect(upstream.mutationRun).not.toHaveBeenCalled()
    expect(upstream.releaseWorker).not.toHaveBeenCalled()
  })

  it.each(['consumer_fenced', 'run_not_found'] as const)(
    'parks a persisted identity when %s means its seat no longer resolves',
    async (code) => {
      const world = fakeRuntime()
      upstream.resolveRunScope.mockImplementation(() => {
        throw new OrchestrationError(code, 'seat missing')
      })
      const adapter = createAdapter(world)

      await expect(
        adapter.ensureRun(enrollment({ orchestrationRunId: 'run-lost' }))
      ).rejects.toBeInstanceOf(CoordinatorSeatLostError)
      expect(world.runtime.getOrchestrationDb().createRun).not.toHaveBeenCalled()
    }
  )

  it('keeps a pending receipt indeterminate without retrying it', async () => {
    const world = fakeRuntime()
    const adapter = createAdapter(world)
    const input = {
      enrollment: enrollment({ orchestrationRunId: 'run-1' }),
      spec: 'work',
      attemptFingerprint: 'stable-attempt'
    }
    upstream.mutationRun.mockRejectedValueOnce(
      new OrchestrationError('operation_unknown', 'pending receipt')
    )
    await expect(adapter.dispatchWorker(input)).resolves.toEqual({
      status: 'indeterminate',
      requestId: orchestrationRequestIdForAttemptFingerprint('stable-attempt')
    })
    expect(upstream.mutationRun).toHaveBeenCalledOnce()
  })

  it('keeps an unclassified failure after worker start crosses the effect boundary indeterminate', async () => {
    const world = fakeRuntime()
    upstream.startLocalWorker.mockRejectedValueOnce(new Error('worker start response lost'))
    const adapter = createAdapter(world)

    await expect(
      adapter.dispatchWorker({
        enrollment: enrollment({ orchestrationRunId: 'run-1' }),
        spec: 'work',
        attemptFingerprint: 'ambiguous-worker-start'
      })
    ).resolves.toEqual({
      status: 'indeterminate',
      requestId: orchestrationRequestIdForAttemptFingerprint('ambiguous-worker-start')
    })
    expect(upstream.startLocalWorker).toHaveBeenCalledOnce()
  })

  it('recovers only an existing receipt and reports a missing receipt without creating it', async () => {
    const db = fakeDb('run-1')
    const world = fakeRuntime(db)
    const adapter = createAdapter(world)
    const input = {
      enrollment: enrollment({ orchestrationRunId: 'run-1' }),
      spec: 'work',
      attemptFingerprint: 'attempt-recovery'
    }
    const requestId = orchestrationRequestIdForAttemptFingerprint('attempt-recovery')
    const payloadHash = hashCanonical({
      method: 'orchestration.workerStart',
      params: {
        spec: 'work',
        from: IDENTITY.handle,
        worktree: 'id:repo-1::/repo'
      }
    })

    await expect(adapter.recoverDispatch({ ...input, enrollment: enrollment() })).resolves.toEqual({
      status: 'absent'
    })
    await expect(adapter.recoverDispatch(input)).resolves.toEqual({ status: 'absent' })

    db.getMutationReceipt.mockReturnValue({
      method: 'orchestration.workerStart',
      payload_hash: payloadHash,
      state: 'pending',
      receipt: null
    })
    await expect(adapter.recoverDispatch(input)).resolves.toEqual({
      status: 'indeterminate',
      requestId
    })

    db.getMutationReceipt.mockReturnValue({
      method: 'orchestration.workerStart',
      payload_hash: payloadHash,
      state: 'completed',
      receipt: JSON.stringify({ state: 'ready', dispatchId: 'dispatch-recovered' })
    })
    await expect(adapter.recoverDispatch(input)).resolves.toEqual({
      status: 'dispatched',
      dispatchId: 'dispatch-recovered'
    })

    expect(db.createRun).not.toHaveBeenCalled()
    expect(upstream.mutationRun).not.toHaveBeenCalled()
    expect(upstream.startLocalWorker).not.toHaveBeenCalled()
  })

  it('maps a superseded coordinator generation to a fenced refusal', async () => {
    const world = fakeRuntime()
    const adapter = createAdapter(world)
    upstream.resolveRunScope.mockImplementation(() => {
      throw new OrchestrationError('consumer_fenced', 'seat replaced')
    })

    await expect(
      adapter.dispatchWorker({
        enrollment: enrollment({ orchestrationRunId: 'run-1' }),
        spec: 'work',
        attemptFingerprint: 'attempt'
      })
    ).resolves.toEqual({
      status: 'refused',
      reason: 'fenced',
      detail: expect.stringContaining('seat replaced')
    })
    expect(upstream.mutationRun).not.toHaveBeenCalled()
  })

  it('uses authoritative execution-host evidence and never calls a disconnect exited', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getDispatchContextById.mockReturnValue({
      id: 'dispatch-1',
      run_id: 'run-1',
      assignee_handle: 'term-worker',
      process_incarnation: 'remote:ssh-1:pty-1:incarnation-1',
      host_scope: JSON.stringify({ kind: 'ssh', targetId: 'ssh-1' })
    })
    upstream.inspectWorkerTerminal.mockResolvedValue({
      terminal: null,
      exact: false,
      status: 'missing'
    })
    world.runtime.inspectTerminalProcessIncarnationLiveness.mockRejectedValueOnce(
      new Error('SSH transport disconnected')
    )
    const adapter = createAdapter(world)

    await expect(
      adapter.readDispatch(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-1')
    ).resolves.toEqual({ status: 'unverifiable', reason: 'SSH transport disconnected' })

    world.runtime.inspectTerminalProcessIncarnationLiveness.mockResolvedValueOnce('exited')
    await expect(
      adapter.readDispatch(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-1')
    ).resolves.toEqual({ status: 'exited' })
  })

  it('installs and observes the structured worker host before classifying its dispatch', async () => {
    const world = fakeRuntime()
    const db = world.runtime.getOrchestrationDb()
    db.getDispatchContextById.mockReturnValue({
      id: 'dispatch-structured',
      run_id: 'run-1',
      assignee_handle: 'structworker_session-1',
      process_incarnation: 'structured:session-1',
      host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
    })
    upstream.inspectWorkerTerminal.mockResolvedValue({
      terminal: null,
      exact: true,
      status: 'live'
    })
    const adapter = createAdapter(world)

    await expect(
      adapter.readDispatch(enrollment({ orchestrationRunId: 'run-1' }), 'dispatch-structured')
    ).resolves.toEqual({ status: 'live' })
    expect(world.runtime.ensureStructuredAgentSessionHost).toHaveBeenCalledOnce()
  })
})
