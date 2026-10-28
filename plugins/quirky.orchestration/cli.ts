import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import type {
  AskResult,
  CheckResult,
  DispatchRow,
  GateRow,
  InboxResult,
  JsonValue,
  MessageRow,
  MutationReplay,
  OrchestrationMethod,
  OrchestrationMethodResult,
  RequestShowResult,
  RunRow,
  SendResult,
  TaskListRow,
  TaskResult,
  TaskRow,
  WorkerRow,
} from './src/contracts'
import { workerCommands } from './src/workers/cli'

type ObjectValue = Record<string, unknown>
type ResponseGuard<M extends OrchestrationMethod> = (value: unknown) => value is OrchestrationMethodResult<M>

const MESSAGE_TYPES = [
  'status', 'dispatch', 'worker_done', 'merge_ready', 'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
] as const
const TASK_STATUSES = ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'] as const
const DISPATCH_STATUSES = ['pending', 'dispatched', 'completed', 'failed', 'circuit_broken'] as const
const WORKER_STATES = ['starting', 'ready', 'start_unknown', 'failed', 'succeeded', 'stopping', 'stop_unknown', 'stopped', 'abandoned'] as const
const MESSAGE_PRIORITIES = ['normal', 'high', 'urgent'] as const
const MUTATION_METHODS = [
  'runCreate', 'runUse', 'taskCreate', 'taskUpdate', 'dispatch', 'send', 'check', 'reply', 'ask', 'gateCreate',
  'gateResolve', 'workerStart', 'workerStop', 'workerAbandon', 'workerRelease', 'workerRetain', 'reset'
] as const
const PROVIDER_IDS = ['claude', 'openclaude', 'codex', 'opencode', 'mimo', 'gemini', 'droid', 'grok', 'cursor'] as const

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.some((candidate) => candidate === value)
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || isString(value)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isObject(value) && Object.values(value).every(isJsonValue)
}

function hasString(value: ObjectValue, key: string): boolean {
  return isString(value[key])
}

function hasId(value: ObjectValue, key: string, prefix: string): boolean {
  return isString(value[key]) && value[key].startsWith(prefix)
}

function isRunRow(value: unknown): value is RunRow {
  return isObject(value) && hasId(value, 'id', 'run_') && hasString(value, 'objective') &&
    isStringOrNull(value.coordinatorSessionId) && isStringArray(value.coordinatorHistory) &&
    isSafeInteger(value.consumerGeneration) && hasString(value, 'createdAt') && hasString(value, 'updatedAt')
}

function isTaskResult(value: unknown): value is TaskResult {
  if (!isObject(value)) return false
  if (value.kind === 'coordinator_update') {
    return hasString(value, 'text') && hasString(value, 'reportedBy') && hasString(value, 'completedAt')
  }
  return value.kind === 'worker_report' && isOneOf(value.outcome, ['succeeded', 'failed']) &&
    hasId(value, 'messageId', 'msg_') && hasId(value, 'dispatchId', 'ctx_') && hasString(value, 'reportedBy') &&
    hasString(value, 'subject') && hasString(value, 'body') && hasString(value, 'completedBy') &&
    isStringArray(value.filesModified) && isStringOrNull(value.reportPath) && hasString(value, 'completedAt')
}

function isTaskRow(value: unknown): value is TaskRow {
  return isObject(value) && hasId(value, 'id', 'task_') && hasId(value, 'runId', 'run_') &&
    isStringOrNull(value.parentTaskId) && isStringArray(value.dependencyTaskIds) && hasString(value, 'createdBySessionId') &&
    hasString(value, 'taskTitle') && hasString(value, 'displayName') && hasString(value, 'spec') &&
    isOneOf(value.status, TASK_STATUSES) && (value.result === null || isTaskResult(value.result)) &&
    hasString(value, 'createdAt') && isStringOrNull(value.completedAt)
}

function isTaskListRow(value: unknown): value is TaskListRow {
  return isTaskRow(value) && (value.dispatchId === undefined || (isString(value.dispatchId) && value.dispatchId.startsWith('ctx_'))) &&
    (value.assigneeSessionId === undefined || isString(value.assigneeSessionId)) &&
    (value.specTruncated === undefined || value.specTruncated === true)
}

function isDispatchRow(value: unknown): value is DispatchRow {
  return isObject(value) && hasId(value, 'id', 'ctx_') && hasId(value, 'runId', 'run_') &&
    hasId(value, 'taskId', 'task_') && value.contractVersion === 1 && isOneOf(value.status, DISPATCH_STATUSES) &&
    isStringOrNull(value.assigneeSessionId) && isStringOrNull(value.creatorSessionId) &&
    isStringOrNull(value.creatorDispatchId) && isStringOrNull(value.retryOfDispatchId) &&
    isSafeInteger(value.depth) && isSafeInteger(value.failureCount) && isStringOrNull(value.lastFailure) &&
    isStringOrNull(value.terminationReason) && isSafeInteger(value.consumerGeneration) && hasString(value, 'createdAt') &&
    isStringOrNull(value.dispatchedAt) && isStringOrNull(value.completedAt) && isStringOrNull(value.lastHeartbeatAt)
}

function isWorkerRow(value: unknown): value is WorkerRow {
  return isObject(value) && hasId(value, 'dispatchId', 'ctx_') && isOneOf(value.state, WORKER_STATES) &&
    hasString(value, 'stage') && isStringOrNull(value.worktreeId) && isStringOrNull(value.sessionId) &&
    hasString(value, 'setupState') && Array.isArray(value.effects) && value.effects.every(isJsonValue) &&
    Array.isArray(value.residualResources) && value.residualResources.every(isJsonValue) &&
    isStringOrNull(value.lastError) && hasString(value, 'createdAt') && hasString(value, 'updatedAt')
}

function isMailboxAddress(value: unknown): boolean {
  if (!isObject(value)) return false
  if (value.kind === 'run') return hasId(value, 'runId', 'run_')
  if (value.kind === 'dispatch') return hasId(value, 'dispatchId', 'ctx_')
  return value.kind === 'session' && hasString(value, 'sessionId')
}

function isMessageRow(value: unknown): value is MessageRow {
  return isObject(value) && hasId(value, 'id', 'msg_') && hasId(value, 'runId', 'run_') &&
    hasString(value, 'fromSessionId') && isMailboxAddress(value.sender) && isMailboxAddress(value.mailbox) &&
    hasString(value, 'subject') && hasString(value, 'body') && isOneOf(value.type, MESSAGE_TYPES) &&
    isOneOf(value.priority, MESSAGE_PRIORITIES) && isStringOrNull(value.threadId) &&
    (value.payload === null || isJsonValue(value.payload)) && isBoolean(value.read) &&
    hasString(value, 'createdAt') && isStringOrNull(value.deliveredAt)
}

function isGateRow(value: unknown): value is GateRow {
  return isObject(value) && hasId(value, 'id', 'gate_') && hasId(value, 'runId', 'run_') &&
    hasId(value, 'taskId', 'task_') && hasString(value, 'question') && isStringArray(value.options) &&
    isOneOf(value.status, ['pending', 'resolved', 'timeout']) && isStringOrNull(value.resolution) &&
    hasString(value, 'createdBySessionId') && hasString(value, 'createdAt') && isStringOrNull(value.resolvedAt)
}

function isMutationReplay(value: unknown): value is MutationReplay {
  return isObject(value) && hasString(value, 'requestId') && isBoolean(value.replayed)
}

function hasMutation(value: ObjectValue): boolean {
  return isMutationReplay(value.mutation)
}

function isRunCreateResult(value: unknown): value is OrchestrationMethodResult<'runCreate'> {
  return isObject(value) && isRunRow(value.run) && hasMutation(value)
}

function isRunUseResult(value: unknown): value is OrchestrationMethodResult<'runUse'> {
  return isObject(value) && isRunRow(value.run) && hasMutation(value)
}

function isRunCurrentResult(value: unknown): value is OrchestrationMethodResult<'runCurrent'> {
  return isObject(value) && (value.run === null || isRunRow(value.run))
}

function isRunListResult(value: unknown): value is OrchestrationMethodResult<'runList'> {
  return isObject(value) && Array.isArray(value.runs) && value.runs.every(isRunRow) &&
    isStringOrNull(value.nextCursor)
}

function isRunShowResult(value: unknown): value is OrchestrationMethodResult<'runShow'> {
  return isObject(value) && isRunRow(value.run)
}

function isTaskCreateResult(value: unknown): value is OrchestrationMethodResult<'taskCreate'> {
  return isObject(value) && isTaskRow(value.task) && hasMutation(value)
}

function isTaskListResult(value: unknown): value is OrchestrationMethodResult<'taskList'> {
  return isObject(value) && hasId(value, 'runId', 'run_') && Array.isArray(value.tasks) &&
    value.tasks.every(isTaskListRow) && isSafeInteger(value.count)
}

function isTaskUpdateResult(value: unknown): value is OrchestrationMethodResult<'taskUpdate'> {
  return isObject(value) && isTaskRow(value.task) && isBoolean(value.unchanged) && hasMutation(value)
}

function isDispatchResult(value: unknown): value is OrchestrationMethodResult<'dispatch'> {
  if (!isObject(value)) return false
  if (value.dryRun === true) return value.dispatch === null && (value.preamble === undefined || isString(value.preamble))
  return value.dryRun === false && isDispatchRow(value.dispatch) && hasMutation(value) &&
    (value.preamble === undefined || isString(value.preamble))
}

function isDispatchShowResult(value: unknown): value is OrchestrationMethodResult<'dispatchShow'> {
  return isObject(value) && (value.dispatch === null || isDispatchRow(value.dispatch)) &&
    (value.worker === null || isWorkerRow(value.worker)) &&
    (value.preamble === undefined || isString(value.preamble))
}

function isWorkerReport(value: unknown): boolean {
  if (!isObject(value)) return false
  if (value.status === 'rejected') return hasString(value, 'reason') && value.audited === true
  return (value.status === 'accepted' || value.status === 'duplicate') && isTaskRow(value.task) &&
    isDispatchRow(value.dispatch) && (value.worker === null || isWorkerRow(value.worker))
}

function isHeartbeat(value: unknown): boolean {
  if (!isObject(value)) return false
  if (value.status === 'accepted') return hasString(value, 'lastHeartbeatAt')
  return value.status === 'rejected' && hasString(value, 'reason') && value.lastHeartbeatAt === null
}

function isSendResult(value: unknown): value is SendResult {
  if (!isObject(value) || !hasMutation(value) || !Array.isArray(value.messages) || !value.messages.every(isMessageRow)) return false
  if (value.kind === 'message') return isStringOrNull(value.threadId)
  if (value.kind === 'worker_report') return isWorkerReport(value.report)
  return value.kind === 'heartbeat' && isHeartbeat(value.heartbeat)
}

function isCheckObservation(value: ObjectValue): boolean {
  return (value.runId === null || hasId(value, 'runId', 'run_')) && Array.isArray(value.messages) &&
    value.messages.every(isMessageRow) && isSafeInteger(value.count) && isStringOrNull(value.acknowledged) &&
    isBoolean(value.timedOut) && isBoolean(value.cancelled) && isBoolean(value.connectionLost) &&
    (value.formatted === undefined || isString(value.formatted)) &&
    (value.waitInterrupted === undefined || isOneOf(value.waitInterrupted, ['consumer_fenced', 'waiter_exists', 'outcome_unknown']))
}

function isCheckResult(value: unknown): value is CheckResult {
  if (!isObject(value) || !isCheckObservation(value)) return false
  if (value.mode === 'consume') {
    return isStringOrNull(value.deliveryId) && isBoolean(value.replayed) && hasMutation(value)
  }
  if (value.mode === 'peek' || value.mode === 'all') {
    return value.mutation === undefined || isMutationReplay(value.mutation)
  }
  return false
}

function isReplyResult(value: unknown): value is OrchestrationMethodResult<'reply'> {
  if (!isObject(value) || !hasMutation(value) || !hasId(value, 'messageId', 'msg_') || !hasString(value, 'threadId')) return false
  if (value.kind === 'question_answer') {
    return hasId(value, 'answerMessageId', 'msg_') && isBoolean(value.duplicate)
  }
  return value.kind === 'ordinary_reply' && isMessageRow(value.replyMessage)
}

function isInboxMessage(value: unknown): boolean {
  if (!isObject(value) || !hasId(value, 'id', 'msg_') || !hasId(value, 'runId', 'run_') ||
    !hasString(value, 'fromSessionId') || !isMailboxAddress(value.sender) || !isMailboxAddress(value.mailbox) ||
    !hasString(value, 'subject') || !isOneOf(value.type, MESSAGE_TYPES) || !isOneOf(value.priority, MESSAGE_PRIORITIES) ||
    !isStringOrNull(value.threadId) || !isBoolean(value.read) || !hasString(value, 'createdAt') ||
    !isStringOrNull(value.deliveredAt)) return false
  return (value.body === undefined || isString(value.body)) &&
    (value.payload === undefined || value.payload === null || isJsonValue(value.payload))
}

function isInboxResult(value: unknown): value is InboxResult {
  return isObject(value) && isBoolean(value.full) && Array.isArray(value.messages) &&
    value.messages.every(value.full ? isMessageRow : isInboxMessage) && isSafeInteger(value.count)
}

function isAskResult(value: unknown): value is AskResult {
  if (!isObject(value) || !hasId(value, 'messageId', 'msg_') || !hasString(value, 'threadId') ||
    !isSafeInteger(value.timeoutMs) || !hasMutation(value)) return false
  if (value.state === 'answered') {
    return hasString(value, 'answer') && hasId(value, 'answerMessageId', 'msg_')
  }
  return isOneOf(value.state, ['timedOut', 'cancelled', 'connectionLost']) && value.answer === null
}

function isGateCreateResult(value: unknown): value is OrchestrationMethodResult<'gateCreate'> {
  return isObject(value) && isGateRow(value.gate) && isTaskRow(value.task) && hasMutation(value)
}

function isGateResolveResult(value: unknown): value is OrchestrationMethodResult<'gateResolve'> {
  return isObject(value) && isGateRow(value.gate) && isTaskRow(value.task) && hasMutation(value)
}

function isGateListResult(value: unknown): value is OrchestrationMethodResult<'gateList'> {
  return isObject(value) && hasId(value, 'runId', 'run_') && Array.isArray(value.gates) &&
    value.gates.every(isGateRow) && isSafeInteger(value.count)
}

function isMutationReceipt(value: unknown): boolean {
  if (!isObject(value) || !hasString(value, 'requestId') || !isOneOf(value.state, ['pending', 'completed']) ||
    !isOneOf(value.method, MUTATION_METHODS) || !hasString(value, 'createdAt') || !hasString(value, 'updatedAt')) return false
  return (value.checkpoint === undefined || isJsonValue(value.checkpoint)) &&
    (value.result === undefined || isJsonValue(value.result))
}

function isRequestShowResult(value: unknown): value is RequestShowResult {
  if (!isObject(value) || !hasString(value, 'requestId')) return false
  if (value.state === 'absent') return value.interpretation === 'absence_does_not_prove_no_effect'
  if (value.state === 'completed') {
    return isOneOf(value.method, MUTATION_METHODS) && hasString(value, 'createdAt') && hasString(value, 'updatedAt') &&
      isMutationReceipt(value.receipt) && value.interpretation === 'completed_and_replayable'
  }
  return value.state === 'pending' && isOneOf(value.method, MUTATION_METHODS) &&
    hasString(value, 'createdAt') && hasString(value, 'updatedAt') && isMutationReceipt(value.receipt) &&
    value.interpretation === 'running_or_outcome_unknown'
}

function isResetResult(value: unknown): value is OrchestrationMethodResult<'reset'> {
  return isObject(value) && isOneOf(value.mode, ['messages', 'tasks', 'all']) && hasMutation(value)
}

function stringFlag(args: CliArgs, context: CliContext, name: string, required?: true): string
function stringFlag(args: CliArgs, context: CliContext, name: string, required: false): string | undefined
function stringFlag(args: CliArgs, context: CliContext, name: string, required = true): string | undefined {
  const value = args.flags[name]
  if (value === undefined && !required) return undefined
  if (!isString(value) || value.length === 0) throw context.usage(`--${name} must be a nonempty string`)
  return value
}

function booleanFlag(args: CliArgs, context: CliContext, name: string): boolean {
  const value = args.flags[name]
  if (value === undefined) return false
  if (!isBoolean(value)) throw context.usage(`--${name} must be a boolean`)
  return value
}

function integerFlag(args: CliArgs, context: CliContext, name: string): number | undefined {
  const value = args.flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    throw context.usage(`--${name} must be an integer`)
  }
  return value
}

function hasFlag(args: CliArgs, name: string): boolean {
  return Object.hasOwn(args.flags, name)
}

function jsonFlag(args: CliArgs, context: CliContext, name: string): unknown {
  const value = args.flags[name]
  if (value === undefined) return undefined
  if (!isJsonValue(value)) throw context.usage(`--${name} must be a JSON value`)
  return value
}

function stringArrayFlag(args: CliArgs, context: CliContext, name: string): readonly string[] | undefined {
  const value = jsonFlag(args, context, name)
  if (value === undefined) return undefined
  if (!isStringArray(value)) throw context.usage(`--${name} must be a JSON array of strings`)
  return value
}

function csvFlag(args: CliArgs, context: CliContext, name: string): readonly string[] | undefined {
  const value = stringFlag(args, context, name, false)
  if (value === undefined) return undefined
  const entries = value.split(',').map((entry) => entry.trim())
  if (entries.some((entry) => entry.length === 0)) throw context.usage(`--${name} must be a comma-separated list of nonempty values`)
  return entries
}

function addCallerAliases(params: ObjectValue, args: CliArgs, context: CliContext): void {
  const from = stringFlag(args, context, 'from', false)
  const terminal = stringFlag(args, context, 'terminal', false)
  if (from !== undefined && terminal !== undefined && from !== terminal) {
    throw context.usage('--from and --terminal must identify the same session')
  }
  if (from !== undefined) params.from = from
  if (terminal !== undefined) params.terminal = terminal
}

function addMutationReceipt(params: ObjectValue, context: CliContext): void {
  params.requestId = context.requestBase
  params.contractVersion = 1
}

function idLabel(value: string, limit = 60): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function replayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function retryCommand(verb: string, args: CliArgs, requestId: string): string {
  const words = ['quirky', 'orchestration', verb, ...args.positionals.map(shellQuote)]
  for (const [name, value] of Object.entries(args.flags)) {
    if (name === 'help' || value === undefined) continue
    if (typeof value === 'boolean') {
      words.push(value ? `--${name}` : `--${name}=false`)
    } else if (Array.isArray(value)) {
      for (const item of value) words.push(`--${name}`, shellQuote(replayValue(item)))
    } else {
      words.push(`--${name}`, shellQuote(replayValue(value)))
    }
  }
  if (verb === 'reset') words.push('--yes')
  words.push('--retry-request', shellQuote(requestId))
  return words.join(' ')
}

function isConnectionLost(value: unknown): boolean {
  return value instanceof Error && (value.name === 'ConnectionLostError' || value.name === 'ConnectionLost')
}

function recoveryText(verb: string, args: CliArgs, requestId: string, detail: string): string {
  const inspect = `quirky orchestration request-show --request ${shellQuote(requestId)} --json`
  return `${detail}\nInspect the receipt with:\n${inspect}\nTo retry the same mutation without creating new work, run:\n${retryCommand(verb, args, requestId)}`
}

async function call<M extends OrchestrationMethod>(
  context: CliContext,
  args: CliArgs,
  verb: string,
  method: M,
  params: ObjectValue,
  guard: ResponseGuard<M>,
  options?: { timeoutMs?: number }
): Promise<OrchestrationMethodResult<M>> {
  const requestId = isString(params.requestId) ? params.requestId : undefined
  let result: unknown
  try {
    result = await context.call(`quirky.orchestration/${method}`, params, options)
  } catch (error) {
    if (requestId !== undefined && isConnectionLost(error)) {
      throw context.fail(recoveryText(
        verb,
        args,
        requestId,
        `The transport was lost during ${verb}; the mutation outcome is unknown. No replacement mutation was sent.`
      ))
    }
    throw error
  }
  if (!guard(result)) {
    const detail = `The runtime returned a response that does not match quirky.orchestration/${method}.`
    if (requestId !== undefined) {
      throw context.fail(recoveryText(
        verb,
        args,
        requestId,
        `${detail} The mutation may have been accepted; no replacement mutation was sent.`
      ))
    }
    throw context.fail(detail)
  }
  return result
}

function output<T>(context: CliContext, value: T, text: string): void {
  context.out.result(value, () => text)
}

function parseSendTarget(value: string, context: CliContext): ObjectValue {
  if (value.startsWith('run:')) {
    const runId = value.slice('run:'.length)
    if (!runId) throw context.usage('--to run: requires a Run ID')
    return { kind: 'run', runId }
  }
  if (value.startsWith('dispatch:')) {
    const dispatchId = value.slice('dispatch:'.length)
    if (!dispatchId) throw context.usage('--to dispatch: requires a Dispatch ID')
    return { kind: 'dispatch', dispatchId }
  }
  if (value === '@all' || value === '@idle') {
    return { kind: 'group', group: value.slice(1) }
  }
  if (value.startsWith('@worktree:')) {
    const worktreeId = value.slice('@worktree:'.length)
    if (!worktreeId) throw context.usage('--to @worktree: requires a published worktree ID')
    return { kind: 'group', group: 'worktree', worktreeId }
  }
  if (value.startsWith('@')) {
    const providerId = value.slice(1)
    if (!isOneOf(providerId, PROVIDER_IDS)) {
      throw context.usage(`--to ${value} must use a published provider ID: ${PROVIDER_IDS.join(', ')}`)
    }
    return { kind: 'group', group: 'provider', providerId }
  }
  return { kind: 'session', sessionId: value }
}

function addStructuredSendPayload(params: ObjectValue, args: CliArgs, context: CliContext, type: string): void {
  const payload = jsonFlag(args, context, 'payload')
  const taskId = stringFlag(args, context, 'task-id', false)
  const dispatchId = stringFlag(args, context, 'dispatch-id', false)
  const outcome = stringFlag(args, context, 'outcome', false)
  const filesModified = csvFlag(args, context, 'files-modified')
  const reportPath = stringFlag(args, context, 'report-path', false)
  const phase = stringFlag(args, context, 'phase', false)
  const structured = taskId !== undefined || dispatchId !== undefined || outcome !== undefined ||
    filesModified !== undefined || reportPath !== undefined || phase !== undefined

  if (payload !== undefined && structured) throw context.usage('--payload cannot be combined with structured payload flags')
  if (outcome !== undefined && type !== 'worker_done') throw context.usage('--outcome is only valid with --type worker_done')
  if (type === 'worker_done' && phase !== undefined) throw context.usage('--phase cannot be combined with --type worker_done')
  if (type === 'heartbeat' && (filesModified !== undefined || reportPath !== undefined)) {
    throw context.usage('--files-modified and --report-path cannot be combined with --type heartbeat')
  }
  if (params.to !== undefined && isObject(params.to) && params.to.kind === 'group' &&
    (type === 'worker_done' || type === 'heartbeat' || type === 'escalation' || type === 'decision_gate')) {
    throw context.usage(`--type ${type} requires one exact Run, Dispatch, or session destination; groups are not supported`)
  }

  if (payload !== undefined) {
    params.payload = payload
    return
  }
  if (taskId !== undefined) params.taskId = taskId
  if (dispatchId !== undefined) params.dispatchId = dispatchId
  if (outcome !== undefined) params.outcome = outcome
  if (filesModified !== undefined) params.filesModified = filesModified
  if (reportPath !== undefined) params.reportPath = reportPath
  if (phase !== undefined) params.phase = phase

  if (type === 'worker_done' && (taskId === undefined || dispatchId === undefined || outcome === undefined)) {
    throw context.usage('--type worker_done requires --task-id, --dispatch-id, and --outcome unless --payload is supplied')
  }
  if (type === 'heartbeat' && (taskId === undefined || dispatchId === undefined)) {
    throw context.usage('--type heartbeat requires --task-id and --dispatch-id unless --payload is supplied')
  }
}

function keepalive<T>(context: CliContext, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  const startedAt = context.now()
  const deadlineMs = startedAt + timeoutMs
  const timer = setInterval(() => {
    const elapsedMs = Math.max(0, context.now() - startedAt)
    process.stderr.write(`${JSON.stringify({ _keepalive: true, _heartbeat: true, elapsedMs, deadlineMs })}\n`)
  }, 15_000)
  return operation().finally(() => clearInterval(timer))
}

export const commands: CliModule['commands'] = {
  ...workerCommands,
  'run-create': async (args, context) => {
    const params: ObjectValue = { objective: stringFlag(args, context, 'objective') }
    addCallerAliases(params, args, context)
    addMutationReceipt(params, context)
    const result = await call(context, args, 'run-create', 'runCreate', params, isRunCreateResult)
    output(context, result, `Run ${result.run.id} created and bound: ${result.run.objective}`)
  },

  'run-use': async (args, context) => {
    const params: ObjectValue = { runId: stringFlag(args, context, 'id') }
    addCallerAliases(params, args, context)
    addMutationReceipt(params, context)
    const result = await call(context, args, 'run-use', 'runUse', params, isRunUseResult)
    output(context, result, `Using Run ${result.run.id}: ${result.run.objective}`)
  },

  'run-current': async (args, context) => {
    const params: ObjectValue = {}
    addCallerAliases(params, args, context)
    const result = await call(context, args, 'run-current', 'runCurrent', params, isRunCurrentResult)
    output(context, result, result.run === null ? 'No Run is bound to this session.' : `${result.run.id} ${result.run.objective}`)
  },

  'run-list': async (args, context) => {
    const limit = integerFlag(args, context, 'limit') ?? 100
    if (limit < 1 || limit > 100) throw context.usage('--limit must be between 1 and 100')
    const params: ObjectValue = { limit }
    const cursor = stringFlag(args, context, 'cursor', false)
    if (cursor !== undefined) params.cursor = cursor
    const result = await call(context, args, 'run-list', 'runList', params, isRunListResult)
    const rows = result.runs.map((run) => `${run.id} ${idLabel(run.objective, 80)}`)
    if (result.nextCursor !== null) rows.push(`Next cursor: ${result.nextCursor}`)
    output(context, result, rows.length === 0 ? 'No Runs found.' : rows.join('\n'))
  },

  'run-show': async (args, context) => {
    const params: ObjectValue = { runId: stringFlag(args, context, 'id') }
    const result = await call(context, args, 'run-show', 'runShow', params, isRunShowResult)
    output(context, result, `Run ${result.run.id}: ${result.run.objective}\nconsumer generation ${result.run.consumerGeneration}; created ${result.run.createdAt}`)
  },

  'task-create': async (args, context) => {
    const params: ObjectValue = { spec: stringFlag(args, context, 'spec') }
    addCallerAliases(params, args, context)
    const runId = stringFlag(args, context, 'run', false)
    const taskTitle = stringFlag(args, context, 'task-title', false)
    const displayName = stringFlag(args, context, 'display-name', false)
    const dependencyTaskIds = stringArrayFlag(args, context, 'deps')
    const parentTaskId = stringFlag(args, context, 'parent', false)
    if (runId !== undefined) params.runId = runId
    if (taskTitle !== undefined) params.taskTitle = taskTitle
    if (displayName !== undefined) params.displayName = displayName
    if (dependencyTaskIds !== undefined) params.dependencyTaskIds = dependencyTaskIds
    if (parentTaskId !== undefined) params.parentTaskId = parentTaskId
    addMutationReceipt(params, context)
    const result = await call(context, args, 'task-create', 'taskCreate', params, isTaskCreateResult)
    output(context, result, `Created ${result.task.id} [${result.task.status}]`)
  },

  'task-list': async (args, context) => {
    if (hasFlag(args, 'ready') && hasFlag(args, 'status')) {
      throw context.usage('--ready and --status are mutually exclusive')
    }
    const params: ObjectValue = {}
    addCallerAliases(params, args, context)
    const runId = stringFlag(args, context, 'run', false)
    const status = stringFlag(args, context, 'status', false)
    if (runId !== undefined) params.runId = runId
    if (status !== undefined) params.status = status
    if (hasFlag(args, 'ready')) params.ready = booleanFlag(args, context, 'ready')
    if (booleanFlag(args, context, 'brief')) params.brief = true
    const result = await call(context, args, 'task-list', 'taskList', params, isTaskListResult)
    const rows = result.tasks.map((task) => {
      const assignee = task.assigneeSessionId && task.dispatchId ? ` -> ${task.assigneeSessionId} (${task.dispatchId})` : ''
      return `${task.id} [${task.status}] ${idLabel(task.displayName)}${assignee}`
    })
    output(context, result, rows.length === 0 ? `No Tasks found in Run ${result.runId}.` : rows.join('\n'))
  },

  'task-update': async (args, context) => {
    const params: ObjectValue = { taskId: stringFlag(args, context, 'id') }
    addCallerAliases(params, args, context)
    const runId = stringFlag(args, context, 'run', false)
    const status = stringFlag(args, context, 'status', false)
    const resultText = stringFlag(args, context, 'result', false)
    if (runId !== undefined) params.runId = runId
    if (status !== undefined) params.status = status
    if (resultText !== undefined) params.result = resultText
    addMutationReceipt(params, context)
    const result = await call(context, args, 'task-update', 'taskUpdate', params, isTaskUpdateResult)
    output(context, result, result.unchanged ? `Task ${result.task.id} unchanged [${result.task.status}]` : `Updated ${result.task.id} -> ${result.task.status}`)
  },

  dispatch: async (args, context) => {
    const params: ObjectValue = {
      taskId: stringFlag(args, context, 'task'),
      to: stringFlag(args, context, 'to')
    }
    addCallerAliases(params, args, context)
    const runId = stringFlag(args, context, 'run', false)
    if (runId !== undefined) params.runId = runId
    if (hasFlag(args, 'inject')) params.inject = booleanFlag(args, context, 'inject')
    const dryRun = booleanFlag(args, context, 'dry-run')
    if (hasFlag(args, 'dry-run')) params.dryRun = dryRun
    if (hasFlag(args, 'return-preamble')) params.returnPreamble = booleanFlag(args, context, 'return-preamble')
    if (!dryRun) addMutationReceipt(params, context)
    const result = await call(context, args, 'dispatch', 'dispatch', params, isDispatchResult)
    const details = result.preamble === undefined ? '' : `\n${result.preamble}`
    const text = result.dryRun
      ? `Dispatch dry-run for task ${params.taskId}.${details}`
      : `Dispatch ${result.dispatch.id} created for task ${result.dispatch.taskId}.${details}`
    output(context, result, text)
  },

  'dispatch-show': async (args, context) => {
    const params: ObjectValue = { taskId: stringFlag(args, context, 'task') }
    addCallerAliases(params, args, context)
    if (hasFlag(args, 'preamble')) params.includePreamble = booleanFlag(args, context, 'preamble')
    const result = await call(context, args, 'dispatch-show', 'dispatchShow', params, isDispatchShowResult)
    const text = result.dispatch === null
      ? `No Dispatch found for task ${params.taskId}.${result.preamble === undefined ? '' : `\n${result.preamble}`}`
      : `Dispatch ${result.dispatch.id} [${result.dispatch.status}] for task ${result.dispatch.taskId}.${result.preamble === undefined ? '' : `\n${result.preamble}`}`
    output(context, result, text)
  },

  send: async (args, context) => {
    const type = stringFlag(args, context, 'type', false) ?? 'status'
    const priority = stringFlag(args, context, 'priority', false)
    const targetText = stringFlag(args, context, 'to', false)
    const params: ObjectValue = {
      subject: stringFlag(args, context, 'subject'),
      type,
      ...(priority === undefined ? {} : { priority }),
      ...(targetText === undefined ? {} : { to: parseSendTarget(targetText, context) })
    }
    addCallerAliases(params, args, context)
    const runId = stringFlag(args, context, 'run', false)
    const body = stringFlag(args, context, 'body', false)
    const threadId = stringFlag(args, context, 'thread-id', false)
    if (runId !== undefined) params.runId = runId
    if (body !== undefined) params.body = body
    if (threadId !== undefined) params.threadId = threadId
    addStructuredSendPayload(params, args, context, type)
    addMutationReceipt(params, context)
    const result = await call(context, args, 'send', 'send', params, isSendResult)
    const text = result.kind === 'message'
      ? `${result.messages.length === 1 ? 'Sent' : `Sent ${result.messages.length} messages`}${result.messages.length === 0 ? '' : ` ${result.messages.map((message) => message.id).join(', ')}`}`
      : result.kind === 'worker_report'
        ? `Worker report ${result.report.status}${result.messages.length === 0 ? '' : `: ${result.messages.map((message) => message.id).join(', ')}`}`
        : `Heartbeat ${result.heartbeat.status}${result.messages.length === 0 ? '' : `: ${result.messages.map((message) => message.id).join(', ')}`}`
    output(context, result, text)
  },

  check: async (args, context) => {
    const modes = ['unread', 'peek', 'all'].filter((name) => booleanFlag(args, context, name))
    if (modes.length > 1) throw context.usage('Choose at most one message read mode: --unread, --peek, or --all')
    const mode = modes[0] === 'peek' ? 'peek' : modes[0] === 'all' ? 'all' : 'consume'
    const wait = booleanFlag(args, context, 'wait')
    if (wait && mode !== 'consume') throw context.usage('--wait cannot be combined with --peek or --all')
    const timeoutFlag = integerFlag(args, context, 'timeout-ms')
    if (timeoutFlag !== undefined && (timeoutFlag < 0 || !Number.isSafeInteger(timeoutFlag))) {
      throw context.usage('--timeout-ms must be a nonnegative safe integer')
    }
    const params: ObjectValue = { mode }
    addCallerAliases(params, args, context)
    const runId = stringFlag(args, context, 'run', false)
    const ackDeliveryId = stringFlag(args, context, 'ack', false)
    const types = csvFlag(args, context, 'types')
    if (runId !== undefined) params.runId = runId
    if (ackDeliveryId !== undefined) params.ackDeliveryId = ackDeliveryId
    if (hasFlag(args, 'format')) params.format = booleanFlag(args, context, 'format')
    if (wait) params.wait = true
    if (timeoutFlag !== undefined) params.timeoutMs = timeoutFlag
    if (types !== undefined) {
      for (const type of types) {
        if (!isOneOf(type, MESSAGE_TYPES)) throw context.usage(`--types contains unknown message type ${type}`)
      }
      params.types = types
    }
    const mutating = mode === 'consume' || ackDeliveryId !== undefined
    if (mutating) addMutationReceipt(params, context)
    const waitTimeoutMs = wait ? timeoutFlag ?? 120_000 : undefined
    if (waitTimeoutMs !== undefined) params.timeoutMs = waitTimeoutMs
    else if (timeoutFlag !== undefined) params.timeoutMs = timeoutFlag
    const callOptions = waitTimeoutMs === undefined ? undefined : { timeoutMs: waitTimeoutMs + 10_000 }
    const request = () => call(context, args, 'check', 'check', params, isCheckResult, callOptions)
    const result = waitTimeoutMs === undefined ? await request() : await keepalive(context, waitTimeoutMs, request)
    const text = result.formatted !== undefined && booleanFlag(args, context, 'format')
      ? result.formatted
      : result.messages.length > 0
        ? [
            ...(result.mode === 'consume' && result.deliveryId !== null ? [`Delivery ${result.deliveryId}`] : []),
            ...result.messages.map((message) => `${message.id} [${message.type}] from=${message.fromSessionId} "${message.subject}"`)
          ].join('\n')
        : result.timedOut
          ? 'Wait timed out; no messages were consumed.'
          : result.cancelled
            ? 'Wait cancelled; no messages were consumed.'
            : result.connectionLost
              ? 'Mailbox wait lost its connection; the result reports whether anything was acknowledged.'
              : result.waitInterrupted !== undefined
                ? `Mailbox wait interrupted: ${result.waitInterrupted}${result.acknowledged === null ? '' : `; acknowledged ${result.acknowledged}`}`
                : result.acknowledged !== null
                  ? `Acknowledged Delivery ${result.acknowledged}. No messages are currently available.`
                  : 'No messages.'
    output(context, result, text)
  },

  reply: async (args, context) => {
    const params: ObjectValue = {
      messageId: stringFlag(args, context, 'id'),
      body: stringFlag(args, context, 'body')
    }
    addCallerAliases(params, args, context)
    const runId = stringFlag(args, context, 'run', false)
    if (runId !== undefined) params.runId = runId
    addMutationReceipt(params, context)
    const result = await call(context, args, 'reply', 'reply', params, isReplyResult)
    output(context, result, `Replied ${result.messageId}`)
  },

  inbox: async (args, context) => {
    const params: ObjectValue = {}
    const limit = integerFlag(args, context, 'limit')
    const terminal = stringFlag(args, context, 'terminal', false)
    if (limit !== undefined) {
      if (limit < 1 || !Number.isSafeInteger(limit)) throw context.usage('--limit must be a positive safe integer')
      params.limit = limit
    } else if (terminal !== undefined) {
      params.limit = 100
    } else {
      params.limit = 20
    }
    if (terminal !== undefined) params.terminal = terminal
    if (hasFlag(args, 'full')) params.full = booleanFlag(args, context, 'full')
    const result = await call(context, args, 'inbox', 'inbox', params, isInboxResult)
    const text = result.messages.length === 0
      ? 'No messages found.'
      : result.messages.map((message) => `${message.id} ${message.fromSessionId} -> ${message.mailbox.kind}: "${message.subject}"${'body' in message ? `\n${message.body ?? ''}` : ''}`).join('\n')
    output(context, result, text)
  },

  ask: async (args, context) => {
    const question = stringFlag(args, context, 'question', false)
    const resume = stringFlag(args, context, 'resume', false)
    if ((question === undefined) === (resume === undefined)) throw context.usage('Specify exactly one of --question or --resume')
    const options = stringFlag(args, context, 'options', false)
    if (resume !== undefined && options !== undefined) throw context.usage('--options is only valid with --question')
    const timeoutFlag = integerFlag(args, context, 'timeout-ms')
    const timeoutMs = Math.max(0, Math.min(1_800_000, timeoutFlag ?? 600_000))
    const params: ObjectValue = { mode: question === undefined ? 'resume' : 'question', timeoutMs }
    addCallerAliases(params, args, context)
    const runId = stringFlag(args, context, 'run', false)
    const target = stringFlag(args, context, 'to', false)
    if (runId !== undefined) params.runId = runId
    if (target !== undefined) {
      if (!target.startsWith('run:') || target.slice('run:'.length).length === 0) {
        throw context.usage('--to for ask must be run:<runId>')
      }
      params.to = { kind: 'run', runId: target.slice('run:'.length) }
    }
    if (question !== undefined) {
      params.question = question
      const parsedOptions = options === undefined ? undefined : options.split(',').map((entry) => entry.trim())
      if (parsedOptions?.some((entry) => entry.length === 0)) throw context.usage('--options must be a comma-separated list of nonempty choices')
      if (parsedOptions !== undefined) params.options = parsedOptions
    } else {
      params.messageId = resume
    }
    addMutationReceipt(params, context)
    const result = await call(context, args, 'ask', 'ask', params, isAskResult, { timeoutMs: timeoutMs + 5_000 })
    if (result.state === 'answered') {
      output(context, result, result.answer)
      return
    }
    if (context.out.json) output(context, result, '')
    const resumeCommand = `quirky orchestration ask --resume ${result.messageId} --timeout-ms ${result.timeoutMs}`
    const failure = result.state === 'timedOut'
      ? `ask timeout after ${result.timeoutMs}ms; question is still pending (messageId: ${result.messageId}). Resume waiting; do not ask again:\n${resumeCommand}`
      : `ask ${result.state}; question is still pending (messageId: ${result.messageId}). Resume waiting; do not ask again:\n${resumeCommand}`
    throw context.fail(failure)
  },

  'gate-create': async (args, context) => {
    const params: ObjectValue = {
      taskId: stringFlag(args, context, 'task'),
      question: stringFlag(args, context, 'question')
    }
    addCallerAliases(params, args, context)
    const options = stringArrayFlag(args, context, 'options')
    if (options !== undefined) params.options = options
    addMutationReceipt(params, context)
    const result = await call(context, args, 'gate-create', 'gateCreate', params, isGateCreateResult)
    output(context, result, `Gate ${result.gate.id} created for task ${result.task.id} [${result.gate.status}]`)
  },

  'gate-resolve': async (args, context) => {
    const params: ObjectValue = {
      gateId: stringFlag(args, context, 'id'),
      resolution: stringFlag(args, context, 'resolution')
    }
    addCallerAliases(params, args, context)
    addMutationReceipt(params, context)
    const result = await call(context, args, 'gate-resolve', 'gateResolve', params, isGateResolveResult)
    output(context, result, `Gate ${result.gate.id} resolved: ${result.gate.resolution ?? ''}`)
  },

  'gate-list': async (args, context) => {
    const params: ObjectValue = {}
    addCallerAliases(params, args, context)
    const runId = stringFlag(args, context, 'run', false)
    const taskId = stringFlag(args, context, 'task', false)
    const status = stringFlag(args, context, 'status', false)
    if (runId !== undefined) params.runId = runId
    if (taskId !== undefined) params.taskId = taskId
    if (status !== undefined) params.status = status
    const result = await call(context, args, 'gate-list', 'gateList', params, isGateListResult)
    const rows = result.gates.map((gate) => `${gate.id} task=${gate.taskId} [${gate.status}] "${gate.question}"`)
    output(context, result, rows.length === 0 ? `No gates found in Run ${result.runId}.` : rows.join('\n'))
  },

  'request-show': async (args, context) => {
    const requestId = stringFlag(args, context, 'request')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      throw context.usage('--request must be a UUID')
    }
    const result = await call(context, args, 'request-show', 'requestShow', { requestId }, isRequestShowResult)
    const text = result.state === 'absent'
      ? `No receipt for ${result.requestId}. Absence does not prove that no effect occurred.`
      : `Request ${result.requestId} is ${result.state}: ${result.interpretation}`
    output(context, result, text)
  },

  reset: async (args, context) => {
    const modes = ['all', 'tasks', 'messages'].filter((name) => booleanFlag(args, context, name))
    if (modes.length !== 1) throw context.usage('Choose exactly one of --all, --tasks, or --messages')
    const params: ObjectValue = { mode: modes[0] }
    addCallerAliases(params, args, context)
    addMutationReceipt(params, context)
    const result = await call(context, args, 'reset', 'reset', params, isResetResult)
    output(context, result, `Reset orchestration ${result.mode} data.`)
  }
}
