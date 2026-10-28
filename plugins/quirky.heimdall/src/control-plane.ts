import { validateValue, type Schema } from '@quirky/protocol'
import type { ApprovalScope, BudgetPolicy, Enrollment, Inspection, JournalAppend, JournalEntry, Json, KernelStore } from './contracts'
import type { CommandRefusal, CommandResult, ControlPlane, KernelControlHost, OwnerFence, WatcherCommand, WatcherTarget, WatcherWorker, WorkerIdentity } from './control-contracts'

interface ParsedRequest {
  target: WatcherTarget
  expectedOwner: OwnerFence
  command: WatcherCommand
}

interface Completion {
  result: CommandResult
  changed: boolean
  reconcile: boolean
}

interface PendingControl {
  token: number
  command: string
}

const REFUSAL_DETAILS = {
  invalidRequest: 'Malformed control request.',
  unavailable: 'The owning kernel control barrier is unavailable.',
  missing: 'The watcher no longer exists.',
  readOnly: 'The watcher store is read-only.',
  terminal: 'A terminal watcher cannot be controlled.',
  exhausted: 'Raise the exhausted watcher budget before resuming.',
  pendingQuestion: 'Answer the pending worker question before resuming.',
  pendingEscalation: 'Answer the pending worker escalation before resuming.',
  pendingOwnerEscalation: 'Answer the pending owner escalation before resuming.',
} as const

const APPROVAL_SCOPE_SCHEMA: Schema = {
  type: 'object',
  required: ['actionKind', 'contentIdentity', 'evidenceKey'],
  properties: {
    actionKind: { type: 'string' },
    contentIdentity: { type: 'string' },
    evidenceKey: { type: 'string' },
    preparedCommitSha: { type: 'string' },
  },
  additionalProperties: false,
}

const BUDGET_SCHEMA: Schema = {
  type: 'object',
  required: ['wallClockActiveMs', 'turns'],
  properties: { wallClockActiveMs: {}, turns: {} },
  additionalProperties: false,
}

const WORKER_IDENTITY_SCHEMA: Schema = {
  type: 'object',
  required: ['dispatchId'],
  properties: {
    dispatchId: { type: 'string' },
    sessionId: { type: 'string' },
    processIncarnation: { type: 'string' },
    pid: { type: 'integer', minimum: 1 },
    startTime: { type: 'string' },
    terminalHandle: { type: 'string' },
  },
  additionalProperties: false,
}

const TARGET_SCHEMA: Schema = {
  type: 'object',
  required: ['watcherId'],
  properties: { watcherId: { type: 'string' }, connectionId: {}, pairingRevision: {} },
  additionalProperties: false,
}

const OWNER_FENCE_SCHEMA: Schema = {
  type: 'object',
  required: ['executionHostId', 'schedulerOwner', 'workspaceKey', 'revision'],
  properties: {
    executionHostId: { type: 'string' },
    schedulerOwner: { type: 'string' },
    workspaceKey: { type: 'string' },
    revision: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
}

const COMMAND_SCHEMAS: Record<string, Schema> = {
  pause: commandSchema('pause'),
  resume: commandSchema('resume'),
  disarm: commandSchema('disarm'),
  delete: commandSchema('delete'),
  approve: commandSchema('approve', { escalationId: { type: 'string' }, scope: APPROVAL_SCOPE_SCHEMA }),
  'adjust-budget': commandSchema('adjust-budget', { budget: BUDGET_SCHEMA }),
  'set-concurrency': commandSchema('set-concurrency', { maxConcurrency: { type: 'integer', minimum: 1, maximum: 1024 } }),
  'answer-question': commandSchema('answer-question', { messageId: { type: 'string' }, body: { type: 'string' } }),
  'answer-escalation': commandSchema('answer-escalation', { escalationId: { type: 'string' }, body: { type: 'string' } }),
  'stop-worker': commandSchema('stop-worker', { identity: WORKER_IDENTITY_SCHEMA }),
}

const REQUEST_SCHEMAS: Record<string, Schema> = {}
for (const [kind, command] of Object.entries(COMMAND_SCHEMAS)) {
  REQUEST_SCHEMAS[kind] = {
    type: 'object',
    required: ['target', 'expectedOwner', 'command'],
    properties: { target: TARGET_SCHEMA, expectedOwner: OWNER_FENCE_SCHEMA, command },
    additionalProperties: false,
  }
}

function commandSchema(kind: string, fields: Record<string, Schema> = {}): Schema {
  return {
    type: 'object',
    required: ['kind', ...Object.keys(fields)],
    properties: { kind: { type: 'string', enum: [kind] }, ...fields },
    additionalProperties: false,
  }
}

export function createControlPlane(host: KernelControlHost): ControlPlane {
  const tails = new Map<string, Promise<void>>()
  const pendingByWatcher = new Map<string, PendingControl[]>()
  let nextToken = 0

  function pending(watcherId: string): string[] {
    return (pendingByWatcher.get(watcherId) ?? []).map(control => control.command)
  }

  function command(input: unknown): Promise<CommandResult> {
    const parsed = parseRequest(input)
    if (!parsed) return Promise.resolve(refused('invalid-command', REFUSAL_DETAILS.invalidRequest))
    if (isRemoteTarget(parsed.target)) {
      return Promise.resolve(refused('owner-unreachable', 'Remote watcher targets are not controlled by this local kernel.'))
    }
    if (typeof host.withControl !== 'function') {
      return Promise.resolve(refused('owner-unreachable', REFUSAL_DETAILS.unavailable))
    }

    const watcherId = parsed.target.watcherId
    const token = ++nextToken
    const controls = pendingByWatcher.get(watcherId) ?? []
    controls.push({ token, command: parsed.command.kind })
    pendingByWatcher.set(watcherId, controls)

    const previous = tails.get(watcherId) ?? Promise.resolve()
    const result = previous.then(() => execute(parsed)).catch(error => indeterminate(errorDetail(error)))
    const tail = result.then(() => undefined, () => undefined)
    tails.set(watcherId, tail)
    return result.finally(() => {
      const current = pendingByWatcher.get(watcherId)
      if (current) {
        const remaining = current.filter(control => control.token !== token)
        if (remaining.length === 0) pendingByWatcher.delete(watcherId)
        else pendingByWatcher.set(watcherId, remaining)
      }
      if (tails.get(watcherId) === tail) tails.delete(watcherId)
    })
  }

  async function execute(request: ParsedRequest): Promise<CommandResult> {
    const watcherId = request.target.watcherId
    const drain = commandNeedsDrain(request.command, host.store.get(watcherId))
    let operationEntered = false
    let completion: Completion
    try {
      completion = await host.withControl(watcherId, drain, async () => {
        operationEntered = true
        return applyInsideBarrier(request)
      })
    } catch (error) {
      if (!operationEntered) return refused('owner-unreachable', errorDetail(error))
      return indeterminate(errorDetail(error))
    }

    if (completion.result.kind !== 'applied') return completion.result
    if (completion.changed) host.changed(watcherId)
    if (completion.reconcile) await host.reconcile(watcherId)
    return completion.result
  }

  async function applyInsideBarrier(request: ParsedRequest): Promise<Completion> {
    const watcherId = request.target.watcherId
    const enrollment = host.store.get(watcherId)
    if (!enrollment) return complete(refused('watcher-not-found', REFUSAL_DETAILS.missing))
    if (enrollment.watcherId !== watcherId) return complete(refused('owner-conflict', 'The store returned a different watcher identity.'))
    if (!Number.isSafeInteger(enrollment.commandRevision) || enrollment.commandRevision < 0) {
      return complete(refused('invalid-command', 'The persisted command revision is invalid.'))
    }
    const fenceResult = checkFence(enrollment, request.expectedOwner)
    if (fenceResult) return complete(fenceResult)

    if (host.store.readOnly) return complete(refused('invalid-command', REFUSAL_DETAILS.readOnly))
    let inspection: Inspection | null
    try {
      inspection = await host.inspect(watcherId)
    } catch (error) {
      return complete(refused('owner-unreachable', errorDetail(error)))
    }
    if (!inspection) return complete(refused('watcher-not-found', REFUSAL_DETAILS.missing))
    if (inspection.readOnly) return complete(refused('invalid-command', REFUSAL_DETAILS.readOnly))
    if (enrollment.malformed || inspection.status?.state === 'malformed') {
      const detail = enrollment.malformed
        ? `The watcher enrollment is malformed: ${enrollment.malformed}`
        : 'The watcher enrollment is malformed and cannot be controlled.'
      return complete(refused('invalid-command', detail))
    }

    const command = request.command
    if (command.kind === 'delete') {
      await host.remove(watcherId)
      return applied(now(host), true, false)
    }
    if (command.kind === 'pause') return pause(host, enrollment, inspection)
    if (command.kind === 'resume') return resume(host, enrollment, inspection)
    if (command.kind === 'disarm') return disarm(host, enrollment, inspection)
    if (command.kind === 'approve') return approve(host, enrollment, command.escalationId, command.scope)
    if (command.kind === 'adjust-budget') return adjustBudget(host, enrollment, command.budget)
    if (command.kind === 'set-concurrency') return setConcurrency(host, enrollment, command.maxConcurrency)
    if (command.kind === 'answer-question') return answerQuestion(host, enrollment, command.messageId, command.body)
    if (command.kind === 'answer-escalation') return answerEscalation(host, enrollment, command.escalationId, command.body)
    return stopWorker(host, enrollment, command.identity)
  }

  return { command, pending }
}

function pause(host: KernelControlHost, enrollment: Enrollment, inspection: Inspection): Completion {
  if (isTerminal(enrollment, inspection)) return complete(refused('invalid-state', REFUSAL_DETAILS.terminal))
  if (!enrollment.enabled || enrollment.paused) return complete(refused('invalid-state', 'Only an enabled, unpaused watcher can be paused.'))
  persistMutation(host.store, enrollment, { paused: true }, [evidence('operator-pause')])
  return applied(now(host), true, false)
}

async function resume(host: KernelControlHost, enrollment: Enrollment, inspection: Inspection): Promise<Completion> {
  if (isTerminal(enrollment, inspection)) return complete(refused('invalid-state', REFUSAL_DETAILS.terminal))
  const parkReason: string | null = enrollment.parkReason
  if (parkReason === 'owner-escalation') return complete(refused('invalid-state', REFUSAL_DETAILS.pendingOwnerEscalation))
  if (!enrollment.paused && !(enrollment.parkReason !== null && !enrollment.enabled)) {
    const detail = !enrollment.enabled && enrollment.parkReason === null
      ? 'An explicitly disarmed watcher cannot be resumed; re-enroll it to arm again.'
      : 'Only a paused or automatically parked watcher can be resumed.'
    return complete(refused('invalid-state', detail))
  }
  if (!enrollment.enabled && enrollment.parkReason === null) {
    return complete(refused('invalid-state', 'An explicitly disarmed watcher cannot be resumed; re-enroll it to arm again.'))
  }
  if (budgetExhausted(enrollment, inspection)) return complete(refused('invalid-state', REFUSAL_DETAILS.exhausted))

  let workers: WatcherWorker[]
  try {
    workers = await host.workers(enrollment)
  } catch (error) {
    return complete(refused('owner-unreachable', errorDetail(error)))
  }
  if (workers.some(worker => worker.question && worker.question.answered !== true)) {
    return complete(refused('invalid-state', REFUSAL_DETAILS.pendingQuestion))
  }
  if (parkReason === 'worker-escalation' && hasOpenWorkerEscalation(host.store.journal(enrollment.watcherId))) {
    return complete(refused('invalid-state', REFUSAL_DETAILS.pendingEscalation))
  }

  persistMutation(host.store, enrollment, { enabled: true, paused: false, parkReason: null, haltReason: null }, [evidence('operator-resume')])
  return applied(now(host), true, true)
}

function disarm(host: KernelControlHost, enrollment: Enrollment, inspection: Inspection): Completion {
  if (isTerminal(enrollment, inspection)) return complete(refused('invalid-state', REFUSAL_DETAILS.terminal))
  if (!enrollment.enabled && !enrollment.paused && enrollment.parkReason === null) {
    return complete(refused('invalid-state', 'The watcher is already explicitly disarmed.'))
  }
  const revisions = [...latestEscalations(host.store.journal(enrollment.watcherId)).values()]
    .filter(isOpenEscalation)
    .map(entry => escalationRevision(entry, 'acknowledged'))
  persistMutation(host.store, enrollment, {
    enabled: false,
    paused: false,
    parkReason: null,
    haltReason: 'operator-disarmed',
  }, [evidence('operator-disarm'), ...revisions])
  return applied(now(host), true, false)
}

function approve(host: KernelControlHost, enrollment: Enrollment, escalationId: string, scope: ApprovalScope): Completion {
  const latest = latestEscalations(host.store.journal(enrollment.watcherId)).get(escalationId)
  if (!latest || !isOpenEscalation(latest)) return complete(refused('invalid-state', 'The requested escalation is not open.'))
  const currentScope = parseApprovalScope(latest.approvalScope)
  if (!currentScope || !sameApprovalScope(currentScope, scope)) {
    return complete(refused('invalid-state', 'The approval scope changed; inspect the current escalation before approving.'))
  }
  persistMutation(host.store, enrollment, {}, [
    {
      kind: 'approval', class: 'fact', origin: 'owner', resolved: false,
      status: 'approved', scope: approvalScopeJson(scope),
    },
    escalationRevision(latest, 'acknowledged'),
  ])
  return applied(now(host), true, true)
}

function adjustBudget(host: KernelControlHost, enrollment: Enrollment, budget: BudgetPolicy): Completion {
  persistMutation(host.store, enrollment, { budget }, [evidence('budget-policy-adjusted', { budget: budgetJson(budget) })])
  return applied(now(host), true, true)
}

function setConcurrency(host: KernelControlHost, enrollment: Enrollment, maxConcurrency: number): Completion {
  if (enrollment.kind !== 'objective') return complete(refused('unsupported-capability', 'Concurrency can only be changed for objective watchers.'))
  if (enrollment.repoId === null || enrollment.repoId === undefined) {
    if (maxConcurrency !== 1) return complete(refused('unsupported-capability', 'Folder workspaces support a concurrency cap of one.'))
  }
  const payload = enrollment.kindPayload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return complete(refused('invalid-command', 'The objective concurrency payload is malformed.'))
  }
  persistMutation(host.store, enrollment, { kindPayload: { ...payload, maxConcurrency } }, [evidence('objective-concurrency-changed', { maxConcurrency })])
  return applied(now(host), true, true)
}

async function answerQuestion(host: KernelControlHost, enrollment: Enrollment, messageId: string, body: string): Promise<Completion> {
  const result = await host.answerQuestion(enrollment, messageId, body)
  if (result.kind !== 'applied') return complete(result)
  const revisions = [...latestEscalations(host.store.journal(enrollment.watcherId)).values()]
    .filter(entry => isOpenEscalation(entry) && isQuestionEscalationFor(entry, messageId))
    .map(entry => escalationRevision(entry, 'resolved', { humanReply: body }))
  const patch = enrollment.parkReason === 'worker-question'
    ? { enabled: true, parkReason: null, haltReason: null }
    : {}
  persistMutation(host.store, enrollment, patch, [
    evidence('worker-question-answered', { messageId, body }),
    ...revisions,
  ])
  return applied(result.appliedAtMs, true, true)
}

async function answerEscalation(host: KernelControlHost, enrollment: Enrollment, escalationId: string, body: string): Promise<Completion> {
  const latest = latestEscalations(host.store.journal(enrollment.watcherId)).get(escalationId)
  if (!latest || !isOpenEscalation(latest)) return complete(refused('invalid-state', 'The requested escalation is not open.'))
  const parkReason: string | null = enrollment.parkReason
  const supportedKinds = parkReason === 'worker-escalation'
    ? ['worker-escalation', 'park-worker-escalation']
    : parkReason === 'owner-escalation'
      ? ['owner-escalation', 'park-owner-escalation']
      : null
  if (!supportedKinds || typeof latest.escalationKind !== 'string' || !supportedKinds.includes(latest.escalationKind)) {
    return complete(refused('invalid-state', 'Only the exact pending owner or worker escalation can be answered.'))
  }
  const result = await host.answerEscalation(enrollment, escalationId, body)
  if (result.kind !== 'applied') return complete(result)
  const patch = parkReason === 'worker-escalation' || parkReason === 'owner-escalation'
    ? { enabled: true, paused: false, parkReason: null, haltReason: null }
    : {}
  persistMutation(host.store, enrollment, patch, [escalationRevision(latest, 'resolved', { humanReply: body })])
  return applied(result.appliedAtMs, true, true)
}

async function stopWorker(host: KernelControlHost, enrollment: Enrollment, identity: WorkerIdentity): Promise<Completion> {
  if (!identity.sessionId || !identity.processIncarnation) {
    return complete(refused('worker-unverifiable', 'Stopping a worker requires its exact session and process incarnation.'))
  }
  let workers: WatcherWorker[]
  try {
    workers = await host.workers(enrollment)
  } catch (error) {
    return complete(refused('owner-unreachable', errorDetail(error)))
  }
  const worker = workers.find(candidate => sameIdentity(candidate.identity, identity))
  if (!worker || worker.state === 'unverifiable') {
    return complete(refused('worker-unverifiable', 'The exact worker process identity cannot be verified.'))
  }
  if (worker.state !== 'live') return complete(refused('invalid-state', 'The exact worker is not live.'))

  const result = await host.stopWorker(enrollment, identity)
  if (result.kind !== 'applied') return complete(result)
  persistMutation(host.store, enrollment, {}, [evidence('worker-stop-requested', { identity: identityJson(identity) })])
  return applied(result.appliedAtMs, true, true)
}

function parseRequest(value: unknown): ParsedRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('command' in value)) return null
  const commandValue = value.command
  if (typeof commandValue !== 'object' || commandValue === null || Array.isArray(commandValue)
    || !('kind' in commandValue) || typeof commandValue.kind !== 'string') return null
  const schema = Object.hasOwn(REQUEST_SCHEMAS, commandValue.kind) ? REQUEST_SCHEMAS[commandValue.kind] : undefined
  if (!schema || validateValue(schema, value, 'command')) return null
  if (!('target' in value) || !('expectedOwner' in value)) return null
  const target = parseTarget(value.target)
  const expectedOwner = parseOwnerFence(value.expectedOwner)
  const command = parseCommand(commandValue)
  if (!target || !expectedOwner || !command) return null
  return { target, expectedOwner, command }
}

function parseTarget(value: unknown): WatcherTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('watcherId' in value) || !nonEmptyString(value.watcherId)) return null
  const target: WatcherTarget = { watcherId: value.watcherId }
  if ('connectionId' in value) {
    if (value.connectionId !== undefined && value.connectionId !== null && typeof value.connectionId !== 'string') return null
    if (value.connectionId === null || typeof value.connectionId === 'string') target.connectionId = value.connectionId
  }
  if ('pairingRevision' in value) {
    if (value.pairingRevision !== undefined && value.pairingRevision !== null
      && (typeof value.pairingRevision !== 'number' || !Number.isSafeInteger(value.pairingRevision) || value.pairingRevision < 0)) return null
    if (value.pairingRevision === null || typeof value.pairingRevision === 'number') target.pairingRevision = value.pairingRevision
  }
  return target
}

function parseOwnerFence(value: unknown): OwnerFence | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('executionHostId' in value) || !('schedulerOwner' in value) || !('workspaceKey' in value) || !('revision' in value)
    || !nonEmptyString(value.executionHostId) || !nonEmptyString(value.schedulerOwner) || !nonEmptyString(value.workspaceKey)
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) return null
  return {
    executionHostId: value.executionHostId,
    schedulerOwner: value.schedulerOwner,
    workspaceKey: value.workspaceKey,
    revision: value.revision,
  }
}

function parseCommand(value: unknown): WatcherCommand | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('kind' in value) || typeof value.kind !== 'string') return null
  if (value.kind === 'pause' || value.kind === 'resume' || value.kind === 'disarm' || value.kind === 'delete') {
    return { kind: value.kind }
  }
  if (value.kind === 'approve') {
    if (!('escalationId' in value) || !nonEmptyString(value.escalationId) || !('scope' in value)) return null
    const scope = approvalScopeFromValidated(value.scope)
    return scope ? { kind: 'approve', escalationId: value.escalationId, scope } : null
  }
  if (value.kind === 'adjust-budget') {
    if (!('budget' in value)) return null
    const budget = parseBudget(value.budget)
    return budget ? { kind: 'adjust-budget', budget } : null
  }
  if (value.kind === 'set-concurrency') {
    if (!('maxConcurrency' in value) || typeof value.maxConcurrency !== 'number'
      || !Number.isInteger(value.maxConcurrency) || value.maxConcurrency < 1 || value.maxConcurrency > 1024) return null
    return { kind: 'set-concurrency', maxConcurrency: value.maxConcurrency }
  }
  if (value.kind === 'answer-question') {
    if (!('messageId' in value) || !nonEmptyString(value.messageId) || !('body' in value) || !nonEmptyString(value.body)) return null
    return { kind: 'answer-question', messageId: value.messageId, body: value.body }
  }
  if (value.kind === 'answer-escalation') {
    if (!('escalationId' in value) || !nonEmptyString(value.escalationId) || !('body' in value) || !nonEmptyString(value.body)) return null
    return { kind: 'answer-escalation', escalationId: value.escalationId, body: value.body }
  }
  if (value.kind === 'stop-worker') {
    if (!('identity' in value)) return null
    const identity = parseWorkerIdentity(value.identity)
    return identity ? { kind: 'stop-worker', identity } : null
  }
  return null
}

function parseBudget(value: unknown): BudgetPolicy | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('wallClockActiveMs' in value) || !('turns' in value)) return null
  const wallClockActiveMs = value.wallClockActiveMs
  const turns = value.turns
  if (!(wallClockActiveMs === null || typeof wallClockActiveMs === 'number' && Number.isFinite(wallClockActiveMs) && wallClockActiveMs >= 0)) return null
  if (!(turns === null || typeof turns === 'number' && Number.isSafeInteger(turns) && turns >= 0)) return null
  return { wallClockActiveMs, turns }
}

function parseApprovalScope(value: unknown): ApprovalScope | null {
  if (validateValue(APPROVAL_SCOPE_SCHEMA, value, 'approvalScope')) return null
  return approvalScopeFromValidated(value)
}

function approvalScopeFromValidated(value: unknown): ApprovalScope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('actionKind' in value) || !('contentIdentity' in value) || !('evidenceKey' in value)
    || !nonEmptyString(value.actionKind) || !nonEmptyString(value.contentIdentity) || !nonEmptyString(value.evidenceKey)) return null
  const scope: ApprovalScope = {
    actionKind: value.actionKind,
    contentIdentity: value.contentIdentity,
    evidenceKey: value.evidenceKey,
  }
  if ('preparedCommitSha' in value) {
    if (value.preparedCommitSha !== undefined && !nonEmptyString(value.preparedCommitSha)) return null
    if (typeof value.preparedCommitSha === 'string') scope.preparedCommitSha = value.preparedCommitSha
  }
  return scope
}

function parseWorkerIdentity(value: unknown): WorkerIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('dispatchId' in value) || !nonEmptyString(value.dispatchId)) return null
  const identity: WorkerIdentity = { dispatchId: value.dispatchId }
  if ('sessionId' in value) {
    if (value.sessionId !== undefined && typeof value.sessionId !== 'string') return null
    if (typeof value.sessionId === 'string') identity.sessionId = value.sessionId
  }
  if ('processIncarnation' in value) {
    if (value.processIncarnation !== undefined && typeof value.processIncarnation !== 'string') return null
    if (typeof value.processIncarnation === 'string') identity.processIncarnation = value.processIncarnation
  }
  if ('pid' in value) {
    if (value.pid !== undefined && (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0)) return null
    if (typeof value.pid === 'number') identity.pid = value.pid
  }
  if ('startTime' in value) {
    if (value.startTime !== undefined && typeof value.startTime !== 'string') return null
    if (typeof value.startTime === 'string') identity.startTime = value.startTime
  }
  if ('terminalHandle' in value) {
    if (value.terminalHandle !== undefined && typeof value.terminalHandle !== 'string') return null
    if (typeof value.terminalHandle === 'string') identity.terminalHandle = value.terminalHandle
  }
  return identity
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRemoteTarget(target: WatcherTarget): boolean {
  return target.connectionId !== undefined && target.connectionId !== null
    || target.pairingRevision !== undefined && target.pairingRevision !== null
}

function commandNeedsDrain(command: WatcherCommand, enrollment: Enrollment | null): boolean {
  if (command.kind === 'pause' || command.kind === 'disarm' || command.kind === 'delete') return true
  if (command.kind !== 'set-concurrency' || !enrollment || enrollment.kind !== 'objective') return false
  const payload = enrollment.kindPayload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return true
  const current = payload.maxConcurrency
  return typeof current !== 'number' || command.maxConcurrency < current
}

function checkFence(enrollment: Enrollment, expected: OwnerFence): CommandResult | null {
  if (enrollment.executionHostId !== expected.executionHostId
    || enrollment.schedulerOwner !== expected.schedulerOwner
    || enrollment.workspaceKey !== expected.workspaceKey) {
    return refused('owner-conflict', 'The watcher is now owned by a different execution host, scheduler, or workspace.')
  }
  if (enrollment.commandRevision !== expected.revision) {
    return refused('stale-revision', `Expected command revision ${expected.revision}; current revision is ${enrollment.commandRevision}.`)
  }
  return null
}

function isTerminal(enrollment: Enrollment, inspection: Inspection): boolean {
  return enrollment.terminalAtMs !== null || inspection.status?.state === 'terminal'
}

function budgetExhausted(enrollment: Enrollment, inspection: Inspection): boolean {
  return inspection.budget.exhausted !== null
    || enrollment.budget.wallClockActiveMs !== null && inspection.budget.activeMs >= enrollment.budget.wallClockActiveMs
    || enrollment.budget.turns !== null && inspection.budget.turns >= enrollment.budget.turns
}

function hasOpenWorkerEscalation(entries: JournalEntry[]): boolean {
  return [...latestEscalations(entries).values()].some(entry =>
    isOpenEscalation(entry) && (entry.escalationKind === 'worker-escalation' || entry.escalationKind === 'park-worker-escalation'))
}

function isQuestionEscalationFor(entry: JournalEntry, messageId: string): boolean {
  if (entry.escalationKind !== 'worker-question') return false
  return entry.messageId === messageId
    || entry.questionId === messageId
    || entry.escalationId === `worker-question:${messageId}`
    || entry.escalationId === `park-worker-question:${messageId}`
}

function latestEscalations(entries: JournalEntry[]): Map<string, JournalEntry> {
  const latest = new Map<string, JournalEntry>()
  for (const entry of entries) {
    if (entry.kind !== 'escalation' || typeof entry.escalationId !== 'string') continue
    const previous = latest.get(entry.escalationId)
    if (!previous || entry.seq >= previous.seq) latest.set(entry.escalationId, entry)
  }
  return latest
}

function isOpenEscalation(entry: JournalEntry): boolean {
  return entry.status === 'open' || entry.status === 'escalated'
}

function escalationRevision(entry: JournalEntry, status: 'acknowledged' | 'resolved', extra: Record<string, unknown> = {}): JournalAppend {
  const { seq: _seq, eventId: _eventId, watcherId: _watcherId, atMs: _atMs, ...fields } = entry
  return {
    ...fields,
    ...extra,
    kind: 'escalation',
    class: 'fact',
    origin: 'owner',
    resolved: true,
    status,
  }
}

function sameApprovalScope(left: ApprovalScope, right: ApprovalScope): boolean {
  return left.actionKind === right.actionKind
    && left.contentIdentity === right.contentIdentity
    && left.evidenceKey === right.evidenceKey
    && left.preparedCommitSha === right.preparedCommitSha
}

function approvalScopeJson(scope: ApprovalScope): Json {
  const value: { [key: string]: Json } = {
    actionKind: scope.actionKind,
    contentIdentity: scope.contentIdentity,
    evidenceKey: scope.evidenceKey,
  }
  if (scope.preparedCommitSha !== undefined) value.preparedCommitSha = scope.preparedCommitSha
  return value
}

function budgetJson(budget: BudgetPolicy): Json {
  return { wallClockActiveMs: budget.wallClockActiveMs, turns: budget.turns }
}

function identityJson(identity: WorkerIdentity): Json {
  const value: { [key: string]: Json } = { dispatchId: identity.dispatchId }
  if (identity.sessionId !== undefined) value.sessionId = identity.sessionId
  if (identity.processIncarnation !== undefined) value.processIncarnation = identity.processIncarnation
  if (identity.pid !== undefined) value.pid = identity.pid
  if (identity.startTime !== undefined) value.startTime = identity.startTime
  if (identity.terminalHandle !== undefined) value.terminalHandle = identity.terminalHandle
  return value
}

function sameIdentity(left: WorkerIdentity, right: WorkerIdentity): boolean {
  return left.dispatchId === right.dispatchId
    && left.sessionId === right.sessionId
    && left.processIncarnation === right.processIncarnation
    && left.pid === right.pid
    && left.startTime === right.startTime
    && left.terminalHandle === right.terminalHandle
}

function evidence(evidenceKind: string, payload: Json = {}): JournalAppend {
  return { kind: 'evidence', class: 'fact', origin: 'owner', resolved: false, evidenceKind, payload }
}

function persistMutation(store: KernelStore, enrollment: Enrollment, patch: Partial<Enrollment>, entries: JournalAppend[]): void {
  if (enrollment.commandRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Watcher command revision cannot be incremented safely.')
  const next = { ...enrollment, ...patch, commandRevision: enrollment.commandRevision + 1 }
  store.transaction(() => {
    store.save(next)
    for (const entry of entries) store.append(enrollment.watcherId, entry)
  })
}

function now(host: KernelControlHost): number {
  const value = host.now?.() ?? Date.now()
  if (!Number.isFinite(value)) throw new Error('Kernel clock returned an invalid timestamp.')
  return value
}

function refused(reason: CommandRefusal, detail: string): CommandResult {
  return { kind: 'refused', reason, detail }
}

function applied(appliedAtMs: number, changed: boolean, reconcile: boolean): Completion {
  return complete({ kind: 'applied', appliedAtMs }, changed, reconcile)
}

function complete(result: CommandResult, changed = false, reconcile = false): Completion {
  return { result, changed, reconcile }
}

function indeterminate(detail: string): CommandResult {
  return { kind: 'indeterminate', detail }
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return `Command outcome is indeterminate: ${error.message}`
  return 'Command outcome is indeterminate because the kernel operation failed without a confirmed result.'
}
