import type { PluginContext, PluginStore, Session } from '@quirky/protocol'
import type {
  DispatchId, DispatchRow, JsonValue, MutationRequest, MutationResult,
  RunId, RuntimeCallerEvidence, TaskId, TaskRow, UtcTimestamp
} from '../../src/contracts'
import type {
  CoordinatorEvidence, TerminalResource, WorkerArchive, WorkerCore, WorkerObservation, WorkerRecord, WorkerRepository, WorkerRuntime
} from '../../src/worker-contracts'
import type { SessionIdentity } from '../../src/runtime-contracts'

const now = (): UtcTimestamp => new Date().toISOString()

export const sessionFixture = (overrides: Partial<Session> = {}): Session => {
  const agent = overrides.agent ?? 'claude'
  const label = agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : agent === 'qwen-code' ? 'Qwen Code' : agent
  return {
    id: 'worker-session',
    kind: 'terminal',
    agent,
    worktreeId: 'wt-main',
    cwd: '/tmp/worker',
    title: 'Worker task',
    status: 'running',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false,
    launchSettings: { agent, options: { model: { value: 'sonnet', source: 'explicit' } }, summary: `${label} · Sonnet` },
    providerSession: { id: 'provider-session', transcriptPath: '/private/captured/session.jsonl' },
    ...overrides
  }
}

const identityFixture = (session: Session, incarnation = 'incarnation-1', providerId = session.agent): SessionIdentity => ({
  sessionId: session.id,
  live: true,
  runtimeEpoch: 'session-epoch-1',
  processIncarnation: incarnation,
  source: session.kind === 'structured' ? 'structured_lease' : 'terminal_launch',
  kind: session.kind,
  providerId,
  worktreeId: session.worktreeId
})

export const makeDispatch = (index = 1, run: RunId = 'run_1' as RunId, overrides: Partial<DispatchRow> = {}): DispatchRow => {
  const id = `ctx_${String(index).padStart(4, '0')}` as DispatchId
  const at = now()
  return {
    id,
    runId: run,
    taskId: `task_${String(index).padStart(4, '0')}` as TaskId,
    contractVersion: 1,
    status: 'dispatched',
    assigneeSessionId: `coordinator-${run}`,
    creatorSessionId: `coordinator-${run}`,
    creatorDispatchId: null,
    retryOfDispatchId: null,
    depth: 0,
    failureCount: 0,
    lastFailure: null,
    terminationReason: null,
    consumerGeneration: 1,
    createdAt: new Date(Date.now() + index).toISOString(),
    dispatchedAt: at,
    completedAt: null,
    lastHeartbeatAt: at,
    ...overrides
  }
}

export const makeTask = (dispatch: DispatchRow, overrides: Partial<TaskRow> = {}): TaskRow => ({
  id: dispatch.taskId,
  runId: dispatch.runId,
  parentTaskId: null,
  dependencyTaskIds: [],
  createdBySessionId: dispatch.assigneeSessionId ?? 'coordinator-session',
  taskTitle: `Task ${dispatch.taskId}`,
  displayName: `Task ${dispatch.taskId}`,
  spec: `Complete ${dispatch.taskId}`,
  status: 'dispatched',
  result: null,
  createdAt: dispatch.createdAt,
  completedAt: null,
  ...overrides
})

export const makeRecord = (dispatch: DispatchRow, sessionId = `session-${dispatch.id}`, overrides: Partial<WorkerRecord> = {}): WorkerRecord => ({
  dispatchId: dispatch.id,
  state: 'ready',
  stage: 'ready',
  worktreeId: 'wt-main',
  sessionId,
  setupState: 'ready',
  effects: [],
  residualResources: [],
  lastError: null,
  createdAt: dispatch.createdAt,
  updatedAt: dispatch.createdAt,
  runtimeEpoch: 'supervisor-epoch-1',
  processRuntimeEpoch: 'session-epoch-1',
  processIncarnation: 'incarnation-1',
  mode: 'terminal',
  startOptions: { requestId: `request-${dispatch.id}`, contractVersion: 1, worktree: 'wt-main' },
  receipt: null,
  ...overrides
})

export const makeResource = (dispatch: DispatchRow, sessionId = 'worker-session', overrides: Partial<TerminalResource> = {}): TerminalResource => ({
  id: `resource-${dispatch.id}`,
  originDispatchId: dispatch.id,
  ownerDispatchId: dispatch.id,
  priorOwnerDispatchIds: [],
  worktreeId: 'wt-main',
  sessionId,
  processIncarnation: 'incarnation-1',
  ownershipState: 'owned',
  releaseState: 'not_requested',
  retainedReason: null,
  releaseRequestedAt: null,
  releaseCompletedAt: null,
  releaseError: null,
  recoveryAttemptCount: 0,
  lastRecoveryAt: null,
  archiveSource: null,
  archiveStatus: null,
  ...overrides
})

export interface HarnessOptions {
  dispatches?: DispatchRow[]
  records?: WorkerRecord[]
  resources?: TerminalResource[]
  session?: Session
  observation?: WorkerObservation
  transcript?: { path: string; text: string } | Error
  structuredMessages?: readonly { sessionId: string; seq: number; role: string; text: string; at: number }[]
  terminalLines?: string[]
  terminalScreenLines?: string[]
  status?: unknown
  boundRunId?: RunId | null
  attention?: { guidance?: boolean; input?: boolean; approval?: boolean; rootCompletion?: boolean }
}

export interface Harness {
  core: WorkerCore
  repo: WorkerRepository
  runtime: WorkerRuntime
  dispatches: DispatchRow[]
  records: WorkerRecord[]
  resources: TerminalResource[]
  calls: Array<{ method: string; params: Record<string, unknown> }>
  archives: Map<DispatchId, WorkerArchive>
  addDispatch(dispatch: DispatchRow, record?: WorkerRecord, resource?: TerminalResource): void
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const dispatches = options.dispatches ?? [makeDispatch()]
  const records = options.records ?? dispatches.map((dispatch) => makeRecord(dispatch, options.session?.id ?? 'worker-session'))
  const resources = options.resources ?? dispatches.map((dispatch) => makeResource(dispatch, options.session?.id ?? 'worker-session'))
  const tasks = new Map(dispatches.map((dispatch) => [dispatch.taskId, makeTask(dispatch)]))
  const calls: Harness['calls'] = []
  const archives = new Map<DispatchId, WorkerArchive>()
  const session = options.session ?? sessionFixture()
  const transcript = options.transcript ?? { path: session.providerSession?.transcriptPath ?? '', text: '' }
  const fallbackObservation = (record: WorkerRecord | null): WorkerObservation => {
    if (!record?.sessionId || !record.processIncarnation) {
      return { status: 'missing', exactWorker: false, reason: 'missing_status', identity: null, session: null }
    }
    const exactSession = session.id === record.sessionId ? session : sessionFixture({ id: record.sessionId })
    return {
      status: 'live', exactWorker: true, reason: null,
      identity: identityFixture(exactSession, record.processIncarnation), session: exactSession,
      agentWait: { waiting: false, source: 'hook', reason: null }
    }
  }
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      calls.push({ method, params })
      if (method === 'quirky.session/get') return session.id === params.session ? session : null
      if (method === 'quirky.session-info/transcript') {
        if (transcript instanceof Error) throw transcript
        return transcript
      }
      if (method === 'quirky.structured/messages') return options.structuredMessages ?? []
      if (method === 'quirky.terminal/history') return { lines: options.terminalLines ?? ['captured terminal output'], cursor: null }
      if (method === 'quirky.agent-status/get') {
        if ('status' in options) return options.status
        return {
          state: 'working', display: 'working', label: 'working', detail: 'working',
          stateStartedAt: Date.now(), evidenceAt: Date.now(), restoredUnconfirmed: false,
          sessionId: params.session, agent: session.agent
        }
      }
      throw new Error(`unexpected public method ${method}`)
    },
    pty: {
      read: async (_sessionId: string, lines: number) => ({
        lines: lines === 0 ? options.terminalScreenLines ?? [] : [],
        cols: 80,
        rows: 24,
        alt: false
      })
    },
    error: (kind: string, message: string) => Object.assign(new Error(message), { kind })
  } as unknown as PluginContext
  const repository = {
    store: {} as PluginStore,
    get: (id: DispatchId) => records.find((record) => record.dispatchId === id) ?? null,
    insert: (record: WorkerRecord) => { records.push(record) },
    update: (id: DispatchId, patch: Partial<WorkerRecord>) => {
      const current = records.find((record) => record.dispatchId === id)
      if (!current) throw new Error(`missing record ${id}`)
      Object.assign(current, patch)
      return current
    },
    list: () => [...records],
    resource: (id: DispatchId) => resources.find((resource) => resource.ownerDispatchId === id || resource.originDispatchId === id) ?? null,
    resourceBySession: (id: string) => resources.find((resource) => resource.sessionId === id) ?? null,
    putResource: (resource: TerminalResource) => {
      const index = resources.findIndex((item) => item.id === resource.id)
      if (index < 0) resources.push(resource)
      else resources[index] = resource
    },
    archive: (id: DispatchId) => archives.get(id) ?? null,
    putArchive: (archive: WorkerArchive) => { archives.set(archive.dispatchId, archive) },
    deleteArchive: (id: DispatchId) => { archives.delete(id) },
    addObservation: (_id: DispatchId, _facet: string, _payload: JsonValue) => undefined,
    reconcile: (_epoch: string) => undefined
  } as WorkerRepository
  const core = {
    context,
    store: repository.store,
    nestedWorkerMaxDepth: 1,
    getDispatch: (id: DispatchId) => dispatches.find((dispatch) => dispatch.id === id) ?? (() => { throw new Error(`missing dispatch ${id}`) })(),
    getTask: (id: TaskId) => tasks.get(id) ?? (() => { throw new Error(`missing task ${id}`) })(),
    getRun: (id: RunId) => ({ id, objective: 'fixture', coordinatorSessionId: null, coordinatorHistory: [], consumerGeneration: 1, createdAt: now(), updatedAt: now() }),
    mutateWorker: async <T extends object>(
      _method: string,
      params: MutationRequest & object,
      _caller: CoordinatorEvidence,
      operation: (store: PluginStore) => T
    ): Promise<MutationResult<T>> => ({
      ...operation(repository.store),
      mutation: { requestId: params.requestId, replayed: false }
    }),
    listDispatches: () => [...dispatches],
    boundRunId: (_caller: RuntimeCallerEvidence) => options.boundRunId ?? null,
    attentionFor: (_id: DispatchId) => ({ guidance: options.attention?.guidance ?? false, input: options.attention?.input ?? false, approval: options.attention?.approval ?? false, rootCompletion: options.attention?.rootCompletion ?? false })
  } as unknown as WorkerCore
  const runtime = {
    context,
    epoch: 'supervisor-epoch-1',
    observe: async (record: WorkerRecord | null, _dispatch: DispatchRow) => options.observation ?? fallbackObservation(record),
    validate: async () => { throw new Error('unused in output/fleet tests') },
    place: async () => { throw new Error('unused in output/fleet tests') },
    waitReady: async () => undefined,
    submit: async () => 'unobserved' as const,
    close: async () => ({ closed: false, reason: 'unused in output/fleet tests' }),
    dispose: () => undefined
  } as unknown as WorkerRuntime
  return {
    core, repo: repository, runtime, dispatches, records, resources, calls, archives,
    addDispatch(dispatch, record, resource) {
      dispatches.push(dispatch)
      tasks.set(dispatch.taskId, makeTask(dispatch))
      if (record) records.push(record)
      if (resource) resources.push(resource)
    }
  }
}

export function callerFixture(): RuntimeCallerEvidence {
  return {
    callerSessionId: 'coordinator-session', runtimeSessionId: 'coordinator-session', runtimeOwned: true, live: true,
    attestation: { source: 'terminal_launch', runtimeEpoch: 'epoch-1', processIncarnation: 'coordinator-incarnation' }
  }
}
