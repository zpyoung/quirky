import { flagNameOf, type Schema } from '@quirky/protocol'
import type {
  CommandRequest,
  CommandResult,
  ControlPlane,
  FleetAction,
  FleetService,
  KernelControlHost,
  OwnerFence,
  WatcherCommand,
  WatcherDetail,
  WatcherTarget
} from './control-contracts'
import { parseControlRequest } from './control-plane'

const text = (description?: string): Schema => ({ type: 'string', ...(description === undefined ? {} : { description }) })
const integer = (description?: string): Schema => ({ type: 'integer', ...(description === undefined ? {} : { description }) })
const boolean = (description?: string): Schema => ({ type: 'boolean', ...(description === undefined ? {} : { description }) })
const any = (description?: string): Schema => description === undefined ? {} : { description }
const array = (items: Schema, description?: string): Schema => ({
  type: 'array',
  items,
  ...(description === undefined ? {} : { description })
})
const object = (properties: Record<string, Schema>, required: string[] = [], additionalProperties = false, description?: string): Schema => ({
  type: 'object',
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties,
  ...(description === undefined ? {} : { description })
})

const budgetPolicySchema = object({
  wallClockActiveMs: any('A non-negative active-time limit in milliseconds, or null for unlimited.'),
  turns: any('A non-negative worker-turn limit, or null for unlimited.')
}, ['wallClockActiveMs', 'turns'])

const ownerConfigSchema: Schema = {
  description: 'Claude owner configuration, or null for no owner.',
  properties: { agent: { type: 'string', enum: ['claude'] }, model: text(), effort: text() },
  required: ['agent'],
  additionalProperties: false
}

const budgetUsageSchema = object({
  activeMs: integer(),
  turns: integer(),
  exhausted: any('The exhausted limit, or null when the budget remains available.')
}, ['activeMs', 'turns', 'exhausted'])

const ownerFenceSchema = object({
  executionHostId: text(),
  schedulerOwner: text(),
  workspaceKey: text(),
  revision: integer()
}, ['executionHostId', 'schedulerOwner', 'workspaceKey', 'revision'])

const targetSchema = object({
  watcherId: text(),
  connectionId: any('Remote connection ID; omitted or null for this local kernel.'),
  pairingRevision: any('Remote pairing revision; omitted or null for this local kernel.')
}, ['watcherId'])

const approvalScopeSchema = object({
  actionKind: text(),
  contentIdentity: text(),
  evidenceKey: text(),
  preparedCommitSha: text()
}, ['actionKind', 'contentIdentity', 'evidenceKey'])

const workerIdentitySchema = object({
  dispatchId: text(),
  sessionId: text(),
  processIncarnation: text(),
  pid: integer(),
  startTime: text(),
  terminalHandle: text()
}, ['dispatchId'])

const workerSchema = object({
  identity: workerIdentitySchema,
  state: { type: 'string', enum: ['live', 'exited', 'unverifiable'] },
  assignmentActive: boolean(),
  title: text(),
  lastContactAtMs: integer(),
  question: object({ messageId: text(), body: text(), answered: boolean() }, ['messageId', 'body'])
}, ['identity', 'state', 'assignmentActive'], true)

const escalationSchema = object({
  escalationId: text(),
  escalationKind: text(),
  status: text(),
  foldCount: integer(),
  reason: text(),
  detail: text(),
  approvalScope: approvalScopeSchema
}, ['escalationId', 'escalationKind', 'status', 'foldCount'], true)

const enrollmentSchema = object({
  watcherId: text(),
  kind: text(),
  workspaceKey: text(),
  workspacePath: text(),
  executionHostId: text(),
  schedulerOwner: text(),
  repoId: any('Repository ID, when this workspace belongs to a repository.'),
  worktreeId: any('Worktree ID, or null for a folder workspace.'),
  kindPayload: any('Payload authorized by the registered watcher kind.'),
  owner: ownerConfigSchema,
  ownerInterventionCapability: { type: 'string', enum: ['off', 'gated', 'on'] },
  undo: any('Kind authorization rollback data, when present.'),
  enabled: boolean(),
  paused: boolean(),
  commandRevision: integer(),
  capabilities: object({}, [], true),
  budget: budgetPolicySchema,
  coordinator: object({ handle: text(), paneKey: text() }, ['handle', 'paneKey']),
  orchestrationRunId: any('Orchestration run ID, or null before a run exists.'),
  createdAtMs: integer(),
  terminalAtMs: any('Terminal timestamp, or null while active.'),
  parkReason: any('Automatic park reason, or null.'),
  haltReason: any('Last halt reason, or null.'),
  malformed: text()
}, [
  'watcherId', 'kind', 'workspaceKey', 'workspacePath', 'executionHostId', 'schedulerOwner',
  'kindPayload', 'enabled', 'paused', 'commandRevision', 'capabilities', 'budget', 'coordinator',
  'orchestrationRunId', 'createdAtMs', 'terminalAtMs', 'parkReason', 'haltReason'
], true)

const runnerStatusSchema = object({
  state: { type: 'string', enum: ['watching', 'acting', 'held', 'escalated', 'parked', 'terminal', 'disabled', 'unreachable', 'malformed'] },
  reason: text(),
  detail: text(),
  nextPulseAtMs: any('Next pulse time, or null when no timer is scheduled.'),
  consecutiveErrors: integer(),
  consecutiveGateHolds: integer()
}, ['state', 'nextPulseAtMs', 'consecutiveErrors', 'consecutiveGateHolds'])

const journalEntrySchema = object({
  seq: integer(),
  eventId: text(),
  watcherId: text(),
  atMs: integer(),
  class: { type: 'string', enum: ['fact', 'observation'] },
  origin: { type: 'string', enum: ['owner', 'client'] },
  kind: text(),
  resolved: boolean()
}, ['seq', 'eventId', 'watcherId', 'atMs', 'class', 'origin', 'kind', 'resolved'], true)

const traceSchema = object({
  seq: integer(),
  watcherId: text(),
  startedAtMs: integer(),
  durationMs: integer(),
  exitPath: text(),
  pinned: boolean(),
  fullResyncDue: boolean(),
  snapshotReadCount: integer(),
  snapshot: any(),
  contentIdentity: text(),
  decision: any(),
  declined: array(text()),
  gate: any(),
  budget: any(),
  pacing: any(),
  error: text(),
  runner: runnerStatusSchema
}, ['seq', 'watcherId', 'startedAtMs', 'durationMs', 'exitPath', 'pinned', 'fullResyncDue', 'snapshotReadCount', 'declined'], true)


const inspectionProperties: Record<string, Schema> = {
  readOnly: boolean(),
  enrollment: enrollmentSchema,
  status: any('Live runner status, or null when no runner is present.'),
  journal: array(journalEntrySchema, 'At most the newest 200 entries.'),
  traces: array(traceSchema, 'At most the newest 20 traces.'),
  summary: any('Terminal summary, or null while the watcher is active.'),
  budget: budgetUsageSchema
}

const fleetRowSchema = object({
  target: targetSchema,
  ownerFence: ownerFenceSchema,
  enrollment: enrollmentSchema,
  status: runnerStatusSchema,
  name: text(),
  workspaceName: text(),
  branch: any('Workspace branch, or null when the kind did not supply one.'),
  phase: any('Current kind phase, or null when unavailable.'),
  ownerContact: { type: 'string', enum: ['live', 'unverifiable'] },
  observedAtMs: integer(),
  lastSuccessfulTickAtMs: any('Last successful tick time, or null when none is retained.'),
  budget: budgetUsageSchema,
  runningWorkers: integer(),
  maxConcurrency: any('Objective concurrency cap, or null when unsupported.'),
  openEscalations: array(escalationSchema),
  pendingQuestion: boolean()
}, [
  'target', 'ownerFence', 'enrollment', 'status', 'name', 'workspaceName', 'branch', 'phase', 'ownerContact',
  'observedAtMs', 'lastSuccessfulTickAtMs', 'budget', 'runningWorkers', 'maxConcurrency', 'openEscalations', 'pendingQuestion'
])

const fleetActionProperties: Record<keyof FleetAction, Schema> = {
  watcherId: text(),
  watcherName: text(),
  attemptId: text(),
  atMs: integer(),
  actionKind: text(),
  state: { type: 'string', enum: ['attempted', 'running', 'settled'] },
  effect: { type: 'string', enum: ['landed', 'not-landed', 'indeterminate'] },
  reason: text()
}
const fleetActionSchema = object(fleetActionProperties, ['watcherId', 'watcherName', 'attemptId', 'atMs', 'actionKind', 'state'])

const fleetSnapshotSchema = object({
  generatedAtMs: integer(),
  rows: array(fleetRowSchema),
  actionHistory: array(fleetActionSchema, 'The newest 30 persisted action attempts across the fleet.'),
  buckets: object({ needsYou: integer(), lostContact: integer(), active: integer(), inactive: integer() }, ['needsYou', 'lostContact', 'active', 'inactive']),
  activeCount: integer(),
  attentionCount: integer()
}, ['generatedAtMs', 'rows', 'actionHistory', 'buckets', 'activeCount', 'attentionCount'])

const watcherDetailSchema = object({
  ...inspectionProperties,
  target: targetSchema,
  ownerFence: ownerFenceSchema,
  ownerContact: { type: 'string', enum: ['live', 'unverifiable'] },
  observedAtMs: integer(),
  name: text(),
  workers: array(workerSchema),
  openEscalations: array(escalationSchema),
  pendingControls: array(text())
}, [
  'readOnly', 'enrollment', 'status', 'journal', 'traces', 'summary', 'budget', 'target', 'ownerFence',
  'ownerContact', 'observedAtMs', 'name', 'workers', 'openEscalations', 'pendingControls'
])

const debugReportSchema = object({
  schemaVersion: { type: 'integer', enum: [2] },
  generatedAtMs: integer(),
  enrollment: enrollmentSchema,
  status: any('Live runner status, or null when no runner is present.'),
  budget: budgetUsageSchema,
  openInterval: any('The active journal interval, or null when none is open.'),
  ledger: array(journalEntrySchema, 'At most the newest 200 entries.'),
  traces: array(traceSchema, 'At most the newest 20 traces.'),
  pendingControls: array(text()),
  malformed: any('Persisted malformed-state detail, or null.'),
  workers: array(workerSchema),
  runner: any('Live runner status, or null when no runner is present.'),
  pointers: object({ database: text(), workspace: text(), leaseHolder: any('Verified lease holder, or null when unavailable.') }, ['database', 'workspace', 'leaseHolder'])
}, [
  'schemaVersion', 'generatedAtMs', 'enrollment', 'status', 'budget', 'openInterval', 'ledger', 'traces',
  'pendingControls', 'malformed', 'workers', 'runner', 'pointers'
])

const watcherCommandSchema = object({
  kind: { type: 'string', enum: ['pause', 'resume', 'disarm', 'delete', 'approve', 'adjust-budget', 'set-concurrency', 'answer-question', 'answer-escalation', 'stop-worker'] },
  escalationId: text(),
  scope: approvalScopeSchema,
  budget: budgetPolicySchema,
  maxConcurrency: integer(),
  messageId: text(),
  body: text(),
  identity: workerIdentitySchema
}, ['kind'])

const commandRequestSchema = object({
  target: targetSchema,
  expectedOwner: ownerFenceSchema,
  command: watcherCommandSchema
}, ['target', 'expectedOwner', 'command'])

const commandResultSchema = object({
  kind: { type: 'string', enum: ['applied', 'refused', 'indeterminate'] },
  appliedAtMs: integer(),
  reason: { type: 'string', enum: ['owner-unreachable', 'unsupported-capability', 'owner-conflict', 'stale-revision', 'watcher-not-found', 'invalid-state', 'question-already-answered', 'worker-unverifiable', 'coordinator-seat-lost', 'invalid-command'] },
  detail: text()
}, ['kind'])

const noParams = object({})
const targetParams = object({ target: targetSchema }, ['target'])

type CliPosition = { name: string; description: string; required: true }
const flag = (type: 'string' | 'integer' | 'boolean' | 'json', description: string, extra: Record<string, unknown> = {}) => ({ type, description, ...extra })
const positional = (name: string, description: string): CliPosition => ({ name: flagNameOf(name), description, required: true })
const command = (id: string, summary: string, methods: string[], positionals: CliPosition[] = [], flags: Record<string, unknown> = {}) => ({
  id,
  summary,
  methods,
  positionals,
  flags
})
const watcherId = positional('watcherId', 'The exact local watcher ID.')
const commandMethods = ['quirky.heimdall/detail', 'quirky.heimdall/command']
const ownerFlags = {
  owner: flag('string', 'Owner agent.', { enum: ['claude'] }),
  'owner-model': flag('string', 'Owner model.'),
  'owner-effort': flag('string', 'Owner effort.')
}

export const controlModulePaths = {
  cli: 'src/control-cli.ts',
  ui: 'dist/ui.js'
} as const

/** Manifest contributions owned by the Heimdall operator layer; the parent installs the module paths above. */
export const controlContributions = {
  method: [
    {
      id: 'fleet',
      description: 'Read the locally owned Heimdall watcher fleet.',
      readOnly: true,
      params: noParams,
      result: fleetSnapshotSchema
    },
    {
      id: 'detail',
      description: 'Read one locally owned watcher and bounded operator projections.',
      readOnly: true,
      params: targetParams,
      result: watcherDetailSchema
    },
    {
      id: 'command',
      description: 'Run one owner-fenced Heimdall watcher control.',
      destructive: true,
      confirm: 'Delete watcher {watcherId} and its saved history? Worker terminals will continue running.',
      describe: 'describeCommand',
      params: commandRequestSchema,
      result: commandResultSchema
    },
    {
      id: 'describeCommand',
      description: 'Describe an irreversible Heimdall command; null for reversible commands.',
      readOnly: true,
      params: commandRequestSchema,
      result: any('Confirmation text for delete, or null when the command is reversible or cannot apply.')
    },
    {
      id: 'debugReport',
      description: 'Read a bounded schema-two diagnostic report for one local watcher.',
      readOnly: true,
      params: targetParams,
      result: debugReportSchema
    }
  ],
  event: [
    {
      id: 'fleetChanged',
      description: 'A newer locally observed Heimdall fleet snapshot is available.',
      data: fleetSnapshotSchema
    },
    {
      id: 'notification',
      description: 'A live Heimdall approval or terminal transition for the notifications policy plugin.',
      data: object({
        watcherId: text(),
        worktreeId: any('Worktree ID, or null when no worktree is attached.'),
        kind: { type: 'string', enum: ['approval-requested', 'terminal'] },
        actionKind: text(),
        state: text(),
        reason: text()
      }, ['watcherId', 'kind'])
    }
  ],
  setting: [],
  'cli-command': [
    command('list', 'list and filter local Heimdall watchers', ['quirky.heimdall/fleet', 'quirky.worktree/resolve'], [], {
      kind: flag('string', 'Filter by watcher kind.', { enum: ['objective', 'hosted-review'] }),
      worktree: flag('string', 'Filter by worktree ID, workspace name or path.')
    }),
    command('show', 'show a watcher and its live detail', ['quirky.heimdall/detail'], [watcherId]),
    command('objective', 'show the objective kind detail', ['quirky.heimdall/detail', 'quirky.heimdall/objectiveDetail'], [watcherId]),
    command('create', 'enroll a registered watcher kind', ['quirky.heimdall/enroll'], [positional('kind', 'A registered Heimdall kind.')], {
      worktree: flag('string', 'Worktree selector; defaults to active.'),
      spec: flag('string', 'JSON or @file with the supported create-spec root keys.'),
      hours: flag('string', 'Active-time budget in hours, or none.'),
      turns: flag('string', 'Worker-turn budget, or none.'),
      objective: flag('string', 'Objective text for objective watchers.'),
      'objective-file': flag('string', 'Read objective text from a file.'),
      'plan-file': flag('string', 'Read plan text from a file.'),
      tier: flag('string', 'Objective tier.'),
      'landing-bar': flag('string', 'Objective landing bar.'),
      'max-concurrency': flag('integer', 'Objective worker cap from 1 to 1,024.'),
      territory: flag('string', 'Repeatable write-territory glob.', { repeatable: true }),
      'role-agent': flag('string', 'Repeatable role=agent selection.', { repeatable: true }),
      gate: flag('string', 'Repeatable objective check name=command; timeout 1,800 seconds.', { repeatable: true }),
      'no-lanes': flag('boolean', 'Disable objective lanes.'),
      cap: flag('string', 'Repeatable capability assignment key=off|gated|on.', { repeatable: true }),
      'branch-update': flag('string', 'Hosted-review branch update mode.', { enum: ['merge-base-update', 'rebase'] }),
      'merge-method': flag('string', 'Hosted-review merge method.', { enum: ['default', 'merge', 'squash', 'rebase'] }),
      ...ownerFlags
    }),
    command('pause', 'pause one watcher after its current tick drains', commandMethods, [watcherId]),
    command('resume', 'resume one eligible watcher', commandMethods, [watcherId]),
    command('disarm', 'explicitly disable one watcher', commandMethods, [watcherId]),
    command('rm', 'delete a watcher and its saved history; worker terminals continue running', commandMethods, [watcherId]),
    command('approve', 'approve one exact open escalation scope', commandMethods, [watcherId, positional('escalationId', 'The exact open escalation ID.')]),
    command('answer', 'answer one pending worker question', commandMethods, [watcherId, positional('messageId', 'The exact pending worker message ID.')], {
      body: flag('string', 'Answer text.', { required: true })
    }),
    command('answer-escalation', 'answer one exact pending owner escalation', commandMethods, [watcherId, positional('escalationId', 'The exact open owner escalation ID.')], {
      body: flag('string', 'Answer text.', { required: true })
    }),
    command('budget', 'adjust a watcher active-time and turn budget', commandMethods, [watcherId], {
      hours: flag('string', 'Active-time budget in hours, or none.'),
      turns: flag('string', 'Worker-turn budget, or none.')
    }),
    command('stop-worker', 'stop a worker by its exact recorded process identity', commandMethods, [watcherId, positional('dispatchId', 'The exact recorded dispatch ID.')]),
    command('set-concurrency', 'set an objective watcher concurrency cap', commandMethods, [watcherId, positional('maxConcurrency', 'An integer from 1 to 1,024.')]),
    command('debug', 'print a bounded schema-two debug report', ['quirky.heimdall/debugReport'], [watcherId], {
      out: flag('string', 'Write the same JSON report to a path on this CLI machine.')
    })
  ],
  view: [{ id: 'fleet', title: 'Heimdall Fleet' }],
  'sidebar-section': [{ id: 'navigation', title: 'Heimdall', order: 40 }]
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTarget(value: unknown): value is WatcherTarget {
  return isRecord(value) && typeof value.watcherId === 'string' && value.watcherId.length > 0
}

function validOwnerFence(value: unknown): value is OwnerFence {
  return isRecord(value) && typeof value.executionHostId === 'string' && typeof value.schedulerOwner === 'string' &&
    typeof value.workspaceKey === 'string' && typeof value.revision === 'number' && Number.isInteger(value.revision)
}

const COMMAND_KINDS: Record<string, true> = {
  pause: true,
  resume: true,
  disarm: true,
  delete: true,
  approve: true,
  'adjust-budget': true,
  'set-concurrency': true,
  'answer-question': true,
  'answer-escalation': true,
  'stop-worker': true
}

function validCommand(value: unknown): value is WatcherCommand {
  return isRecord(value) && typeof value.kind === 'string' && Object.hasOwn(COMMAND_KINDS, value.kind)
}

function commandRequest(params: Record<string, unknown>): CommandRequest {
  if (!validTarget(params.target) || !validOwnerFence(params.expectedOwner) || !validCommand(params.command)) {
    throw new Error('invalid Heimdall command request')
  }
  return { target: params.target, expectedOwner: params.expectedOwner, command: params.command }
}

function isRemote(target: WatcherTarget): boolean {
  return (target.connectionId !== undefined && target.connectionId !== null) ||
    (target.pairingRevision !== undefined && target.pairingRevision !== null)
}

function sameOwnerFence(left: OwnerFence, right: OwnerFence): boolean {
  return left.executionHostId === right.executionHostId && left.schedulerOwner === right.schedulerOwner &&
    left.workspaceKey === right.workspaceKey && left.revision === right.revision
}

function deletePreview(detail: WatcherDetail): string {
  return `Delete watcher “${detail.name}” and its saved history? Worker terminals will continue running.`
}

function commandPreview(request: CommandRequest, detail: WatcherDetail | null): string | null {
  if (request.command.kind !== 'delete' || isRemote(request.target) || detail === null || detail.readOnly) return null
  if (detail.target.watcherId !== request.target.watcherId || !sameOwnerFence(request.expectedOwner, detail.ownerFence)) return null
  return deletePreview(detail)
}

function remoteRefusal(): CommandResult {
  return { kind: 'refused', reason: 'owner-unreachable', detail: 'Remote Heimdall targets are not supported by this local control API.' }
}

function asCommandRequest(params: Record<string, unknown>, host: KernelControlHost): CommandRequest {
  try {
    return commandRequest(params)
  } catch {
    throw host.context.error('invalid-params', 'A Heimdall command needs a local watcher target, owner fence and command.')
  }
}

export function registerControlApi(host: KernelControlHost, controls: ControlPlane, fleet: FleetService): void {
  host.context.provide('method:quirky.heimdall/fleet', () => fleet.fleet())
  host.context.provide('method:quirky.heimdall/detail', async (params: Record<string, unknown>) => {
    if (!validTarget(params.target)) throw host.context.error('invalid-params', 'A local watcher target is required.')
    if (isRemote(params.target)) throw host.context.error('invalid-params', 'Remote Heimdall targets are not supported by this local control API.')
    return fleet.detail(params.target)
  })
  host.context.provide('method:quirky.heimdall/command', async (params: Record<string, unknown>) => {
    const request = asCommandRequest(params, host)
    if (isRemote(request.target)) return remoteRefusal()
    const result = await controls.command(request)
    if (result.kind !== 'refused') {
      void fleet.publish(request.target.watcherId).catch(error => {
        host.context.log(`Heimdall command applied but fleet push failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    return result
  })
  host.context.provide('method:quirky.heimdall/describeCommand', async (params: Record<string, unknown>) => {
    const request = parseControlRequest(params)
    if (!request || isRemote(request.target) || request.command.kind !== 'delete') return null
    const detail = await fleet.detail(request.target)
    return commandPreview(request, detail)
  })
  host.context.provide('method:quirky.heimdall/debugReport', async (params: Record<string, unknown>) => {
    if (!validTarget(params.target)) throw host.context.error('invalid-params', 'A local watcher target is required.')
    if (isRemote(params.target)) throw host.context.error('invalid-params', 'Remote Heimdall targets are not supported by this local control API.')
    return fleet.debugReport(params.target)
  })
}
