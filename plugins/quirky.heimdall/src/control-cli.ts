import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import type {
  CommandRequest,
  CommandResult,
  DebugReport,
  FleetRow,
  FleetSnapshot,
  OpenEscalation,
  OwnerFence,
  WatcherCommand,
  WatcherDetail,
  WatcherTarget,
  WatcherWorker
} from './control-contracts'
import type { BudgetPolicy, EnrollmentInput, EnrollmentResult, Json, OwnerConfig } from './contracts'
import { sortFleetRows } from './fleet-selectors'

const PLUGIN_ID = 'quirky.heimdall'
const ENROLL_METHOD = `${PLUGIN_ID}/enroll`
const FLEET_METHOD = `${PLUGIN_ID}/fleet`
const DETAIL_METHOD = `${PLUGIN_ID}/detail`
const COMMAND_METHOD = `${PLUGIN_ID}/command`
const DEBUG_METHOD = `${PLUGIN_ID}/debugReport`
const CREATE_SPEC_KEYS = new Set(['kindPayload', 'capabilities', 'budget', 'owner', 'ownerInterventionCapability'])
const KIND_SPECIFIC_FLAGS: Record<string, true> = {
  objective: true,
  'objective-file': true,
  'plan-file': true,
  tier: true,
  'landing-bar': true,
  'max-concurrency': true,
  territory: true,
  'role-agent': true,
  gate: true,
  'no-lanes': true,
  'branch-update': true,
  'merge-method': true
}
const CONTROL_COMMANDS = ['pause', 'resume', 'disarm', 'rm', 'approve', 'answer', 'answer-escalation', 'budget', 'stop-worker', 'set-concurrency'] as const

type ControlCommandName = (typeof CONTROL_COMMANDS)[number]
type JsonObject = { [key: string]: Json }
type OwnerFenceShape = OwnerFence

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function fail(ctx: CliContext, message: string): never {
  throw ctx.fail(message)
}

function usage(ctx: CliContext, message: string): never {
  throw ctx.usage(message)
}

function positional(args: CliArgs, index: number, name: string, ctx: CliContext): string {
  const value = args.positionals[index]
  if (typeof value !== 'string' || value.trim() === '') usage(ctx, `missing <${name}>`)
  return value
}

function flagString(args: CliArgs, name: string, ctx: CliContext): string | undefined {
  const value = args.flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') usage(ctx, `--${name} must be a string`)
  return value
}

function flagList(args: CliArgs, name: string, ctx: CliContext): string[] | undefined {
  const value = args.flags[name]
  if (value === undefined) return undefined
  const list = Array.isArray(value) ? value : [value]
  if (!list.every((item) => typeof item === 'string' && item.trim() !== '')) usage(ctx, `--${name} values must be non-empty strings`)
  return list as string[]
}

function requireNoExtraPositionals(args: CliArgs, count: number, ctx: CliContext): void {
  if (args.positionals.length > count) usage(ctx, `unexpected argument "${args.positionals[count]}"`)
}

function parseDetail(value: unknown, ctx: CliContext, watcherId: string): WatcherDetail {
  if (
    !isRecord(value) || !isRecord(value.target) || value.target.watcherId !== watcherId ||
    !isRecord(value.ownerFence) || !isRecord(value.enrollment) || value.enrollment.watcherId !== watcherId ||
    typeof value.ownerFence.executionHostId !== 'string' || typeof value.ownerFence.schedulerOwner !== 'string' ||
    typeof value.ownerFence.workspaceKey !== 'string' || typeof value.ownerFence.revision !== 'number' ||
    typeof value.name !== 'string' || !Array.isArray(value.journal) || !Array.isArray(value.traces) ||
    !Array.isArray(value.workers) || !Array.isArray(value.openEscalations) || !Array.isArray(value.pendingControls)
  ) fail(ctx, `Could not read a valid detail projection for watcher ${watcherId}`)
  return value as unknown as WatcherDetail
}

async function detailFor(ctx: CliContext, watcherId: string): Promise<WatcherDetail> {
  const value = await ctx.call(DETAIL_METHOD, { target: { watcherId } })
  if (value === null) fail(ctx, `Watcher not found: ${watcherId}`)
  return parseDetail(value, ctx, watcherId)
}

function parseFleet(value: unknown, ctx: CliContext): FleetSnapshot {
  if (
    !isRecord(value) || !Array.isArray(value.rows) || !Array.isArray(value.actionHistory) ||
    !isRecord(value.buckets) || typeof value.generatedAtMs !== 'number'
  ) return fail(ctx, 'Could not read a valid fleet snapshot')
  return value as unknown as FleetSnapshot
}

function ownerFenceOf(detail: WatcherDetail): OwnerFenceShape {
  return detail.ownerFence
}

function localTargetOf(detail: WatcherDetail): WatcherTarget {
  return detail.target
}

function stateOf(detail: WatcherDetail): string {
  if (detail.enrollment.paused) return 'paused'
  if (!detail.enrollment.enabled && detail.status?.state !== 'terminal') return 'disabled'
  return detail.status?.state ?? (detail.enrollment.terminalAtMs === null ? 'unavailable' : 'terminal')
}

function listLine(row: FleetRow): string {
  const state = row.enrollment.paused ? 'paused' : row.status.state
  return `${row.target.watcherId} ${row.enrollment.kind} ${state} phase ${row.phase ?? '—'} ${row.enrollment.paused ? 'paused' : 'not paused'} ${row.workspaceName} owner contact ${row.ownerContact}`
}

function listText(rows: FleetRow[]): string {
  return rows.length === 0 ? 'No watchers in the fleet.' : rows.map(listLine).join('\n')
}

function worktreeMatches(row: FleetRow, selector: string): boolean {
  return [
    row.enrollment.worktreeId,
    row.workspaceName,
    row.branch,
    row.enrollment.workspacePath,
    row.enrollment.workspaceKey
  ].some((value) => value === selector)
}

async function list(args: CliArgs, ctx: CliContext): Promise<void> {
  requireNoExtraPositionals(args, 0, ctx)
  const kind = flagString(args, 'kind', ctx)
  const worktree = flagString(args, 'worktree', ctx)
  const snapshot = parseFleet(await ctx.call(FLEET_METHOD), ctx)
  let resolvedWorktreeId: string | undefined
  if (worktree !== undefined && !snapshot.rows.some((row) => worktreeMatches(row, worktree))) {
    const resolved = await ctx.call('quirky.worktree/resolve', { selector: worktree })
    if (!isRecord(resolved) || typeof resolved.id !== 'string') fail(ctx, `Could not resolve worktree selector: ${worktree}`)
    resolvedWorktreeId = resolved.id
  }
  const rows = sortFleetRows(snapshot.rows).filter((row) =>
    (kind === undefined || row.enrollment.kind === kind) &&
    (worktree === undefined || worktreeMatches(row, worktree) || row.enrollment.worktreeId === resolvedWorktreeId)
  )
  ctx.out.result(rows, () => listText(rows))
}

function ownerText(detail: WatcherDetail): string {
  const fence = detail.ownerFence
  return `${fence.executionHostId} / ${fence.schedulerOwner} / ${fence.workspaceKey} / revision ${fence.revision}`
}

function budgetText(policy: BudgetPolicy): string {
  const active = policy.wallClockActiveMs === null ? 'unlimited active time' : `${policy.wallClockActiveMs} ms active time`
  const turns = policy.turns === null ? 'unlimited turns' : `${policy.turns} turns`
  return `${active} / ${turns}`
}

function showText(detail: WatcherDetail): string {
  const pairs: [string, string][] = [
    ['Watcher', detail.name],
    ['Kind', detail.enrollment.kind],
    ['State', stateOf(detail)],
    ['Owner', ownerText(detail)],
    ['Workspace', `${detail.workspaceName} (${detail.enrollment.workspacePath})`],
    ['Owner contact', detail.ownerContact],
    ['Enabled', detail.enrollment.enabled ? 'yes' : 'no'],
    ['Paused', detail.enrollment.paused ? 'yes' : 'no'],
    ['Budget policy', budgetText(detail.enrollment.budget)],
    ['Ledger entries', String(detail.journal.length)],
    ['Traces', String(detail.traces.length)],
    ['Workers', `${detail.workers.length} (${detail.workers.filter((worker) => worker.state === 'live').length} live)`],
    ['Open escalations', detail.openEscalations.length === 0 ? 'none' : detail.openEscalations.map((entry) => entry.escalationId).join(', ')]
  ]
  if (detail.status?.reason) pairs.push(['Status reason', detail.status.reason])
  if (detail.status?.detail) pairs.push(['Status detail', detail.status.detail])
  return pairs.length === 0 ? 'Watcher has no inspectable details.' : pairs.map(([key, value]) => `${key}: ${value}`).join('\n')
}

async function show(args: CliArgs, ctx: CliContext): Promise<void> {
  const watcherId = positional(args, 0, 'watcherId', ctx)
  requireNoExtraPositionals(args, 1, ctx)
  const detail = await detailFor(ctx, watcherId)
  ctx.out.result(detail, () => showText(detail))
}

async function objective(args: CliArgs, ctx: CliContext): Promise<void> {
  const watcherId = positional(args, 0, 'watcherId', ctx)
  requireNoExtraPositionals(args, 1, ctx)
  const detail = await detailFor(ctx, watcherId)
  if (detail.enrollment.kind !== 'objective') usage(ctx, `watcher ${watcherId} is ${detail.enrollment.kind}, not objective`)
  const payload = detail.enrollment.kindPayload
  ctx.out.result(payload, () => JSON.stringify(payload, null, 2))
}

function jsonValue(value: unknown, ctx: CliContext, path: string): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, ctx, `${path}[${index}]`))
  if (isRecord(value)) {
    const output: JsonObject = {}
    for (const [key, item] of Object.entries(value)) output[key] = jsonValue(item, ctx, `${path}.${key}`)
    return output
  }
  return usage(ctx, `${path} must contain only JSON values`)
}

function parseObject(value: unknown, ctx: CliContext, label: string): Record<string, unknown> {
  if (!isRecord(value)) usage(ctx, `${label} must be a JSON object`)
  return value
}

async function createSpec(args: CliArgs, ctx: CliContext): Promise<Record<string, unknown>> {
  const raw = flagString(args, 'spec', ctx)
  if (raw === undefined) return {}
  const source = raw.startsWith('@') ? await ctx.readFile(raw.slice(1)) : raw
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    usage(ctx, `--spec must be JSON or @file: ${error instanceof Error ? error.message : String(error)}`)
  }
  const spec = parseObject(parsed, ctx, '--spec')
  for (const key of Object.keys(spec)) {
    if (!CREATE_SPEC_KEYS.has(key)) usage(ctx, `unsupported --spec key "${key}"`)
  }
  return spec
}

function ownerString(value: unknown, label: string, ctx: CliContext): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') usage(ctx, `${label} must be a non-empty string`)
  return value
}

function parseOwner(specValue: unknown, args: CliArgs, ctx: CliContext): OwnerConfig | undefined {
  let specOwner: OwnerConfig | undefined
  if (specValue !== undefined) {
    const source = parseObject(specValue, ctx, '--spec.owner')
    for (const key of Object.keys(source)) {
      if (key !== 'agent' && key !== 'model' && key !== 'effort') usage(ctx, `unsupported --spec.owner key "${key}"`)
    }
    if (source.agent !== 'claude') usage(ctx, '--spec.owner agent must be claude')
    const specModel = ownerString(source.model, '--spec.owner.model', ctx)
    const specEffort = ownerString(source.effort, '--spec.owner.effort', ctx)
    specOwner = {
      agent: 'claude',
      ...(specModel === undefined ? {} : { model: specModel }),
      ...(specEffort === undefined ? {} : { effort: specEffort })
    }
  }
  const agent = flagString(args, 'owner', ctx)
  if (agent !== undefined && agent !== 'claude') usage(ctx, '--owner must be claude')
  const model = ownerString(flagString(args, 'owner-model', ctx), '--owner-model', ctx)
  const effort = ownerString(flagString(args, 'owner-effort', ctx), '--owner-effort', ctx)
  if ((model !== undefined || effort !== undefined) && agent === undefined && specOwner === undefined) {
    usage(ctx, '--owner-model and --owner-effort require --owner claude or --spec.owner')
  }
  if (agent === undefined && specOwner === undefined) return undefined
  const resolvedModel = model ?? specOwner?.model
  const resolvedEffort = effort ?? specOwner?.effort
  return {
    agent: 'claude',
    ...(resolvedModel === undefined ? {} : { model: resolvedModel }),
    ...(resolvedEffort === undefined ? {} : { effort: resolvedEffort })
  }
}

function ownerInterventionMode(value: unknown, ctx: CliContext): 'off' | 'gated' | 'on' {
  if (value === undefined) return 'off'
  if (value === 'off' || value === 'gated' || value === 'on') return value
  return usage(ctx, '--spec.ownerInterventionCapability must be off, gated or on')
}

function isCapabilityMode(value: unknown): value is 'off' | 'gated' | 'on' {
  return value === 'off' || value === 'gated' || value === 'on'
}

function parseCapabilities(specValue: unknown, args: CliArgs, ctx: CliContext): Record<string, 'off' | 'gated' | 'on'> {
  const capabilities: Record<string, 'off' | 'gated' | 'on'> = {}
  if (specValue !== undefined) {
    const source = parseObject(specValue, ctx, '--spec.capabilities')
    for (const [key, value] of Object.entries(source)) {
      if (!isCapabilityMode(value)) usage(ctx, `--spec.capabilities.${key} must be off, gated or on`)
      capabilities[key] = value
    }
  }
  for (const raw of flagList(args, 'cap', ctx) ?? []) {
    const separator = raw.indexOf('=')
    if (separator < 1) usage(ctx, `--cap must be <key>=<off|gated|on>, got "${raw}"`)
    const key = raw.slice(0, separator).trim()
    const mode = raw.slice(separator + 1)
    if (!key || !isCapabilityMode(mode)) usage(ctx, `--cap must be <key>=<off|gated|on>, got "${raw}"`)
    capabilities[key] = mode
  }
  return capabilities
}

function parseBudget(specValue: unknown, kind: string, args: CliArgs, ctx: CliContext): BudgetPolicy {
  const budget: BudgetPolicy = { wallClockActiveMs: 14_400_000, turns: kind === 'objective' ? 40 : null }
  if (specValue !== undefined) {
    const source = parseObject(specValue, ctx, '--spec.budget')
    for (const key of Object.keys(source)) {
      if (key !== 'wallClockActiveMs' && key !== 'turns') usage(ctx, `unsupported --spec.budget key "${key}"`)
    }
    if (Object.hasOwn(source, 'wallClockActiveMs')) budget.wallClockActiveMs = parseLimitValue(source.wallClockActiveMs, 'wallClockActiveMs', false, ctx)
    if (Object.hasOwn(source, 'turns')) budget.turns = parseLimitValue(source.turns, 'turns', true, ctx)
  }
  const hours = flagString(args, 'hours', ctx)
  if (hours !== undefined) {
    const parsed = hours === 'none' ? null : finiteNonNegative(hours, '--hours', ctx)
    budget.wallClockActiveMs = parsed === null ? null : parsed * 3_600_000
    if (typeof budget.wallClockActiveMs === 'number' && !Number.isFinite(budget.wallClockActiveMs)) usage(ctx, '--hours is too large')
  }
  const turns = flagString(args, 'turns', ctx)
  if (turns !== undefined) {
    budget.turns = turns === 'none' ? null : integerNonNegative(turns, '--turns', ctx)
  }
  return budget
}

function parseLimitValue(value: unknown, name: string, requireInteger: boolean, ctx: CliContext): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (requireInteger && !Number.isInteger(value))) {
    usage(ctx, `--spec.budget.${name} must be a non-negative ${requireInteger ? 'integer' : 'finite number'} or null`)
  }
  return value
}

function finiteNonNegative(raw: string, name: string, ctx: CliContext): number {
  if (raw.trim() === '') usage(ctx, `${name} must be a non-negative number or none`)
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) usage(ctx, `${name} must be a non-negative number or none`)
  return value
}

function integerNonNegative(raw: string, name: string, ctx: CliContext): number {
  if (!/^\d+$/.test(raw)) usage(ctx, `${name} must be a non-negative integer or none`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) usage(ctx, `${name} must be a non-negative safe integer or none`)
  return value
}

async function stringPayload(specValue: unknown, kind: string, args: CliArgs, ctx: CliContext): Promise<JsonObject> {
  const source = specValue === undefined ? {} : parseObject(specValue, ctx, '--spec.kindPayload')
  const payload = jsonValue(source, ctx, '--spec.kindPayload')
  if (!isRecord(payload)) usage(ctx, '--spec.kindPayload must be an object for CLI create flags')
  const result: JsonObject = {}
  for (const [key, value] of Object.entries(payload)) result[key] = value as Json

  if (kind === 'objective') {
    Object.assign(result, {
      tier: 'standard',
      landingBar: 'files-on-disk',
      lanesEnabled: true,
      maxConcurrency: 3,
      writeTerritory: ['**']
    }, payload)
    const objective = flagString(args, 'objective', ctx)
    const objectiveFile = flagString(args, 'objective-file', ctx)
    const planFile = flagString(args, 'plan-file', ctx)
    if (objective !== undefined && objectiveFile !== undefined) usage(ctx, 'choose either --objective or --objective-file')
    if (objective !== undefined) result.objective = objective
    if (objectiveFile !== undefined) result.objective = await ctx.readFile(objectiveFile)
    if (planFile !== undefined) result.plan = await ctx.readFile(planFile)
    const tier = flagString(args, 'tier', ctx)
    const landingBar = flagString(args, 'landing-bar', ctx)
    if (tier !== undefined) result.tier = tier
    if (landingBar !== undefined) result.landingBar = landingBar
    const maxConcurrency = args.flags['max-concurrency']
    if (maxConcurrency !== undefined) {
      const parsed = typeof maxConcurrency === 'number' ? maxConcurrency : Number(String(maxConcurrency))
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1024) usage(ctx, '--max-concurrency must be an integer from 1 to 1,024')
      result.maxConcurrency = parsed
    }
    const territory = flagList(args, 'territory', ctx)
    if (territory !== undefined) result.writeTerritory = territory
    const roleAgents = flagList(args, 'role-agent', ctx)
    if (roleAgents !== undefined) result.roleAgents = roleAgents
    const gates = flagList(args, 'gate', ctx)
    if (gates !== undefined) result.gates = gates
    if (typeof args.flags['no-lanes'] === 'string') usage(ctx, '--no-lanes must be a boolean')
    if (args.flags['no-lanes'] !== undefined) result.lanesEnabled = args.flags['no-lanes'] !== true
    const objectiveText = result.objective
    if (typeof objectiveText !== 'string' || objectiveText.trim() === '') usage(ctx, 'create objective requires --objective, --objective-file or --spec.kindPayload.objective')
  } else if (kind === 'hosted-review') {
    Object.assign(result, { branchUpdateMode: 'merge-base-update', mergeMethod: null }, payload)
    const branchUpdate = args.flags['branch-update']
    if (branchUpdate !== undefined && typeof branchUpdate !== 'boolean') usage(ctx, '--branch-update must be a boolean')
    if (branchUpdate === false) result.branchUpdateMode = 'none'
    if (branchUpdate === true) result.branchUpdateMode = 'merge-base-update'
    const mergeMethod = flagString(args, 'merge-method', ctx)
    if (mergeMethod !== undefined) {
      if (mergeMethod !== 'merge' && mergeMethod !== 'squash' && mergeMethod !== 'rebase' && mergeMethod !== 'none') {
        usage(ctx, '--merge-method must be merge, squash, rebase or none')
      }
      result.mergeMethod = mergeMethod === 'none' ? null : mergeMethod
    }
  } else if (Object.keys(args.flags).some((key) => Object.hasOwn(KIND_SPECIFIC_FLAGS, key))) {
    usage(ctx, `create ${kind} does not define kind-specific flags; pass its registered payload with --spec`)
  } else if (specValue === undefined) {
    usage(ctx, `create ${kind} requires --spec kindPayload because no CLI defaults are documented for that registered kind`)
  }

  const worktree = flagString(args, 'worktree', ctx)
  if (worktree !== undefined) {
    if (worktree.trim() === '') usage(ctx, '--worktree must not be empty')
    result.worktree = worktree
  } else if (kind === 'objective' || kind === 'hosted-review') {
    result.worktree ??= 'active'
  }
  return result
}

async function create(args: CliArgs, ctx: CliContext): Promise<void> {
  const kind = positional(args, 0, 'kind', ctx)
  requireNoExtraPositionals(args, 1, ctx)
  const spec = await createSpec(args, ctx)
  const kindPayload = await stringPayload(spec.kindPayload, kind, args, ctx)
  const budget = parseBudget(spec.budget, kind, args, ctx)
  const capabilities = parseCapabilities(spec.capabilities, args, ctx)
  const owner = parseOwner(spec.owner, args, ctx)
  const ownerInterventionCapability = ownerInterventionMode(spec.ownerInterventionCapability, ctx)
  const input: EnrollmentInput = {
    kind,
    kindPayload,
    capabilities,
    budget,
    ...(owner === undefined ? {} : { owner }),
    ownerInterventionCapability
  }
  const enrollmentParams: Record<string, unknown> = { ...input }
  const response = await ctx.call(ENROLL_METHOD, enrollmentParams)
  if (!isRecord(response) || typeof response.kind !== 'string') fail(ctx, 'Heimdall enrollment returned an invalid result')
  const result = response as unknown as EnrollmentResult
  const text = result.kind === 'refused'
    ? `Heimdall enrollment refused: ${result.reason}: ${result.detail}`
    : `${result.kind === 're-armed' ? 'Re-armed' : 'Enrolled'} ${result.enrollment.watcherId}`
  ctx.out.result(result, () => text)
  if (result.kind === 'refused') fail(ctx, text)
}

function commandText(result: CommandResult): string {
  if (result.kind === 'applied') return `Applied by the owner at ${new Date(result.appliedAtMs).toISOString()}`
  if (result.kind === 'refused') return `Refused (${result.reason}): ${result.detail}`
  return `Indeterminate: ${result.detail}`
}

function parseCommandResult(value: unknown, ctx: CliContext): CommandResult {
  if (!isRecord(value) || typeof value.kind !== 'string') return fail(ctx, 'Heimdall command returned an invalid result')
  if (value.kind === 'applied' && typeof value.appliedAtMs === 'number' && Number.isFinite(value.appliedAtMs)) {
    return value as unknown as CommandResult
  }
  if (value.kind === 'refused' && typeof value.reason === 'string' && typeof value.detail === 'string') {
    return value as unknown as CommandResult
  }
  if (value.kind === 'indeterminate' && typeof value.detail === 'string') return value as unknown as CommandResult
  return fail(ctx, 'Heimdall command returned an invalid result')
}

function approvalScope(escalation: OpenEscalation, ctx: CliContext): NonNullable<OpenEscalation['approvalScope']> {
  const scope = escalation.approvalScope
  if (
    !isRecord(scope) || typeof scope.actionKind !== 'string' || typeof scope.contentIdentity !== 'string' ||
    typeof scope.evidenceKey !== 'string' || (scope.preparedCommitSha !== undefined && typeof scope.preparedCommitSha !== 'string')
  ) fail(ctx, `Escalation ${escalation.escalationId} has no exact approval scope`)
  return scope as NonNullable<OpenEscalation['approvalScope']>
}

function openEscalation(detail: WatcherDetail, escalationId: string, ctx: CliContext): OpenEscalation {
  const escalation = detail.openEscalations.find((entry) => entry.escalationId === escalationId && entry.status === 'open')
  if (!escalation) fail(ctx, `Open escalation not found: ${escalationId}`)
  return escalation
}

function workerForStop(detail: WatcherDetail, dispatchId: string, ctx: CliContext): WatcherWorker {
  const worker = detail.workers.find((candidate) => candidate.identity.dispatchId === dispatchId && candidate.state === 'live')
  if (!worker) fail(ctx, `Live worker not found: ${dispatchId}`)
  if (!worker.identity.sessionId || !worker.identity.processIncarnation) {
    fail(ctx, `Worker ${dispatchId} has no verifiable session/process identity; refusing to stop it`)
  }
  return worker
}

function pendingQuestion(detail: WatcherDetail, messageId: string, ctx: CliContext): WatcherWorker {
  const worker = detail.workers.find((candidate) =>
    candidate.question?.messageId === messageId && candidate.question.answered !== true
  )
  if (!worker) fail(ctx, `Pending worker question not found: ${messageId}`)
  return worker
}

function commandParams(request: CommandRequest): Record<string, unknown> {
  return { target: request.target, expectedOwner: request.expectedOwner, command: request.command }
}

async function sendCommand(watcherId: string, command: WatcherCommand, ctx: CliContext): Promise<void> {
  const detail = await detailFor(ctx, watcherId)
  const request: CommandRequest = {
    target: localTargetOf(detail),
    expectedOwner: ownerFenceOf(detail),
    command
  }
  const result = parseCommandResult(await ctx.call(COMMAND_METHOD, commandParams(request)), ctx)
  const text = commandText(result)
  ctx.out.result(result, () => text)
  if (result.kind !== 'applied') fail(ctx, text)
}

async function runControl(name: ControlCommandName, args: CliArgs, ctx: CliContext): Promise<void> {
  const watcherId = positional(args, 0, 'watcherId', ctx)
  switch (name) {
    case 'pause':
    case 'resume':
    case 'disarm':
    case 'rm':
      requireNoExtraPositionals(args, 1, ctx)
      await sendCommand(watcherId, { kind: name === 'rm' ? 'delete' : name }, ctx)
      return
    case 'approve': {
      const escalationId = positional(args, 1, 'escalationId', ctx)
      requireNoExtraPositionals(args, 2, ctx)
      const detail = await detailFor(ctx, watcherId)
      const escalation = openEscalation(detail, escalationId, ctx)
      const request: CommandRequest = {
        target: localTargetOf(detail),
        expectedOwner: ownerFenceOf(detail),
        command: { kind: 'approve', escalationId, scope: approvalScope(escalation, ctx) }
      }
      await sendPreparedRequest(request, ctx)
      return
    }
    case 'answer': {
      const messageId = positional(args, 1, 'messageId', ctx)
      requireNoExtraPositionals(args, 2, ctx)
      const body = flagString(args, 'body', ctx)
      if (!body || body.trim() === '') usage(ctx, 'Missing required --body')
      const detail = await detailFor(ctx, watcherId)
      pendingQuestion(detail, messageId, ctx)
      await sendPreparedRequest({
        target: localTargetOf(detail),
        expectedOwner: ownerFenceOf(detail),
        command: { kind: 'answer-question', messageId, body }
      }, ctx)
      return
    }
    case 'answer-escalation': {
      const escalationId = positional(args, 1, 'escalationId', ctx)
      requireNoExtraPositionals(args, 2, ctx)
      const body = flagString(args, 'body', ctx)
      if (!body || body.trim() === '') usage(ctx, 'Missing required --body')
      const detail = await detailFor(ctx, watcherId)
      openEscalation(detail, escalationId, ctx)
      await sendPreparedRequest({
        target: localTargetOf(detail),
        expectedOwner: ownerFenceOf(detail),
        command: { kind: 'answer-escalation', escalationId, body }
      }, ctx)
      return
    }
    case 'budget': {
      requireNoExtraPositionals(args, 1, ctx)
      const hours = flagString(args, 'hours', ctx)
      const turns = flagString(args, 'turns', ctx)
      if (hours === undefined && turns === undefined) usage(ctx, 'budget requires --hours, --turns, or both')
      const detail = await detailFor(ctx, watcherId)
      const budget = { ...detail.enrollment.budget }
      if (hours !== undefined) {
        const parsed = hours === 'none' ? null : finiteNonNegative(hours, '--hours', ctx)
        budget.wallClockActiveMs = parsed === null ? null : parsed * 3_600_000
        if (typeof budget.wallClockActiveMs === 'number' && !Number.isFinite(budget.wallClockActiveMs)) usage(ctx, '--hours is too large')
      }
      if (turns !== undefined) budget.turns = turns === 'none' ? null : integerNonNegative(turns, '--turns', ctx)
      await sendPreparedRequest({
        target: localTargetOf(detail),
        expectedOwner: ownerFenceOf(detail),
        command: { kind: 'adjust-budget', budget }
      }, ctx)
      return
    }
    case 'stop-worker': {
      const dispatchId = positional(args, 1, 'dispatchId', ctx)
      requireNoExtraPositionals(args, 2, ctx)
      const detail = await detailFor(ctx, watcherId)
      const worker = workerForStop(detail, dispatchId, ctx)
      await sendPreparedRequest({
        target: localTargetOf(detail),
        expectedOwner: ownerFenceOf(detail),
        command: { kind: 'stop-worker', identity: worker.identity }
      }, ctx)
      return
    }
    case 'set-concurrency': {
      const raw = positional(args, 1, 'maxConcurrency', ctx)
      requireNoExtraPositionals(args, 2, ctx)
      const maxConcurrency = integerNonNegative(raw, '<maxConcurrency>', ctx)
      if (maxConcurrency < 1 || maxConcurrency > 1024) usage(ctx, '<maxConcurrency> must be an integer from 1 to 1,024')
      await sendCommand(watcherId, { kind: 'set-concurrency', maxConcurrency }, ctx)
      return
    }
  }
}

async function sendPreparedRequest(request: CommandRequest, ctx: CliContext): Promise<void> {
  const result = parseCommandResult(await ctx.call(COMMAND_METHOD, commandParams(request)), ctx)
  const text = commandText(result)
  ctx.out.result(result, () => text)
  if (result.kind !== 'applied') fail(ctx, text)
}

function validDebugReport(value: unknown, ctx: CliContext, watcherId: string): DebugReport {
  if (
    !isRecord(value) || value.schemaVersion !== 2 || typeof value.generatedAtMs !== 'number' ||
    !isRecord(value.enrollment) || value.enrollment.watcherId !== watcherId || !Array.isArray(value.ledger) ||
    !Array.isArray(value.traces) || !Array.isArray(value.workers) || !isRecord(value.pointers)
  ) fail(ctx, `Could not read a valid debug report for watcher ${watcherId}`)
  return value as unknown as DebugReport
}

async function debug(args: CliArgs, ctx: CliContext): Promise<void> {
  const watcherId = positional(args, 0, 'watcherId', ctx)
  requireNoExtraPositionals(args, 1, ctx)
  const report = validDebugReport(await ctx.call(DEBUG_METHOD, { target: { watcherId } }), ctx, watcherId)
  const outputPath = flagString(args, 'out', ctx)
  const bytes = `${JSON.stringify(report, null, 2)}\n`
  ctx.out.jsonLine(report)
  if (outputPath !== undefined) {
    try {
      await writeFile(resolve(ctx.cwd, outputPath), bytes, 'utf8')
    } catch (error) {
      fail(ctx, `Could not write debug report to ${outputPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const createHandler = async (args: CliArgs, ctx: CliContext) => create(args, ctx)
const debugHandler = async (args: CliArgs, ctx: CliContext) => debug(args, ctx)
const handlers = {
  list,
  show,
  objective,
  create: createHandler,
  debug: debugHandler,
  ...Object.fromEntries(CONTROL_COMMANDS.map((name) => [name, (args: CliArgs, ctx: CliContext) => runControl(name, args, ctx)]))
} as Record<string, (args: CliArgs, context: CliContext) => Promise<void>>

export const commands: CliModule['commands'] = {
  ...handlers,
  ...Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [`cli-command:${PLUGIN_ID}/${name}`, handler]))
}
