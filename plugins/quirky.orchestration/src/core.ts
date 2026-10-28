import { createHash, randomBytes } from 'node:crypto'
import type { PluginContext, PluginStore } from '@quirky/protocol'
import type {
  DispatchAdmissionInput,
  DispatchAdmissionResult,
  DispatchId,
  DispatchRow,
  DispatchStatus,
  DispatchTransitionInput,
  JsonValue,
  MailboxAddress,
  MessageId,
  MessageType,
  MutationRequest,
  MutationCheckpoint,
  MutationResult,
  MutatingOrchestrationMethod,
  RunCreateParams,
  RunCoordinatorAddress,
  RunId,
  RunRow,
  RunUseParams,
  RuntimeCallerEvidence,
  TaskCreateParams,
  TaskId,
  TaskListParams,
  TaskListRow,
  TaskRow,
  TaskStatus,
  TaskTransitionInput,
  TaskResult,
  ResetMode,
  UtcTimestamp,
  WorkerDoneReportInput,
  WorkerHeartbeatInput,
  WorkerReportResult,
  HeartbeatResult,
  WorkerRow,
  WorkerTransitionInput,
  UUID,
  CoordinatorAuthority,
  ServiceRunRow,
} from './contracts'
import type { SessionIdentity } from './runtime-contracts'
import type { DurableMutationOptions, OrchestrationWorkerCore, WorkerLifecyclePort } from './worker-integration'
import { fail } from './errors'

const MAX_TASK_SPEC_BYTES = 1_214_464
export const MAX_NESTED_DEPTH = 1
const CIRCUIT_BREAK_FAILURES = 3
const RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const RECEIPT_MAX_ROWS = 10_000
const RECEIPT_PRUNE_BATCH = 64
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WORKER_MUTATION_METHODS: Record<string, true> = {
  workerStart: true,
  workerStop: true,
  workerAbandon: true,
  workerRelease: true,
  workerRetain: true
}

type RunRecord = {
  id: string
  objective: string
  coordinator_session_id: string | null
  coordinator_history_json: string
  consumer_generation: number
  created_at: string
  updated_at: string
  service_owner_plugin_id: string | null
  service_owner_key: string | null
}

type TaskRecord = {
  id: string
  run_id: string
  parent_task_id: string | null
  dependency_task_ids_json: string
  created_by_session_id: string | null
  created_by_plugin_id: string | null
  created_by_kind: 'session' | 'service'
  task_title: string
  display_name: string
  spec: string
  status: TaskStatus
  result_json: string | null
  created_at: string
  completed_at: string | null
}

type DispatchRecord = {
  id: string
  run_id: string
  task_id: string
  contract_version: number
  status: DispatchStatus
  assignee_session_id: string | null
  creator_session_id: string | null
  creator_dispatch_id: string | null
  retry_of_dispatch_id: string | null
  depth: number
  failure_count: number
  last_failure: string | null
  termination_reason: DispatchRow['terminationReason']
  consumer_generation: number
  supervised: number
  runtime_epoch: string | null
  process_incarnation: string | null
  created_at: string
  dispatched_at: string | null
  creator_plugin_id: string | null
  creator_kind: 'session' | 'service'
  completed_at: string | null
  last_heartbeat_at: string | null
}

export type ReceiptRecord = {
  caller_fingerprint: string
  request_id: string
  method: string
  payload_hash: string
  state: 'pending' | 'completed'
  checkpoint_json: string | null
  result_json: string | null
  created_at: string
  updated_at: string
}

type ActiveMutation = { payloadHash: string; promise: Promise<unknown> }


const jsonOf = <T>(value: string | null | undefined, fallback: T): T =>
  value == null ? fallback : (JSON.parse(value) as T)
const jsonText = (value: unknown): string => JSON.stringify(value) ?? 'null'
const isoNow = (): UtcTimestamp => new Date().toISOString()
const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString('hex')}`
const activeDispatch = (status: DispatchStatus): boolean => status === 'pending' || status === 'dispatched'
const finalDispatch = (status: DispatchStatus): boolean => !activeDispatch(status)

function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

function truncated(text: string, maximum: number): string {
  const value = collapse(text)
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function uuidFromDigest(hex: string): UUID {
  const source = hex.slice(0, 32).split('')
  source[12] = '5'
  source[16] = ((Number.parseInt(source[16]!, 16) & 0x3) | 0x8).toString(16)
  const compact = source.join('')
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
}

function runRow(row: RunRecord): RunRow {
  return {
    id: row.id as RunId,
    objective: row.objective,
    coordinatorSessionId: row.coordinator_session_id,
    coordinatorHistory: jsonOf<RunCoordinatorAddress[]>(row.coordinator_history_json, []),
    consumerGeneration: row.consumer_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function taskRow(row: TaskRecord): TaskRow {
  return {
    id: row.id as TaskId,
    runId: row.run_id as RunId,
    parentTaskId: row.parent_task_id as TaskId | null,
    dependencyTaskIds: jsonOf<TaskId[]>(row.dependency_task_ids_json, []),
    createdBySessionId: row.created_by_session_id,
    taskTitle: row.task_title,
    displayName: row.display_name,
    spec: row.spec,
    status: row.status,
    result: jsonOf<TaskResult | null>(row.result_json, null),
    createdAt: row.created_at,
    completedAt: row.completed_at
  }
}

function dispatchRow(row: DispatchRecord): DispatchRow {
  return {
    id: row.id as DispatchId,
    runId: row.run_id as RunId,
    taskId: row.task_id as TaskId,
    contractVersion: row.contract_version as 1,
    status: row.status,
    assigneeSessionId: row.assignee_session_id,
    creatorSessionId: row.creator_session_id,
    creatorDispatchId: row.creator_dispatch_id as DispatchId | null,
    retryOfDispatchId: row.retry_of_dispatch_id as DispatchId | null,
    depth: row.depth,
    failureCount: row.failure_count,
    lastFailure: row.last_failure,
    terminationReason: row.termination_reason,
    consumerGeneration: row.consumer_generation,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
    lastHeartbeatAt: row.last_heartbeat_at
  }
}

function fingerprint(sessionId: string): string {
  return createHash('sha256').update(`quirky-orchestration-caller\0${sessionId}`).digest('hex')
}
function serviceFingerprint(pluginId: string): string {
  return createHash('sha256').update(`quirky-orchestration-service\0${pluginId}`).digest('hex')
}

function receiptFingerprint(caller: CoordinatorAuthority): string {
  return 'kind' in caller ? serviceFingerprint(caller.pluginId) : fingerprint(caller.runtimeSessionId)
}

function requestDigest(method: string, params: object): string {
  const { requestId: _requestId, ...payload } = params as Record<string, unknown>
  return createHash('sha256').update(canonical({ method, params: payload })).digest('hex')
}

function mutationReplay<T extends object>(value: T, requestId: UUID, replayed: boolean): MutationResult<T> {
  return { ...value, mutation: { requestId, replayed } }
}

export class OrchestrationCore implements OrchestrationWorkerCore {
  readonly context: PluginContext
  readonly store: PluginStore
  private workerPort: WorkerLifecyclePort | null = null
  private readonly activeMutations = new Map<string, ActiveMutation>()
  private bindingListener: ((sessionId: string, runId: RunId, generation: number) => void) | null = null
  private questionsClosedListener: ((messageIds: readonly string[]) => void) | null = null
  private dispatchSettledListener: ((dispatchId: DispatchId) => void) | null = null
  private dispatchFencedListener: ((dispatchId: DispatchId) => void) | null = null
  private messageCommittedListener: ((arrival: { mailbox: MailboxAddress; messageId: MessageId; type: MessageType }) => void) | null = null

  constructor(context: PluginContext, store: PluginStore) {
    this.context = context
    this.store = store
  }

  registerWorkerPort(port: WorkerLifecyclePort): void {
    if (this.workerPort && this.workerPort !== port) throw new Error('orchestration worker lifecycle port is already registered')
    this.workerPort = port
  }

  onBindingChanged(listener: (sessionId: string, runId: RunId, generation: number) => void): void {
    this.bindingListener = listener
  }
  onQuestionsClosed(listener: (messageIds: readonly string[]) => void): void {
    this.questionsClosedListener = listener
  }

  onDispatchSettled(listener: (dispatchId: DispatchId) => void): void {
    this.dispatchSettledListener = listener
  }

  onDispatchFenced(listener: (dispatchId: DispatchId) => void): void {
    this.dispatchFencedListener = listener
  }

  onMessageCommitted(listener: (arrival: { mailbox: MailboxAddress; messageId: MessageId; type: MessageType }) => void): void {
    this.messageCommittedListener = listener
  }

  getRun(runId: RunId): RunRow {
    const row = this.store.get<RunRecord>('SELECT * FROM runs WHERE id = ?', runId)
    if (!row) fail(this.context, 'run_not_found', `Run ${runId} does not exist`, { runId })
    return runRow(row)
  }

  getTask(taskId: TaskId): TaskRow {
    const row = this.store.get<TaskRecord>('SELECT * FROM tasks WHERE id = ?', taskId)
    if (!row) fail(this.context, 'task_not_found', `Task ${taskId} does not exist`, { taskId })
    return taskRow(row)
  }

  getDispatch(dispatchId: DispatchId): DispatchRow {
    const row = this.store.get<DispatchRecord>('SELECT * FROM dispatches WHERE id = ?', dispatchId)
    if (!row) fail(this.context, 'dispatch_not_found', `Dispatch ${dispatchId} does not exist`, { dispatchId })
    return dispatchRow(row)
  }

  getDispatchRecord(dispatchId: DispatchId): DispatchRecord {
    const row = this.store.get<DispatchRecord>('SELECT * FROM dispatches WHERE id = ?', dispatchId)
    if (!row) fail(this.context, 'dispatch_not_found', `Dispatch ${dispatchId} does not exist`, { dispatchId })
    return row
  }

  listDispatches(): DispatchRow[] {
    return this.store.all<DispatchRecord>(
      `SELECT * FROM dispatches ORDER BY created_at, id`
    ).map(dispatchRow)
  }

  boundRunId(caller: RuntimeCallerEvidence): RunId | null {
    this.assertEvidence(caller)
    return this.getBoundRun(caller.runtimeSessionId)?.id ?? null
  }

  attentionFor(dispatchId: DispatchId): { guidance: boolean; input: boolean; approval: boolean; rootCompletion: boolean } {
    const dispatch = this.getDispatchRecord(dispatchId)
    const task = this.getTaskRecord(dispatch.task_id as TaskId)
    const guidance = this.store.get<{ id: string }>(
      `SELECT id FROM messages
       WHERE mailbox_kind = 'dispatch' AND mailbox_id = ? AND read = 0
         AND type IN ('status', 'dispatch', 'merge_ready', 'handoff')
       LIMIT 1`,
      dispatchId
    ) !== undefined
    let input = false
    let approval = false
    const pendingQuestions = this.store.all<{ payload_json: string | null }>(
      `SELECT m.payload_json FROM question_threads q
       JOIN messages m ON m.id = q.message_id
       WHERE q.dispatch_id = ? AND q.status = 'pending'`,
      dispatchId
    )
    for (const row of pendingQuestions) {
      const payload = jsonOf<JsonValue | null>(row.payload_json, null)
      const options = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, JsonValue>).options
        : undefined
      if (Array.isArray(options) && options.length > 0) approval = true
      else input = true
    }
    if (this.store.get<{ id: string }>(`SELECT id FROM gates WHERE task_id = ? AND status = 'pending' LIMIT 1`, task.id)) {
      approval = true
    }
    return {
      guidance,
      input,
      approval,
      rootCompletion: task.parent_task_id === null && task.status === 'completed'
    }
  }

  getTaskRecord(taskId: TaskId): TaskRecord {
    const row = this.store.get<TaskRecord>('SELECT * FROM tasks WHERE id = ?', taskId)
    if (!row) fail(this.context, 'task_not_found', `Task ${taskId} does not exist`, { taskId })
    return row
  }

  getBoundRun(sessionId: string): RunRow | null {
    const row = this.store.get<RunRecord>(
      `SELECT * FROM runs WHERE coordinator_session_id = ? AND id != 'run_unbound' ORDER BY updated_at DESC, id DESC LIMIT 1`,
      sessionId
    )
    return row ? runRow(row) : null
  }
  requireOwnedRun(pluginId: string, runId: RunId): void {
    const owner = this.store.get<{ service_owner_plugin_id: string | null }>(
      `SELECT service_owner_plugin_id FROM runs WHERE id = ?`,
      runId
    )
    if (!owner || owner.service_owner_plugin_id !== pluginId) {
      fail(this.context, 'consumer_fenced', 'service caller does not own the requested Run', { runId })
    }
  }

  getServiceRun(pluginId: string, runId: RunId): ServiceRunRow {
    this.requireOwnedRun(pluginId, runId)
    const row = this.store.get<RunRecord>('SELECT * FROM runs WHERE id = ?', runId)
    if (!row || !row.service_owner_plugin_id || row.service_owner_key === null) {
      fail(this.context, 'consumer_fenced', 'service caller does not own the requested Run', { runId })
    }
    if (row.coordinator_session_id !== null) {
      fail(this.context, 'lifecycle_conflict', `service-owned Run ${runId} has an unexpected session coordinator`, { runId })
    }
    return {
      ...runRow(row),
      coordinatorSessionId: null,
      serviceOwner: { pluginId: row.service_owner_plugin_id, key: row.service_owner_key }
    }
  }

  requireCoordinator(caller: CoordinatorAuthority, runId?: RunId): RunRow {
    if ('kind' in caller) {
      if (runId !== undefined && runId !== caller.runId) {
        fail(this.context, 'consumer_fenced', `service coordinator is scoped to ${caller.runId}, not ${runId}`, { runId, boundRunId: caller.runId })
      }
      this.requireOwnedRun(caller.pluginId, caller.runId)
      return this.getRun(caller.runId)
    }
    this.assertEvidence(caller)
    const bound = this.getBoundRun(caller.runtimeSessionId)
    if (!bound) fail(this.context, 'run_required', 'no Run is bound to this session; create or use a Run first')
    if (runId !== undefined && runId !== bound.id) {
      fail(this.context, 'consumer_fenced', `session is bound to ${bound.id}, not ${runId}`, { runId, boundRunId: bound.id })
    }
    const run = runId === undefined ? bound : this.getRun(runId)
    if (run.coordinatorSessionId !== caller.runtimeSessionId) {
      fail(this.context, 'consumer_fenced', `session is no longer the coordinator of Run ${run.id}`, { runId: run.id })
    }
    return run
  }

  createRun(input: RunCreateParams, caller: RuntimeCallerEvidence): RunRow {
    this.assertEvidence(caller)
    const objective = input.objective.trim()
    if (!objective) fail(this.context, 'invalid_argument', 'Run objective must not be empty')
    const at = isoNow()
    this.unbindSession(caller.runtimeSessionId, at)
    const id = newId('run') as RunId
    this.store.run(
      `INSERT INTO runs (id, objective, coordinator_session_id, coordinator_history_json, consumer_generation, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      id,
      objective,
      caller.runtimeSessionId,
      jsonText([caller.runtimeSessionId]),
      at,
      at
    )
    return this.getRun(id)
  }

  serviceRunCreate(
    params: MutationRequest & { key: string; objective: string },
    pluginId: string
  ): Promise<MutationResult<{ run: ServiceRunRow }>> {
    if (pluginId.trim().length === 0) fail(this.context, 'consumer_fenced', 'service Run creation requires an authenticated plugin principal')
    return this.mutateWithFingerprint(
      'runCreate',
      params,
      serviceFingerprint(pluginId),
      () => ({ run: this.createServiceRunRecord(params, pluginId) })
    )
  }

  private createServiceRunRecord(
    params: MutationRequest & { key: string; objective: string },
    pluginId: string
  ): ServiceRunRow {
    const key = params.key
    const objective = params.objective.trim()
    if (key.trim().length === 0) fail(this.context, 'invalid_argument', 'Run key must not be empty')
    if (!objective) fail(this.context, 'invalid_argument', 'Run objective must not be empty')
    const existing = this.store.get<{ id: string; objective: string }>(
      `SELECT id, objective FROM runs WHERE service_owner_plugin_id = ? AND service_owner_key = ?`,
      pluginId,
      key
    )
    if (existing) {
      if (existing.objective !== objective) {
        fail(this.context, 'request_mismatch', `service Run key ${key} already names a Run with a different objective`, { runId: existing.id })
      }
      return this.getServiceRun(pluginId, existing.id as RunId)
    }
    const id = newId('run') as RunId
    const at = isoNow()
    this.store.run(
      `INSERT INTO runs (
        id, objective, coordinator_session_id, coordinator_history_json, consumer_generation,
        created_at, updated_at, service_owner_plugin_id, service_owner_key
      ) VALUES (?, ?, NULL, '[]', 1, ?, ?, ?, ?)`,
      id,
      objective,
      at,
      at,
      pluginId,
      key
    )
    return this.getServiceRun(pluginId, id)
  }

  useRun(input: RunUseParams, caller: RuntimeCallerEvidence): RunRow {
    this.assertEvidence(caller)
    const target = this.getRun(input.runId)
    const serviceOwner = this.store.get<{ service_owner_plugin_id: string | null }>(
      `SELECT service_owner_plugin_id FROM runs WHERE id = ?`,
      target.id
    )
    if (serviceOwner?.service_owner_plugin_id !== null && serviceOwner?.service_owner_plugin_id !== undefined) {
      fail(this.context, 'consumer_fenced', `service-owned Run ${target.id} cannot be bound to a session`, { runId: target.id })
    }
    if (target.id === 'run_unbound') fail(this.context, 'run_not_found', 'run_unbound is a mail-only namespace and cannot be bound')
    const at = isoNow()
    this.unbindSession(caller.runtimeSessionId, at, target.id)
    const current = this.getRun(target.id)
    const ownerChanged = current.coordinatorSessionId !== caller.runtimeSessionId
    if (current.coordinatorSessionId && ownerChanged) {
      this.fenceRunConsumer(current, at)
      this.bindingListener?.(current.coordinatorSessionId, target.id, current.consumerGeneration + 1)
    }
    const history = current.coordinatorHistory.includes(caller.runtimeSessionId)
      ? current.coordinatorHistory
      : [...current.coordinatorHistory, caller.runtimeSessionId]
    const generation = ownerChanged ? current.consumerGeneration + 1 : current.consumerGeneration
    this.store.run(
      `UPDATE runs SET coordinator_session_id = ?, coordinator_history_json = ?, consumer_generation = ?, updated_at = ? WHERE id = ?`,
      caller.runtimeSessionId,
      jsonText(history),
      generation,
      at,
      target.id
    )
    return this.getRun(target.id)
  }

  createTask(input: Omit<TaskCreateParams, keyof MutationRequest>, caller: CoordinatorAuthority): TaskRow {
    const run = this.requireCoordinator(caller, input.runId)
    const specBytes = new TextEncoder().encode(input.spec).byteLength
    if (specBytes > MAX_TASK_SPEC_BYTES) {
      fail(this.context, 'invalid_argument', `Task spec exceeds ${MAX_TASK_SPEC_BYTES} UTF-8 bytes`, { maxTaskSpecBytes: MAX_TASK_SPEC_BYTES })
    }
    const dependencies = [...(input.dependencyTaskIds ?? [])]
    if (new Set(dependencies).size !== dependencies.length) fail(this.context, 'invalid_argument', 'dependencyTaskIds must not contain duplicates')
    for (const dependencyId of dependencies) {
      const dependency = this.store.get<{ run_id: string }>('SELECT run_id FROM tasks WHERE id = ?', dependencyId)
      if (!dependency || dependency.run_id !== run.id) {
        fail(this.context, 'task_not_found', `dependency Task ${dependencyId} does not exist in Run ${run.id}`, { taskId: dependencyId, runId: run.id })
      }
    }
    if (input.parentTaskId !== undefined) {
      const parent = this.store.get<{ run_id: string }>('SELECT run_id FROM tasks WHERE id = ?', input.parentTaskId)
      if (!parent || parent.run_id !== run.id) {
        fail(this.context, 'task_not_found', `parent Task ${input.parentTaskId} does not exist in Run ${run.id}`, {
          taskId: input.parentTaskId,
          runId: run.id
        })
      }
    }
    const titleSeed = input.taskTitle ?? input.spec.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? 'Task'
    const taskTitle = truncated(titleSeed, 80) || 'Task'
    const displayName = truncated(input.displayName ?? taskTitle, 160) || taskTitle
    const ready = dependencies.every((dependencyId) => this.store.get<{ status: TaskStatus }>('SELECT status FROM tasks WHERE id = ?', dependencyId)?.status === 'completed')
    const at = isoNow()
    const id = newId('task') as TaskId
    const creatorSessionId = 'kind' in caller ? null : caller.runtimeSessionId
    const creatorPluginId = 'kind' in caller ? caller.pluginId : null
    const creatorKind: 'session' | 'service' = 'kind' in caller ? 'service' : 'session'
    this.store.run(
      `INSERT INTO tasks (
        id, run_id, parent_task_id, dependency_task_ids_json, created_by_session_id,
        created_by_plugin_id, created_by_kind, task_title, display_name, spec, status,
        result_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      id,
      run.id,
      input.parentTaskId ?? null,
      jsonText(dependencies),
      creatorSessionId,
      creatorPluginId,
      creatorKind,
      taskTitle,
      displayName,
      input.spec,
      ready ? 'ready' : 'pending',
      at
    )
    return this.getTask(id)
  }

  taskList(input: TaskListParams, caller?: RuntimeCallerEvidence): { runId: RunId; tasks: readonly TaskListRow[]; count: number } {
    const run =
      input.runId === undefined
        ? caller
          ? this.requireCoordinator(caller)
          : fail(this.context, 'run_required', 'a Run must be bound or explicitly named')
        : this.getRun(input.runId)
    if (input.ready === true && input.status !== undefined) fail(this.context, 'invalid_argument', 'ready and status filters cannot be used together')
    const status = input.ready === true ? 'ready' : input.status
    const rows = this.store.all<TaskRecord>(
      `SELECT * FROM tasks WHERE run_id = ? ${status === undefined ? '' : 'AND status = ?'} ORDER BY created_at, id`,
      ...(status === undefined ? [run.id] : [run.id, status])
    )
    const tasks = rows.map((row): TaskListRow => {
      const task = taskRow(row)
      const active = this.store.get<{ id: string; assignee_session_id: string | null }>(
        `SELECT id, assignee_session_id FROM dispatches WHERE task_id = ? AND status IN ('pending', 'dispatched') ORDER BY created_at DESC, id DESC LIMIT 1`,
        row.id
      )
      const specCharacters = input.brief ? Array.from(collapse(row.spec)) : undefined
      const wasTruncated = specCharacters !== undefined && specCharacters.length > 160
      const summary =
        specCharacters === undefined ? row.spec : wasTruncated ? `${specCharacters.slice(0, 159).join('')}…` : specCharacters.join('')
      return {
        ...task,
        spec: summary,
        ...(active ? { dispatchId: active.id as DispatchId, ...(active.assignee_session_id ? { assigneeSessionId: active.assignee_session_id } : {}) } : {}),
        ...(wasTruncated ? { specTruncated: true as const } : {})
      }
    })
    return { runId: run.id, tasks, count: tasks.length }
  }

  transitionTask(input: TaskTransitionInput): TaskRow {
    const current = this.getTaskRecord(input.taskId)
    if (current.status !== input.expectedState) {
      fail(this.context, 'lifecycle_conflict', `Task ${input.taskId} is ${current.status}, expected ${input.expectedState}`, {
        taskId: input.taskId,
        expectedState: input.expectedState,
        actualState: current.status
      })
    }
    if (input.nextState === current.status && input.result === undefined) return taskRow(current)
    if (this.hasLiveWorkerForTask(input.taskId)) {
      fail(this.context, 'task_not_startable', `Task ${input.taskId} still has a live supervised worker`, { taskId: input.taskId, status: current.status })
    }
    const active = this.store.all<DispatchRecord>(
      `SELECT * FROM dispatches WHERE task_id = ? AND status IN ('pending', 'dispatched') ORDER BY created_at DESC, id DESC`,
      input.taskId
    )
    if (input.nextState === 'dispatched' && active.length === 0) {
      fail(this.context, 'task_not_startable', `Task ${input.taskId} cannot be dispatched without an active Dispatch`, { taskId: input.taskId })
    }
    if (active.length > 0 && input.nextState !== 'completed' && input.nextState !== 'failed') {
      fail(this.context, 'task_not_startable', `Task ${input.taskId} has an active Dispatch and cannot move to ${input.nextState}`, {
        taskId: input.taskId,
        status: current.status
      })
    }
    for (const dispatch of active) {
      const nextState = input.nextState === 'completed' ? 'completed' : 'failed'
      this.transitionDispatchInternal(
        nextState === 'completed'
          ? { dispatchId: dispatch.id as DispatchId, expectedState: dispatch.status, nextState, at: input.at } as DispatchTransitionInput
          : {
              dispatchId: dispatch.id as DispatchId,
              expectedState: dispatch.status,
              nextState,
              failureClass: 'worker_report',
              failureReason: 'coordinator_task_update',
              at: input.at
            } as DispatchTransitionInput,
        false,
        false
      )
    }
    const result = input.result === undefined ? current.result_json : input.result === null ? null : jsonText(input.result)
    const completedAt = input.nextState === 'completed' ? input.at : null
    const update = this.store.run(
      `UPDATE tasks SET status = ?, result_json = ?, completed_at = ? WHERE id = ? AND status = ?`,
      input.nextState,
      result,
      completedAt,
      input.taskId,
      input.expectedState
    )
    if (update.changes !== 1) fail(this.context, 'lifecycle_conflict', `Task ${input.taskId} changed during update`, { taskId: input.taskId })
    if (input.nextState === 'completed') this.promoteReadyTasks(current.run_id)
    return this.getTask(input.taskId)
  }
  /** The only path that may block a Task while its exact supervised worker is being stopped. */
  blockTaskForWorkerStop(input: { taskId: TaskId; dispatchId: DispatchId; at: UtcTimestamp }): TaskRow {
    const dispatch = this.getDispatchRecord(input.dispatchId)
    if (dispatch.task_id !== input.taskId || !activeDispatch(dispatch.status) || dispatch.supervised !== 1) {
      fail(this.context, 'lifecycle_conflict', `Dispatch ${input.dispatchId} cannot fence Task ${input.taskId} for stop`, {
        taskId: input.taskId,
        dispatchId: input.dispatchId
      })
    }
    const worker = this.requireWorkerPort(input.dispatchId).workerForDispatch(this.store, input.dispatchId)
    if (
      worker === null ||
      worker.dispatchId !== input.dispatchId ||
      (worker.state !== 'stopping' && !(worker.state === 'stop_unknown' && worker.stage === 'stopping'))
    ) {
      fail(this.context, 'lifecycle_conflict', `Dispatch ${input.dispatchId} has no exact worker stop fence`, {
        taskId: input.taskId,
        dispatchId: input.dispatchId
      })
    }
    const hasDispatchIdentity =
      dispatch.assignee_session_id !== null ||
      dispatch.runtime_epoch !== null ||
      dispatch.process_incarnation !== null
    const hasWorkerIdentity = worker.sessionId !== null
    if (
      hasDispatchIdentity !== hasWorkerIdentity ||
      (hasDispatchIdentity && (
        dispatch.assignee_session_id === null ||
        dispatch.runtime_epoch === null ||
        dispatch.process_incarnation === null ||
        worker.sessionId !== dispatch.assignee_session_id
      ))
    ) {
      fail(this.context, 'lifecycle_conflict', `Dispatch ${input.dispatchId} stop identity does not match its exact worker`, {
        taskId: input.taskId,
        dispatchId: input.dispatchId
      })
    }
    const task = this.getTaskRecord(input.taskId)
    if (task.run_id !== dispatch.run_id || task.status !== 'dispatched') {
      fail(this.context, 'lifecycle_conflict', `Task ${input.taskId} is not the active Task for Dispatch ${input.dispatchId}`, {
        taskId: input.taskId,
        dispatchId: input.dispatchId
      })
    }
    const update = this.store.run(
      `UPDATE tasks SET status = 'blocked' WHERE id = ? AND run_id = ? AND status = 'dispatched'`,
      input.taskId,
      dispatch.run_id
    )
    if (update.changes !== 1) {
      fail(this.context, 'lifecycle_conflict', `Task ${input.taskId} changed during its worker stop fence`, {
        taskId: input.taskId,
        dispatchId: input.dispatchId
      })
    }
    return this.getTask(input.taskId)
  }



  transitionDispatch(input: DispatchTransitionInput): DispatchRow {
    return this.transitionDispatchInternal(input, false, true)
  }
  /** Settles an attempt without promoting or completing its Task, for a blocking decision gate. */
  settleDispatchWithoutTask(input: DispatchTransitionInput): DispatchRow {
    return this.transitionDispatchInternal(input, false, false)
  }


  transitionWorker(input: WorkerTransitionInput): WorkerRow {
    const dispatch = this.getDispatchRecord(input.dispatchId)
    if (!dispatch.supervised) fail(this.context, 'lifecycle_not_found', `Dispatch ${input.dispatchId} has no supervised worker row`)
    if (input.nextState === 'stopping' && !activeDispatch(dispatch.status)) {
      fail(this.context, 'lifecycle_conflict', `settled Dispatch ${input.dispatchId} cannot be stopped`, { dispatchId: input.dispatchId })
    }
    const port = this.requireWorkerPort(input.dispatchId)
    const worker = port.transitionWorker(this.store, input)
    if (input.nextState === 'stopping') {
      const at = isoNow()
      const update = this.store.run(
        `UPDATE dispatches SET consumer_generation = consumer_generation + 1 WHERE id = ? AND consumer_generation = ? AND status IN ('pending', 'dispatched')`,
        dispatch.id,
        dispatch.consumer_generation
      )
      if (update.changes !== 1) fail(this.context, 'lifecycle_conflict', `Dispatch ${input.dispatchId} changed while it was being stopped`, { dispatchId: input.dispatchId })
      this.fenceDispatchConsumer(input.dispatchId, dispatch.consumer_generation)
      this.closeQuestionsForDispatch(input.dispatchId, at)
      this.dispatchFencedListener?.(input.dispatchId)
    }
    return worker
  }

  admitDispatch(input: DispatchAdmissionInput, caller: RuntimeCallerEvidence): DispatchAdmissionResult {
    return this.admit(input, caller)
  }

  createDispatch(
    input: DispatchAdmissionInput & { supervised?: boolean },
    caller: RuntimeCallerEvidence,
    identity: SessionIdentity
  ): DispatchRow {
    this.assertEvidence(caller)
    if (!identity.live || identity.sessionId !== input.assigneeSessionId) {
      fail(this.context, 'terminal_not_found', `assignee ${input.assigneeSessionId} has no matching live identity`, { sessionId: input.assigneeSessionId })
    }
    const admission = this.admit(input, caller)
    if (!admission.admitted) {
      fail(this.context, admission.reason, admission.reason === 'nested_worker_depth_exceeded' ? 'nested Dispatch depth exceeds the configured maximum of 1' : 'Task is not startable', {
        taskId: input.taskId,
        ...(admission.attemptedDepth === undefined ? {} : { attemptedDepth: admission.attemptedDepth }),
        ...(admission.maximumDepth === undefined ? {} : { maximumDepth: admission.maximumDepth }),
        ...(admission.failureCount === undefined ? {} : { failureCount: admission.failureCount })
      })
    }
    const task = this.getTaskRecord(input.taskId)
    const id = newId('ctx') as DispatchId
    const at = isoNow()
    const supervised = input.supervised === true
    const creatorDispatchId = this.creatorDispatchId(caller.runtimeSessionId)
    const generation = 1
    this.store.run(
      `INSERT INTO dispatches (
        id, run_id, task_id, contract_version, status, assignee_session_id,
        creator_session_id, creator_dispatch_id, retry_of_dispatch_id, depth, failure_count,
        last_failure, termination_reason, consumer_generation, supervised, runtime_epoch,
        process_incarnation, created_at, dispatched_at, completed_at, last_heartbeat_at
      ) VALUES (?, ?, ?, 1, 'dispatched', ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      id,
      task.run_id,
      task.id,
      identity.sessionId,
      caller.runtimeSessionId,
      creatorDispatchId,
      admission.retryOfDispatchId,
      admission.depth,
      admission.failureCount,
      generation,
      supervised ? 1 : 0,
      identity.runtimeEpoch,
      identity.processIncarnation,
      at,
      at
    )
    this.store.run(`UPDATE tasks SET status = 'dispatched' WHERE id = ?`, task.id)
    return this.getDispatch(id)
  }

  reserveWorkerDispatch(input: Omit<DispatchAdmissionInput, 'assigneeSessionId'>, caller: CoordinatorAuthority): DispatchRow {
    this.requireCoordinator(caller, input.runId)
    const admission = this.admit({ ...input, assigneeSessionId: '' }, caller, { allowMissingAssignee: true })
    if (!admission.admitted) {
      fail(this.context, admission.reason, admission.reason === 'nested_worker_depth_exceeded' ? 'nested Dispatch depth exceeds the configured maximum of 1' : 'Task is not startable', {
        taskId: input.taskId,
        ...(admission.attemptedDepth === undefined ? {} : { attemptedDepth: admission.attemptedDepth }),
        ...(admission.maximumDepth === undefined ? {} : { maximumDepth: admission.maximumDepth }),
        ...(admission.failureCount === undefined ? {} : { failureCount: admission.failureCount })
      })
    }
    const task = this.getTaskRecord(input.taskId)
    const id = newId('ctx') as DispatchId
    const at = isoNow()
    const creatorSessionId = 'kind' in caller ? null : caller.runtimeSessionId
    const creatorPluginId = 'kind' in caller ? caller.pluginId : null
    const creatorKind: 'session' | 'service' = 'kind' in caller ? 'service' : 'session'
    const creatorDispatchId = 'kind' in caller ? null : this.creatorDispatchId(caller.runtimeSessionId)
    this.store.run(
      `INSERT INTO dispatches (
        id, run_id, task_id, contract_version, status, assignee_session_id,
        creator_session_id, creator_plugin_id, creator_kind, creator_dispatch_id, retry_of_dispatch_id,
        depth, failure_count, last_failure, termination_reason, consumer_generation, supervised,
        runtime_epoch, process_incarnation, created_at, dispatched_at, completed_at, last_heartbeat_at
      ) VALUES (?, ?, ?, 1, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 1, NULL, NULL, ?, NULL, NULL, NULL)`,
      id,
      task.run_id,
      task.id,
      creatorSessionId,
      creatorPluginId,
      creatorKind,
      creatorDispatchId,
      admission.retryOfDispatchId,
      admission.depth,
      admission.failureCount,
      at
    )
    this.store.run(`UPDATE tasks SET status = 'dispatched' WHERE id = ?`, task.id)
    return this.getDispatch(id)
  }

  attachDispatchAuthority(dispatchId: DispatchId, identity: SessionIdentity, caller: RuntimeCallerEvidence): DispatchRow {
    return this.attachWorkerAuthority(dispatchId, identity, caller)
  }


  attachWorkerAuthority(dispatchId: DispatchId, identity: SessionIdentity, caller: CoordinatorAuthority): DispatchRow {
    const coordinator = this.requireCoordinator(caller)
    const dispatch = this.getDispatchRecord(dispatchId)
    if (dispatch.run_id !== coordinator.id) {
      fail(this.context, 'consumer_fenced', `Dispatch ${dispatchId} does not belong to the coordinator Run`, { dispatchId, runId: coordinator.id })
    }
    if (!dispatch.supervised || dispatch.status !== 'pending' || dispatch.assignee_session_id !== null) {
      fail(this.context, 'lifecycle_conflict', `Dispatch ${dispatchId} is not awaiting supervised authority`, { dispatchId })
    }
    if (!identity.live || identity.sessionId.trim().length === 0 || identity.runtimeEpoch.trim().length === 0 ||
      identity.processIncarnation.trim().length === 0) {
      fail(this.context, 'terminal_not_found', `session ${identity.sessionId} has no exact live identity`, { sessionId: identity.sessionId })
    }
    const alreadyAssigned = this.store.get<{ id: string }>(
      `SELECT id FROM dispatches WHERE assignee_session_id = ? AND status IN ('pending', 'dispatched') AND id != ? LIMIT 1`,
      identity.sessionId,
      dispatchId
    )
    if (alreadyAssigned) {
      fail(this.context, 'task_not_startable', `session ${identity.sessionId} already owns active Dispatch ${alreadyAssigned.id}`, {
        sessionId: identity.sessionId,
        dispatchId: alreadyAssigned.id
      })
    }
    const generation = dispatch.consumer_generation + 1
    const update = this.store.run(
      `UPDATE dispatches
       SET assignee_session_id = ?, runtime_epoch = ?, process_incarnation = ?, consumer_generation = ?
       WHERE id = ? AND status = 'pending' AND supervised = 1 AND assignee_session_id IS NULL`,
      identity.sessionId,
      identity.runtimeEpoch,
      identity.processIncarnation,
      generation,
      dispatchId
    )
    if (update.changes !== 1) fail(this.context, 'lifecycle_conflict', `Dispatch ${dispatchId} authority changed during attachment`, { dispatchId })
    this.fenceDispatchConsumer(dispatchId, dispatch.consumer_generation)
    return this.getDispatch(dispatchId)
  }

  reportWorkerDone(input: WorkerDoneReportInput, caller: RuntimeCallerEvidence): WorkerReportResult {
    const dispatch = this.store.get<DispatchRecord>('SELECT * FROM dispatches WHERE id = ?', input.dispatchId)
    if (!dispatch) return { status: 'rejected', reason: 'unknown_dispatch', audited: true }
    const task = this.store.get<TaskRecord>('SELECT * FROM tasks WHERE id = ?', input.taskId)
    if (!task) return { status: 'rejected', reason: 'unknown_task', audited: true }
    if (task.id !== dispatch.task_id) return { status: 'rejected', reason: 'task_dispatch_mismatch', audited: true }
    if (dispatch.assignee_session_id === null || caller.callerSessionId !== dispatch.assignee_session_id) {
      return { status: 'rejected', reason: 'sender_not_assignee', audited: true }
    }
    if (
      caller.runtimeSessionId !== dispatch.assignee_session_id ||
      caller.attestation.runtimeEpoch !== dispatch.runtime_epoch ||
      caller.attestation.processIncarnation !== dispatch.process_incarnation
    ) {
      return { status: 'rejected', reason: 'worker_identity_changed', audited: true }
    }
    const latest = this.store.get<{ id: string }>(
      `SELECT id FROM dispatches WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      dispatch.task_id
    )
    if (latest?.id !== dispatch.id) return { status: 'rejected', reason: 'stale_dispatch', audited: true }
    if (finalDispatch(dispatch.status)) {
      const prior = jsonOf<TaskResult | null>(task.result_json, null)
      if (prior?.kind === 'worker_report' && prior.dispatchId === dispatch.id && prior.outcome === input.outcome) {
        const worker = dispatch.supervised ? this.requireWorkerPort(dispatch.id).workerForDispatch(this.store, dispatch.id) : null
        return { status: 'duplicate', task: taskRow(task), dispatch: dispatchRow(dispatch), worker }
      }
      return { status: 'rejected', reason: 'inactive_dispatch', audited: true }
    }
    if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') return { status: 'rejected', reason: 'dispatch_inactive', audited: true }
    if (task.status !== 'dispatched' && task.status !== 'blocked') return { status: 'rejected', reason: 'inactive_dispatch', audited: true }
    const at = isoNow()
    let worker: WorkerRow | null = null
    if (dispatch.supervised) {
      const port = this.requireWorkerPort(dispatch.id as DispatchId)
      let state = port.stateForDispatch(this.store, dispatch.id as DispatchId)
      if (!state) fail(this.context, 'worker_port_unavailable', `supervised Dispatch ${dispatch.id} has no worker record`, { dispatchId: dispatch.id })
      if (state === 'stopping' || state === 'stopped' || state === 'abandoned') {
        return { status: 'rejected', reason: 'dispatch_inactive', audited: true }
      }
      if (state === 'stop_unknown') {
        port.transitionWorker(this.store, {
          dispatchId: dispatch.id as DispatchId,
          expectedState: 'stop_unknown',
          nextState: 'ready'
        })
        state = 'ready'
      }
      if (state === 'failed') {
        if (input.outcome !== 'succeeded') {
          return { status: 'rejected', reason: 'dispatch_inactive', audited: true }
        }
        worker = port.transitionWorker(this.store, {
          dispatchId: dispatch.id as DispatchId,
          expectedState: 'failed',
          nextState: 'succeeded',
          correction: 'unobserved_prompt_report',
          report: input,
          caller
        })
      } else if (state === 'succeeded') {
        return { status: 'rejected', reason: 'dispatch_inactive', audited: true }
      } else {
        worker = port.acceptReport(this.store, { dispatchId: dispatch.id as DispatchId, outcome: input.outcome, caller, at })
      }
      if (!worker) fail(this.context, 'worker_port_unavailable', `supervised Dispatch ${dispatch.id} report was not reconciled`, { dispatchId: dispatch.id })
    }
    const result: TaskResult = {
      kind: 'worker_report',
      outcome: input.outcome,
      messageId: input.messageId,
      dispatchId: dispatch.id as DispatchId,
      reportedBy: caller.runtimeSessionId,
      subject: input.subject,
      body: input.body,
      completedBy: caller.runtimeSessionId,
      filesModified: [...(input.filesModified ?? [])],
      reportPath: input.reportPath ?? null,
      completedAt: at
    }
    const status: DispatchStatus = input.outcome === 'succeeded' ? 'completed' : 'failed'
    const transitioned = this.transitionDispatchInternal(
      status === 'completed'
        ? { dispatchId: dispatch.id as DispatchId, expectedState: dispatch.status, nextState: 'completed', at }
        : { dispatchId: dispatch.id as DispatchId, expectedState: dispatch.status, nextState: 'failed', failureClass: 'worker_report', failureReason: 'worker_report', at },
      true,
      false
    )
    this.store.run(`UPDATE tasks SET status = ?, result_json = ?, completed_at = ? WHERE id = ?`, input.outcome === 'succeeded' ? 'completed' : 'failed', jsonText(result), input.outcome === 'succeeded' ? at : null, task.id)
    this.closeQuestionsForTask(task.id, at)
    if (input.outcome === 'succeeded') this.promoteReadyTasks(task.run_id)
    return { status: 'accepted', task: this.getTask(task.id as TaskId), dispatch: transitioned, worker }
  }

  recordHeartbeat(input: WorkerHeartbeatInput, caller: RuntimeCallerEvidence): HeartbeatResult {
    const dispatch = this.store.get<DispatchRecord>('SELECT * FROM dispatches WHERE id = ?', input.dispatchId)
    if (!dispatch) return { status: 'rejected', reason: 'unknown_dispatch', lastHeartbeatAt: null }
    if (dispatch.task_id !== input.taskId) return { status: 'rejected', reason: 'task_dispatch_mismatch', lastHeartbeatAt: null }
    if (dispatch.assignee_session_id === null || caller.callerSessionId !== dispatch.assignee_session_id) {
      return { status: 'rejected', reason: 'sender_not_assignee', lastHeartbeatAt: null }
    }
    if (
      caller.runtimeSessionId !== dispatch.assignee_session_id ||
      caller.attestation.runtimeEpoch !== dispatch.runtime_epoch ||
      caller.attestation.processIncarnation !== dispatch.process_incarnation
    ) {
      return { status: 'rejected', reason: 'worker_identity_changed', lastHeartbeatAt: null }
    }
    if (dispatch.status !== 'dispatched') return { status: 'rejected', reason: 'dispatch_inactive', lastHeartbeatAt: null }
    const at = isoNow()
    if (dispatch.supervised) {
      const port = this.requireWorkerPort(dispatch.id as DispatchId)
      const state = port.stateForDispatch(this.store, dispatch.id as DispatchId)
      if (!state) fail(this.context, 'worker_port_unavailable', `supervised Dispatch ${dispatch.id} has no worker record`, { dispatchId: dispatch.id })
      if (state === 'stopping' || state === 'stop_unknown' || state === 'stopped' || state === 'abandoned') {
        return { status: 'rejected', reason: 'dispatch_inactive', lastHeartbeatAt: null }
      }
      port.recordHeartbeat(this.store, { dispatchId: dispatch.id as DispatchId, caller, at })
    }
    const update = this.store.run(`UPDATE dispatches SET last_heartbeat_at = ? WHERE id = ? AND status = 'dispatched'`, at, dispatch.id)
    if (update.changes !== 1) return { status: 'rejected', reason: 'dispatch_inactive', lastHeartbeatAt: null }
    return { status: 'accepted', lastHeartbeatAt: at }
  }

  async mutate<T extends object>(
    method: MutatingOrchestrationMethod,
    params: MutationRequest & object,
    caller: CoordinatorAuthority,
    operation: (store: PluginStore) => T,
    options: DurableMutationOptions<T> = {}
  ): Promise<MutationResult<T>> {
    if ('kind' in caller) this.requireCoordinator(caller)
    else this.assertEvidence(caller)
    return this.mutateWithFingerprint(method, params, receiptFingerprint(caller), operation, options)
  }

  mutateWorker<T extends object>(
    method: string,
    params: MutationRequest & object,
    caller: CoordinatorAuthority,
    operation: (store: PluginStore) => T,
    options: DurableMutationOptions<T> = {}
  ): Promise<MutationResult<T>> {
    if (!Object.hasOwn(WORKER_MUTATION_METHODS, method)) {
      fail(this.context, 'invalid_argument', `unsupported worker mutation ${method}`, { method })
    }
    if ('kind' in caller) this.requireCoordinator(caller)
    else this.assertEvidence(caller)
    return this.mutateWithFingerprint(method, params, receiptFingerprint(caller), operation, options)
  }

  private mutateWithFingerprint<T extends object>(
    method: string,
    params: MutationRequest & object,
    callerFingerprint: string,
    operation: (store: PluginStore) => T,
    options: DurableMutationOptions<T> = {}
  ): Promise<MutationResult<T>> {
    if (!UUID_RE.test(params.requestId) || params.contractVersion !== 1) {
      fail(this.context, 'invalid_argument', 'mutation request requires a UUID requestId and contractVersion 1')
    }
    const payloadHash = requestDigest(method, params)
    const key = `${callerFingerprint}:${params.requestId}`
    const active = this.activeMutations.get(key)
    if (active) {
      if (active.payloadHash !== payloadHash) fail(this.context, 'request_mismatch', `request ${params.requestId} was reused with different input`, { requestId: params.requestId })
      return active.promise as Promise<MutationResult<T>>
    }
    const promise = this.performMutation(method, params, callerFingerprint, payloadHash, operation, options)
    this.activeMutations.set(key, { payloadHash, promise })
    void promise.then(
      () => this.activeMutations.delete(key),
      () => this.activeMutations.delete(key)
    )
    return promise
  }

  readReceiptForSession(sessionId: string, requestId: UUID): ReceiptRecord | null {
    if (sessionId.trim().length === 0) return null
    return this.store.get<ReceiptRecord>(
      `SELECT * FROM mutation_receipts WHERE caller_fingerprint = ? AND request_id = ?`,
      fingerprint(sessionId),
      requestId
    )
  }

  readReceiptsByRequestId(requestId: UUID): ReceiptRecord[] {
    return this.store.all<ReceiptRecord>(
      `SELECT * FROM mutation_receipts WHERE request_id = ? ORDER BY caller_fingerprint LIMIT 2`,
      requestId
    )
  }

  hasLiveWorkerForTask(taskId: TaskId): boolean {
    const supervised = this.store.get<{ id: string }>(
      `SELECT id FROM dispatches WHERE task_id = ? AND supervised = 1 AND status IN ('pending', 'dispatched') LIMIT 1`,
      taskId
    )
    if (!supervised) return false
    if (!this.workerPort) fail(this.context, 'worker_port_unavailable', `Task ${taskId} has a supervised Dispatch but the worker extension is unavailable`, { taskId })
    return this.workerPort.hasLiveForTask(this.store, taskId)
  }

  workerForDispatch(dispatchId: DispatchId): WorkerRow | null {
    const dispatch = this.getDispatchRecord(dispatchId)
    if (!dispatch.supervised) return null
    const port = this.requireWorkerPort(dispatchId)
    const worker = port.workerForDispatch(this.store, dispatchId)
    if (!worker) fail(this.context, 'worker_port_unavailable', `supervised Dispatch ${dispatchId} has no worker record`, { dispatchId })
    return worker
  }
  emitWorkerStatus(
    dispatchId: DispatchId,
    subject: string,
    body: string,
    high: boolean,
    type: 'status' | 'escalation' = 'status',
    payload?: JsonValue
  ): void {
    const dispatch = this.getDispatchRecord(dispatchId)
    const fromSessionId = dispatch.assignee_session_id ?? dispatch.creator_session_id
    const serviceRunSender = fromSessionId === null && dispatch.creator_kind === 'service'
    if (!fromSessionId && !serviceRunSender) {
      fail(this.context, 'lifecycle_conflict', `Dispatch ${dispatchId} has no session or service coordinator provenance for a status message`)
    }
    const senderKind = serviceRunSender ? 'run' : 'dispatch'
    const senderId = serviceRunSender ? dispatch.run_id : dispatch.id
    const at = isoNow()
    const messageId = newId('msg') as MessageId
    this.store.run(
      `INSERT INTO messages (
        id, run_id, from_session_id, sender_kind, sender_id, mailbox_kind, mailbox_id,
        subject, body, type, priority, thread_id, payload_json, read, created_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, 'run', ?, ?, ?, ?, ?, NULL, ?, 0, ?, NULL)`,
      messageId,
      dispatch.run_id,
      fromSessionId,
      senderKind,
      senderId,
      dispatch.run_id,
      subject,
      body,
      type,
      high ? 'high' : 'normal',
      payload === undefined || payload === null ? null : jsonText(payload),
      at
    )
    const arrival = {
      mailbox: { kind: 'run' as const, runId: dispatch.run_id as RunId },
      messageId,
      type
    }
    queueMicrotask(() => {
      try {
        if (!this.store.get<{ id: string }>(`SELECT id FROM messages WHERE id = ?`, messageId)) return
        this.messageCommittedListener?.(arrival)
      } catch {
        // The committed message remains durable even if the store closes before notification.
      }
    })
  }

  closeWorkerQuestions(dispatchId: DispatchId, at: UtcTimestamp): void {
    this.closeQuestionsForDispatch(dispatchId, at)
  }
  resetState(mode: ResetMode, at: UtcTimestamp): void {
    if (mode === 'messages') {
      this.store.exec('DELETE FROM pointer_operations; DELETE FROM question_threads; DELETE FROM deliveries; DELETE FROM messages;')
      return
    }
    const supervised = this.store.get<{ id: string }>(`SELECT id FROM dispatches WHERE supervised = 1 LIMIT 1`)
    if (this.workerPort) this.workerPort.reset(this.store, mode, at)
    else if (supervised) {
      fail(this.context, 'worker_port_unavailable', `cannot reset ${mode} while supervised Dispatch ${supervised.id} exists`, {
        dispatchId: supervised.id
      })
    }
    if (mode === 'tasks') {
      this.store.run(
        `UPDATE question_threads SET status = 'closed', closed_at = ? WHERE status = 'pending'`,
        at
      )
      this.store.exec(`DELETE FROM pointer_operations WHERE mailbox_kind = 'dispatch'; DELETE FROM gates; DELETE FROM dispatches; DELETE FROM tasks;`)
      return
    }
    this.store.exec('DELETE FROM pointer_operations; DELETE FROM question_threads; DELETE FROM gates; DELETE FROM deliveries; DELETE FROM messages; DELETE FROM dispatches; DELETE FROM tasks; DELETE FROM runs;')
  }

  async dispose(): Promise<void> {
    const pending = [...this.activeMutations.values()].map((mutation) => mutation.promise)
    await Promise.allSettled(pending)
    this.bindingListener = null
    this.questionsClosedListener = null
    this.dispatchSettledListener = null
    this.dispatchFencedListener = null
    this.messageCommittedListener = null
  }



  private async performMutation<T extends object>(
    method: string,
    params: MutationRequest & object,
    callerFingerprint: string,
    payloadHash: string,
    operation: (store: PluginStore) => T,
    options: DurableMutationOptions<T>
  ): Promise<MutationResult<T>> {
    const replay = this.existingMutationResult<T>(method, params, callerFingerprint, payloadHash)
    if (replay) return replay

    let preflightError: unknown
    let preflightFailed = false
    if (options.beforeAccept) {
      try {
        await options.beforeAccept()
      } catch (error) {
        preflightFailed = true
        preflightError = error
      }
      const racedReplay = this.existingMutationResult<T>(method, params, callerFingerprint, payloadHash)
      if (racedReplay) return racedReplay
      if (preflightFailed) throw preflightError
    }

    const at = isoNow()
    const outcome = this.store.transaction(() => {
      const racedReplay = this.existingMutationResult<T>(method, params, callerFingerprint, payloadHash)
      if (racedReplay) return { value: null as T | null, result: racedReplay }
      this.pruneReceipts(at)
      const count = this.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM mutation_receipts')?.count ?? 0
      if (count >= RECEIPT_MAX_ROWS) fail(this.context, 'mutation_ledger_full', 'the mutation receipt ledger is full of unresolved requests')
      this.store.run(
        `INSERT INTO mutation_receipts (caller_fingerprint, request_id, method, payload_hash, state, checkpoint_json, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
        callerFingerprint,
        params.requestId,
        method,
        payloadHash,
        at,
        at
      )
      const value = operation(this.store)
      const checkpoint = options.acceptedCheckpoint?.(value)
      if (options.afterCommit && checkpoint === undefined) {
        fail(this.context, 'invalid_argument', 'post-commit work requires a durable accepted checkpoint')
      }
      if (checkpoint !== undefined && !options.afterCommit) {
        fail(this.context, 'invalid_argument', 'an accepted mutation checkpoint requires a post-commit operation')
      }
      if (checkpoint !== undefined) {
        this.store.run(
          `UPDATE mutation_receipts SET state = 'pending', checkpoint_json = ?, result_json = ?, updated_at = ? WHERE caller_fingerprint = ? AND request_id = ?`,
          jsonText(checkpoint),
          jsonText(value),
          at,
          callerFingerprint,
          params.requestId
        )
      } else if (!options.afterCommit) {
        const result = mutationReplay(value, params.requestId, false)
        this.store.run(
          `UPDATE mutation_receipts SET state = 'completed', result_json = ?, updated_at = ? WHERE caller_fingerprint = ? AND request_id = ?`,
          jsonText(result),
          at,
          callerFingerprint,
          params.requestId
        )
        return { value, result }
      }
      return { value: value as T | null, result: null as MutationResult<T> | null }
    })
    if (outcome.result) return outcome.result
    if (outcome.value === null) fail(this.context, 'operation_unknown', `request ${params.requestId} was claimed without a stored result`, { requestId: params.requestId })

    let finalValue: T
    try {
      finalValue = options.afterCommit ? await options.afterCommit(outcome.value) : outcome.value
    } catch (error) {
      fail(this.context, 'operation_unknown', `request ${params.requestId} was accepted but its post-commit outcome is unknown`, {
        requestId: params.requestId,
        cause: error instanceof Error ? error.message : String(error)
      })
    }
    const result = mutationReplay(finalValue, params.requestId, false)
    this.store.transaction(() => {
      this.store.run(
        `UPDATE mutation_receipts SET state = 'completed', result_json = ?, updated_at = ? WHERE caller_fingerprint = ? AND request_id = ? AND state = 'pending'`,
        jsonText(result),
        isoNow(),
        callerFingerprint,
        params.requestId
      )
    })
    return result
  }

  private existingMutationResult<T extends object>(
    method: string,
    params: MutationRequest,
    callerFingerprint: string,
    payloadHash: string
  ): MutationResult<T> | null {
    const existing = this.store.get<ReceiptRecord>(
      `SELECT * FROM mutation_receipts WHERE caller_fingerprint = ? AND request_id = ?`,
      callerFingerprint,
      params.requestId
    )
    if (!existing) return null
    if (existing.method !== method || existing.payload_hash !== payloadHash) {
      fail(this.context, 'request_mismatch', `request ${params.requestId} was already used with different input`, { requestId: params.requestId })
    }
    if (existing.state === 'pending') {
      fail(this.context, 'operation_unknown', `request ${params.requestId} has an accepted or unresolved outcome; inspect it instead of repeating side effects`, {
        requestId: params.requestId,
        ...(existing.checkpoint_json ? { checkpoint: jsonOf<MutationCheckpoint | JsonValue>(existing.checkpoint_json, null) } : {})
      })
    }
    const previous = jsonOf<MutationResult<T> | null>(existing.result_json, null)
    if (!previous) fail(this.context, 'operation_unknown', `request ${params.requestId} has no stored result`, { requestId: params.requestId })
    return mutationReplay(previous, params.requestId, true)
  }

  private pruneReceipts(at: UtcTimestamp): void {
    const cutoff = new Date(Date.parse(at) - RECEIPT_MAX_AGE_MS).toISOString()
    this.store.run(`DELETE FROM mutation_receipts WHERE state = 'completed' AND created_at < ?`, cutoff)
    const count = this.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM mutation_receipts')?.count ?? 0
    if (count < RECEIPT_MAX_ROWS) return
    const oldest = this.store.all<{ caller_fingerprint: string; request_id: string }>(
      `SELECT caller_fingerprint, request_id FROM mutation_receipts WHERE state = 'completed' ORDER BY created_at ASC LIMIT ?`,
      RECEIPT_PRUNE_BATCH
    )
    for (const receipt of oldest) {
      this.store.run(
        `DELETE FROM mutation_receipts WHERE caller_fingerprint = ? AND request_id = ? AND state = 'completed'`,
        receipt.caller_fingerprint,
        receipt.request_id
      )
    }
  }

  private admit(
    input: DispatchAdmissionInput,
    caller: CoordinatorAuthority,
    options: { allowMissingAssignee?: boolean } = {}
  ): DispatchAdmissionResult {
    const task = this.getTaskRecord(input.taskId)
    const run = this.requireCoordinator(caller, (input.runId ?? task.run_id) as RunId)
    if (task.run_id !== run.id) fail(this.context, 'dispatch_run_mismatch', `Task ${task.id} belongs to Run ${task.run_id}, not ${run.id}`, { taskId: task.id, runId: run.id })
    const dependencies = jsonOf<TaskId[]>(task.dependency_task_ids_json, [])
    const unmet = dependencies.filter((dependencyId) => this.store.get<{ status: TaskStatus }>('SELECT status FROM tasks WHERE id = ?', dependencyId)?.status !== 'completed')
    const pendingGate = this.store.get<{ id: string }>(`SELECT id FROM gates WHERE task_id = ? AND status = 'pending' LIMIT 1`, task.id)
    const latest = this.store.get<DispatchRecord>(`SELECT * FROM dispatches WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, task.id)
    let failureCount = 0
    let retryOf: string | null = null
    if (input.retryOfDispatchId !== undefined) {
      if (!latest || latest.id !== input.retryOfDispatchId || latest.task_id !== task.id || latest.status === 'circuit_broken') {
        return { admitted: false, reason: 'task_not_startable', failureCount: latest?.failure_count ?? 0 }
      }
      if (latest.status !== 'failed' || (task.status !== 'failed' && task.status !== 'blocked')) {
        return { admitted: false, reason: 'task_not_startable', failureCount: latest.failure_count }
      }
      if (latest.failure_count >= CIRCUIT_BREAK_FAILURES) {
        return { admitted: false, reason: 'task_not_startable', failureCount: latest.failure_count }
      }
      failureCount = latest.failure_count
      retryOf = latest.id
    } else if (task.status !== 'ready') {
      return { admitted: false, reason: 'task_not_startable', failureCount: latest?.failure_count ?? 0 }
    } else if (latest?.status === 'circuit_broken') {
      return { admitted: false, reason: 'task_not_startable', failureCount: latest.failure_count }
    } else if (latest?.status === 'failed') {
      if (options.allowMissingAssignee) {
        return { admitted: false, reason: 'task_not_startable', failureCount: latest.failure_count }
      }
      if (latest.failure_count >= CIRCUIT_BREAK_FAILURES) {
        return { admitted: false, reason: 'task_not_startable', failureCount: latest.failure_count }
      }
      failureCount = latest.failure_count
      retryOf = latest.id
    }
    const active = this.store.get<{ id: string }>(`SELECT id FROM dispatches WHERE task_id = ? AND status IN ('pending', 'dispatched') LIMIT 1`, task.id)
    if (active || pendingGate || unmet.length > 0 || this.hasLiveWorkerForTask(task.id as TaskId)) {
      return { admitted: false, reason: 'task_not_startable', failureCount }
    }
    if (!options.allowMissingAssignee && input.assigneeSessionId) {
      const occupied = this.store.get<{ id: string }>(
        `SELECT id FROM dispatches WHERE assignee_session_id = ? AND status IN ('pending', 'dispatched') LIMIT 1`,
        input.assigneeSessionId
      )
      if (occupied) return { admitted: false, reason: 'task_not_startable', failureCount }
    }
    const depth = this.creatorDepth(caller) + 1
    if (depth > MAX_NESTED_DEPTH) {
      return { admitted: false, reason: 'nested_worker_depth_exceeded', attemptedDepth: depth, maximumDepth: MAX_NESTED_DEPTH, failureCount }
    }
    return { admitted: true, depth, failureCount, retryOfDispatchId: retryOf as DispatchId | null }
  }

  private transitionDispatchInternal(
    input: DispatchTransitionInput,
    workerAlreadyTransitioned: boolean,
    updateTask: boolean
  ): DispatchRow {
    const current = this.getDispatchRecord(input.dispatchId)
    if (current.status !== input.expectedState) {
      fail(this.context, 'lifecycle_conflict', `Dispatch ${input.dispatchId} is ${current.status}, expected ${input.expectedState}`, {
        dispatchId: input.dispatchId,
        expectedState: input.expectedState,
        actualState: current.status
      })
    }
    const allowed =
      (current.status === 'pending' && ['dispatched', 'completed', 'failed', 'circuit_broken'].includes(input.nextState)) ||
      (current.status === 'dispatched' && ['completed', 'failed', 'circuit_broken'].includes(input.nextState))
    if (!allowed) fail(this.context, 'lifecycle_conflict', `Dispatch ${input.dispatchId} cannot move from ${current.status} to ${input.nextState}`, { dispatchId: input.dispatchId })
    if (input.nextState === 'dispatched' && (!current.assignee_session_id || !current.runtime_epoch || !current.process_incarnation)) {
      fail(this.context, 'lifecycle_conflict', `Dispatch ${input.dispatchId} has no attached live authority`, { dispatchId: input.dispatchId })
    }
    if (current.supervised && input.nextState === 'dispatched') {
      const port = this.requireWorkerPort(current.id as DispatchId)
      if (!port.workerForDispatch(this.store, current.id as DispatchId)) {
        fail(this.context, 'worker_port_unavailable', `supervised Dispatch ${current.id} has no worker record`, { dispatchId: current.id })
      }
    }
    let nextStatus = input.nextState
    let failureCount = current.failure_count
    let lastFailure = current.last_failure
    if ((input.nextState === 'failed' || input.nextState === 'circuit_broken') && input.failureClass === 'infrastructure') {
      failureCount += 1
      lastFailure = input.failureReason ?? 'infrastructure_failure'
      if (input.nextState === 'circuit_broken' || failureCount >= CIRCUIT_BREAK_FAILURES) nextStatus = 'circuit_broken'
    } else if (input.nextState === 'failed') {
      lastFailure = input.failureReason ?? (input.failureClass === 'worker_report' ? 'worker_report' : current.last_failure)
    }
    const completedAt = finalDispatch(nextStatus) ? input.at : null
    const terminationReason =
      'terminationReason' in input && input.terminationReason !== undefined
        ? input.terminationReason
        : current.termination_reason
    const update = this.store.run(
      `UPDATE dispatches
       SET status = ?, failure_count = ?, last_failure = ?, termination_reason = ?, completed_at = ?,
           dispatched_at = CASE WHEN ? = 'dispatched' THEN COALESCE(dispatched_at, ?) ELSE dispatched_at END
       WHERE id = ? AND status = ?`,
      nextStatus,
      failureCount,
      lastFailure,
      terminationReason,
      completedAt,
      nextStatus,
      input.at,
      current.id,
      input.expectedState
    )
    if (update.changes !== 1) fail(this.context, 'lifecycle_conflict', `Dispatch ${input.dispatchId} changed during transition`, { dispatchId: input.dispatchId })
    if (current.supervised && finalDispatch(nextStatus) && !workerAlreadyTransitioned) {
      this.requireWorkerPort(current.id as DispatchId).settleDispatch(this.store, current.id as DispatchId, nextStatus, input.at)
    }
    if (finalDispatch(nextStatus)) {
      this.closeQuestionsForDispatch(current.id, input.at)
      this.retireHeartbeats(current.id, input.at)
      this.dispatchSettledListener?.(current.id as DispatchId)
    }
    if (updateTask && finalDispatch(nextStatus)) this.reconcileTaskAfterDispatch(current, nextStatus, input)
    return this.getDispatch(current.id as DispatchId)
  }

  private reconcileTaskAfterDispatch(dispatch: DispatchRecord, status: DispatchStatus, input: DispatchTransitionInput): void {
    const task = this.getTaskRecord(dispatch.task_id as TaskId)
    if (status === 'completed') {
      this.store.run(`UPDATE tasks SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?`, input.at, task.id)
      this.closeQuestionsForTask(task.id, input.at)
      this.promoteReadyTasks(task.run_id)
      return
    }
    if (status === 'circuit_broken') {
      this.store.run(`UPDATE tasks SET status = 'failed', completed_at = NULL WHERE id = ?`, task.id)
      this.closeQuestionsForTask(task.id, input.at)
      return
    }
    if (status === 'failed') {
      const outcome = 'failureClass' in input ? input.failureClass : 'infrastructure'
      const nextTask = outcome === 'worker_report' ? 'failed' : 'ready'
      this.store.run(`UPDATE tasks SET status = ?, completed_at = NULL WHERE id = ?`, nextTask, task.id)
      if (nextTask === 'failed') this.closeQuestionsForTask(task.id, input.at)
    }
  }

  private closeQuestionsForDispatch(dispatchId: string, at: UtcTimestamp): void {
    const pending = this.store.all<{ message_id: string }>(
      `SELECT message_id FROM question_threads WHERE dispatch_id = ? AND status = 'pending'`,
      dispatchId
    )
    if (pending.length === 0) return
    this.store.run(
      `UPDATE question_threads SET status = 'closed', closed_at = ? WHERE dispatch_id = ? AND status = 'pending'`,
      at,
      dispatchId
    )
    this.questionsClosedListener?.(pending.map((row) => row.message_id))
  }

  private closeQuestionsForTask(taskId: string, at: UtcTimestamp): void {
    const dispatches = this.store.all<{ id: string }>(`SELECT id FROM dispatches WHERE task_id = ?`, taskId)
    for (const dispatch of dispatches) this.closeQuestionsForDispatch(dispatch.id, at)
  }

  private retireHeartbeats(dispatchId: string, at: UtcTimestamp): void {
    this.store.run(
      `UPDATE messages SET read = 1, delivered_at = COALESCE(delivered_at, ?)
       WHERE sender_kind = 'dispatch' AND sender_id = ? AND type = 'heartbeat' AND read = 0`,
      at,
      dispatchId
    )
  }

  private promoteReadyTasks(runId: string): void {
    const rows = this.store.all<TaskRecord>(`SELECT * FROM tasks WHERE run_id = ? AND status = 'pending' ORDER BY created_at, id`, runId)
    for (const row of rows) {
      const dependencies = jsonOf<TaskId[]>(row.dependency_task_ids_json, [])
      if (!dependencies.every((id) => this.store.get<{ status: TaskStatus }>('SELECT status FROM tasks WHERE id = ?', id)?.status === 'completed')) continue
      if (this.store.get<{ id: string }>(`SELECT id FROM gates WHERE task_id = ? AND status = 'pending' LIMIT 1`, row.id)) continue
      this.store.run(`UPDATE tasks SET status = 'ready' WHERE id = ? AND status = 'pending'`, row.id)
    }
  }

  private creatorDepth(caller: CoordinatorAuthority): number {
    if ('kind' in caller) return 0
    return this.store.get<{ depth: number }>(
      `SELECT MAX(depth) AS depth FROM dispatches WHERE assignee_session_id = ? AND status IN ('pending', 'dispatched')`,
      caller.runtimeSessionId
    )?.depth ?? 0
  }

  private creatorDispatchId(sessionId: string): DispatchId | null {
    const row = this.store.get<{ id: string }>(
      `SELECT id FROM dispatches WHERE assignee_session_id = ? AND status IN ('pending', 'dispatched') ORDER BY depth DESC, created_at DESC, id DESC LIMIT 1`,
      sessionId
    )
    return row?.id as DispatchId | undefined ?? null
  }

  private unbindSession(sessionId: string, at: UtcTimestamp, exceptRunId?: RunId): void {
    const rows = this.store.all<RunRecord>(
      `SELECT * FROM runs WHERE coordinator_session_id = ? AND id != 'run_unbound' ORDER BY id`,
      sessionId
    )
    for (const row of rows) {
      if (row.id === exceptRunId) continue
      const run = runRow(row)
      this.fenceRunConsumer(run, at)
      this.store.run(
        `UPDATE messages SET mailbox_kind = 'run', mailbox_id = ? WHERE run_id = ? AND mailbox_kind = 'session' AND mailbox_id = ? AND read = 0`,
        row.id,
        row.id,
        sessionId
      )
      this.store.run(
        `UPDATE runs SET coordinator_session_id = NULL, consumer_generation = consumer_generation + 1, updated_at = ? WHERE id = ?`,
        at,
        row.id
      )
      this.bindingListener?.(sessionId, row.id as RunId, run.consumerGeneration + 1)
    }
  }

  private fenceRunConsumer(run: RunRow, at: UtcTimestamp): void {
    this.store.run(
      `UPDATE deliveries SET status = 'fenced' WHERE mailbox_kind = 'run' AND mailbox_id = ? AND consumer_generation = ? AND status = 'outstanding'`,
      run.id,
      run.consumerGeneration
    )
    void at
  }

  private fenceDispatchConsumer(dispatchId: DispatchId, generation: number): void {
    this.store.run(
      `UPDATE deliveries SET status = 'fenced' WHERE mailbox_kind = 'dispatch' AND mailbox_id = ? AND consumer_generation = ? AND status = 'outstanding'`,
      dispatchId,
      generation
    )
  }


  private requireWorkerPort(dispatchId: DispatchId): WorkerLifecyclePort {
    if (!this.workerPort) fail(this.context, 'worker_port_unavailable', `supervised Dispatch ${dispatchId} cannot be accessed until the worker extension is active`, { dispatchId })
    return this.workerPort
  }

  private assertEvidence(caller: RuntimeCallerEvidence): void {
    if (!caller || caller.runtimeOwned !== true || caller.live !== true || caller.callerSessionId !== caller.runtimeSessionId) {
      fail(this.context, 'consumer_fenced', 'operation requires a current runtime-owned caller identity')
    }
  }
}
