import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import type { AutomationDefinition, AutomationRun, AutomationRunsPage, ScheduleBuildInput } from './types'
import { buildAutomationRrule, describeAutomationSchedule, isValidAutomationSchedule } from './schedule'
import { uiCommands } from './src/ui-cli'

const createFlags = [
  'name', 'prompt', 'provider', 'project', 'repo', 'workspace', 'workspaceMode', 'baseBranch', 'setupDecision',
  'trigger', 'schedule', 'time', 'day', 'timezone', 'enabled', 'disabled', 'missedRunGraceMinutes',
  'reuseSession', 'freshSession', 'precheck', 'precheckTimeout', 'sourceContext', 'creationKey', 'model', 'effort',
  'extraAgentArgs'
] as const
const editFlags: readonly string[] = ['id', 'expectedOwner', ...createFlags.filter((name) => name !== 'creationKey')]

type Flags = Record<string, unknown>
type ScheduleChoice = { rule?: string; timezone?: string }
type LaunchInput = { present: boolean; value?: { model?: string; optionValues?: Record<string, string | boolean> } | null }

function usage(ctx: CliContext, message: string): never {
  throw ctx.usage(message)
}

function own(flags: Flags, name: string): boolean {
  return Object.hasOwn(flags, name) && flags[name] !== undefined
}

function stringFlag(flags: Flags, name: string, ctx: CliContext): string | undefined {
  if (!own(flags, name)) return undefined
  const value = flags[name]
  if (typeof value !== 'string') usage(ctx, `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be text`)
  return value
}

function boolFlag(flags: Flags, name: string, ctx: CliContext): boolean {
  if (!own(flags, name)) return false
  if (flags[name] !== true) usage(ctx, `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a valueless switch`)
  return true
}

function assertKnownFlags(flags: Flags, allowed: readonly string[], ctx: CliContext): void {
  const known = new Set(allowed)
  for (const name of Object.keys(flags)) {
    if (!known.has(name)) usage(ctx, `Unknown flag --${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)
  }
  if (own(flags, 'extraAgentArgs')) {
    const value = flags.extraAgentArgs
    if (typeof value !== 'string') usage(ctx, '--extra-agent-args must be text.')
    if (value.trim() !== '') usage(ctx, 'Raw --extra-agent-args are refused: automations use structured sessions without command-line arguments.')
  }
}

function positionals(args: CliArgs, expected: number, ctx: CliContext): string[] {
  if (args.positionals.length !== expected) usage(ctx, expected === 0 ? 'This command does not accept positional arguments.' : 'Provide exactly one automation ID.')
  return args.positionals
}

function idOf(args: CliArgs, ctx: CliContext, allowFlag = true): string {
  if (args.positionals.length > 1) usage(ctx, 'Provide exactly one automation ID.')
  const positional = args.positionals[0]
  const flagId = allowFlag ? stringFlag(args.flags, 'id', ctx) : undefined
  if (positional !== undefined && flagId !== undefined) usage(ctx, 'Provide the automation ID either positionally or with --id, not both.')
  const id = positional ?? flagId
  if (typeof id !== 'string' || id.trim() === '') usage(ctx, 'An automation ID is required.')
  return id.trim()
}

function numericFlag(flags: Flags, name: string, ctx: CliContext): number | undefined {
  const value = flags[name]
  if (!own(flags, name)) return undefined
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isSafeInteger(numeric)) usage(ctx, `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be an integer.`)
  return numeric
}

function parseTime(value: string | undefined, ctx: CliContext): { hour: number; minute: number } {
  if (value === undefined) return { hour: 9, minute: 0 }
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) usage(ctx, '--time must use H:MM or HH:MM in 24-hour time.')
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) usage(ctx, '--time must be a valid 24-hour time.')
  return { hour, minute }
}

function parseDay(value: string | undefined, ctx: CliContext): number {
  if (value === undefined) return 1
  if (!/^[0-6]$/.test(value)) usage(ctx, '--day must be an integer from 0 (Sunday) through 6 (Saturday).')
  return Number(value)
}

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function scheduleChoice(flags: Flags, ctx: CliContext, mode: 'create' | 'edit', old?: AutomationDefinition): ScheduleChoice {
  const trigger = stringFlag(flags, 'trigger', ctx)
  const schedule = stringFlag(flags, 'schedule', ctx)
  if (trigger !== undefined && schedule !== undefined) usage(ctx, '--trigger and --schedule are mutually exclusive.')
  const selected = trigger ?? schedule
  const time = stringFlag(flags, 'time', ctx)
  const dayText = stringFlag(flags, 'day', ctx)
  const timezone = stringFlag(flags, 'timezone', ctx) ?? (mode === 'create' ? localTimezone() : old?.timezone)
  if (selected === undefined) {
    if (time !== undefined || dayText !== undefined) usage(ctx, '--time and --day require --trigger or --schedule.')
    if (mode === 'create') usage(ctx, 'A scheduled automation requires --trigger or --schedule.')
    return timezone === undefined ? {} : { timezone }
  }

  const normalized = selected.trim().toLowerCase()
  if (!normalized) usage(ctx, '--trigger/--schedule cannot be blank.')
  if (normalized === 'manual') usage(ctx, 'Manual-only automations are not supported yet. Create a scheduled automation with --disabled and run it with `quirky automations run <id>` when needed.')
  const preset = normalized as ScheduleBuildInput['preset']
  if (preset === 'hourly') {
    if (time !== undefined) usage(ctx, '--time is not allowed with hourly; use a cron trigger such as "30 * * * *" to choose the minute.')
    if (dayText !== undefined) usage(ctx, '--day is only allowed with weekly.')
    return { rule: buildAutomationRrule({ preset: 'hourly', minute: 0 }), timezone }
  }
  if (preset === 'daily' || preset === 'weekdays' || preset === 'weekly') {
    if (preset !== 'weekly' && dayText !== undefined) usage(ctx, '--day is only allowed with weekly.')
    const { hour, minute } = parseTime(time, ctx)
    const input: ScheduleBuildInput = preset === 'weekly'
      ? { preset, hour, minute, day: parseDay(dayText, ctx) }
      : { preset, hour, minute }
    return { rule: buildAutomationRrule(input), timezone }
  }
  if (time !== undefined) usage(ctx, '--time is not allowed with a raw schedule.')
  if (dayText !== undefined) usage(ctx, '--day is only allowed with weekly.')
  if (!isValidAutomationSchedule(selected.trim(), timezone)) usage(ctx, 'Invalid automation schedule.')
  return { rule: selected.trim(), timezone }
}

function parseJsonRecord(value: string | undefined, flag: string, ctx: CliContext): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined
  if (value.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    usage(ctx, `--${flag} must contain valid JSON.`)
  }
  if (parsed === null) return null
  if (typeof parsed !== 'object' || Array.isArray(parsed)) usage(ctx, `--${flag} must contain a JSON object or null.`)
  return parsed as Record<string, unknown>
}
function expectedOwnerInput(flags: Flags, ctx: CliContext): { expectedOwner?: Record<string, unknown> | null } {
  const value = parseJsonRecord(stringFlag(flags, 'expectedOwner', ctx), 'expected-owner', ctx)
  return value === undefined ? {} : { expectedOwner: value }
}

function targetPatch(flags: Flags, ctx: CliContext, mode: 'create' | 'edit', old?: AutomationDefinition): Record<string, unknown> {
  const project = stringFlag(flags, 'project', ctx)
  const repo = stringFlag(flags, 'repo', ctx)
  const workspace = stringFlag(flags, 'workspace', ctx)
  if (project !== undefined && repo !== undefined) usage(ctx, '--project and --repo identify the same project and cannot both be supplied.')
  const projectId = project ?? repo
  if (mode === 'create' && (projectId === undefined || projectId.trim() === '')) usage(ctx, 'Create requires --project or --repo; target resolution is not performed by this command.')

  const workspaceModeRaw = stringFlag(flags, 'workspaceMode', ctx)
  let workspaceMode: 'existing' | 'new_per_run' | undefined
  if (workspaceModeRaw !== undefined) {
    if (workspaceModeRaw === 'existing') workspaceMode = 'existing'
    else if (workspaceModeRaw === 'new-per-run' || workspaceModeRaw === 'new_per_run') workspaceMode = 'new_per_run'
    else usage(ctx, '--workspace-mode must be existing or new-per-run.')
  } else if (mode === 'create') {
    workspaceMode = workspace === undefined ? 'new_per_run' : 'existing'
  } else if (workspace !== undefined) {
    workspaceMode = 'existing'
  }
  const effectiveMode = workspaceMode ?? old?.workspaceMode
  const workspaceSelectionChanged = mode === 'create' || workspaceModeRaw !== undefined || workspace !== undefined
  if (workspace !== undefined && effectiveMode !== 'existing') usage(ctx, '--workspace requires an existing workspace mode.')
  if (effectiveMode === 'existing' && workspace === undefined && mode === 'create') usage(ctx, '--workspace-mode existing requires --workspace.')
  if (effectiveMode === 'existing' && workspace === undefined && workspaceModeRaw !== undefined && old?.workspaceMode !== 'existing') {
    usage(ctx, '--workspace-mode existing requires --workspace.')
  }
  if (effectiveMode === 'new_per_run' && workspace !== undefined) usage(ctx, '--workspace-mode new-per-run does not accept --workspace.')

  const patch: Record<string, unknown> = {}
  if (projectId !== undefined) patch.projectId = projectId.trim()
  if (workspaceMode !== undefined) patch.workspaceMode = workspaceMode
  if (workspace !== undefined) patch.workspaceId = workspace.trim()
  else if (mode === 'create' || workspaceModeRaw !== undefined && workspaceMode === 'new_per_run') patch.workspaceId = null

  if (effectiveMode === 'existing') {
    if (own(flags, 'baseBranch')) usage(ctx, '--base-branch is only allowed with --workspace-mode new-per-run.')
    if (own(flags, 'setupDecision')) usage(ctx, '--setup-decision is only allowed with --workspace-mode new-per-run.')
    if (workspaceSelectionChanged) {
      patch.baseBranch = null
      patch.setupDecision = null
    }
    const workspaceChanged = workspace !== undefined && workspace !== old?.workspaceId
    if (mode === 'create' || old?.workspaceMode !== 'existing' || workspaceChanged) patch.reuseSession = false
  } else if (effectiveMode === 'new_per_run') {
    if (mode === 'create' || workspaceModeRaw !== undefined) patch.workspaceId = null
    const baseBranch = stringFlag(flags, 'baseBranch', ctx)
    if (baseBranch !== undefined) patch.baseBranch = baseBranch.trim() || null
    else if (mode === 'create' || workspaceModeRaw !== undefined || old?.workspaceMode === 'existing') patch.baseBranch = null
    const setupDecision = stringFlag(flags, 'setupDecision', ctx)
    if (setupDecision !== undefined) {
      if (setupDecision !== 'run' && setupDecision !== 'skip') usage(ctx, '--setup-decision must be run or skip.')
      patch.setupDecision = setupDecision
    } else if (workspaceModeRaw !== undefined || old?.workspaceMode === 'existing') {
      patch.setupDecision = null
    }
    if (mode === 'create' || workspaceModeRaw !== undefined || old?.workspaceMode === 'existing') patch.reuseSession = false
  } else {
    const baseBranch = stringFlag(flags, 'baseBranch', ctx)
    if (baseBranch !== undefined) patch.baseBranch = baseBranch.trim() || null
    const setupDecision = stringFlag(flags, 'setupDecision', ctx)
    if (setupDecision !== undefined) {
      if (setupDecision !== 'run' && setupDecision !== 'skip') usage(ctx, '--setup-decision must be run or skip.')
      patch.setupDecision = setupDecision
    }
  }

  const reuse = boolFlag(flags, 'reuseSession', ctx)
  const fresh = boolFlag(flags, 'freshSession', ctx)
  if (reuse && fresh) usage(ctx, '--reuse-session and --fresh-session are mutually exclusive.')
  if (reuse && effectiveMode !== 'existing') usage(ctx, '--reuse-session requires an existing workspace.')
  if (reuse || fresh) patch.reuseSession = reuse
  else if (mode === 'create' && effectiveMode === 'existing') patch.reuseSession = false
  return patch
}

function launchInput(flags: Flags, ctx: CliContext, mode: 'create' | 'edit'): LaunchInput {
  const model = stringFlag(flags, 'model', ctx)
  const effort = stringFlag(flags, 'effort', ctx)
  if (model === undefined && effort === undefined) return { present: false }
  if (mode === 'create' && (model?.toLowerCase() === 'inherit' || effort?.toLowerCase() === 'inherit')) {
    usage(ctx, 'inherit is only valid when editing an automation.')
  }
  if (mode === 'create' && effort !== undefined && effort.toLowerCase() !== 'inherit' && model === undefined) {
    usage(ctx, '--effort requires --model.')
  }
  for (const [name, value] of [['model', model], ['effort', effort]] as const) {
    if (value !== undefined && value.toLowerCase() !== 'inherit' && (value.length < 1 || value.length > 128)) {
      usage(ctx, `--${name} must contain 1 to 128 characters.`)
    }
  }
  const overrides: { model?: string; optionValues?: Record<string, string | boolean> } = {}
  if (model !== undefined && model.toLowerCase() !== 'inherit') overrides.model = model
  if (effort !== undefined && effort.toLowerCase() !== 'inherit') overrides.optionValues = { effort }
  if (Object.keys(overrides).length === 0) return { present: true, value: null }
  return { present: true, value: overrides }
}

async function mergeLaunchInput(
  id: string,
  flags: Flags,
  ctx: CliContext,
  explicit: LaunchInput,
  providerChanged: boolean,
  old?: AutomationDefinition
): Promise<{ model?: string; optionValues?: Record<string, string | boolean> } | null | undefined> {
  if (!explicit.present) return providerChanged ? null : undefined
  const model = stringFlag(flags, 'model', ctx)
  const effort = stringFlag(flags, 'effort', ctx)
  if (model?.toLowerCase() === 'inherit' && effort?.toLowerCase() === 'inherit') return null
  const current = old ?? await ctx.call('quirky.automations/show', { id }) as AutomationDefinition
  const merged: { model?: string; optionValues?: Record<string, string | boolean> } = providerChanged ? {} : {
    ...(current.launchOverrides?.model === undefined ? {} : { model: current.launchOverrides.model }),
    ...(current.launchOverrides?.optionValues === undefined ? {} : { optionValues: { ...current.launchOverrides.optionValues } })
  }
  if (model !== undefined) {
    if (model.toLowerCase() === 'inherit') delete merged.model
    else merged.model = model
  }
  if (effort !== undefined) {
    const optionValues = { ...(merged.optionValues ?? {}) }
    if (effort.toLowerCase() === 'inherit') delete optionValues.effort
    else optionValues.effort = effort
    if (Object.keys(optionValues).length > 0) merged.optionValues = optionValues
    else delete merged.optionValues
  }
  if (providerChanged && model === undefined && effort === undefined) return null
  if (effort !== undefined && effort.toLowerCase() !== 'inherit' && !merged.model) {
    usage(ctx, '--effort requires a model; set --model or inherit an existing model.')
  }
  return Object.keys(merged).length > 0 ? merged : null
}

function precheckPatch(flags: Flags, ctx: CliContext): Record<string, unknown> {
  const precheck = stringFlag(flags, 'precheck', ctx)
  const timeout = numericFlag(flags, 'precheckTimeout', ctx)
  if (timeout !== undefined && (timeout < 1 || timeout > 600)) usage(ctx, '--precheck-timeout must be an integer from 1 to 600.')
  if (timeout !== undefined && (precheck === undefined || precheck.trim() === '')) usage(ctx, '--precheck-timeout requires a non-empty --precheck.')
  if (precheck === undefined) return {}
  if (precheck.trim() === '') return { precheck: null }
  return { precheck: { command: precheck.trim(), timeoutSeconds: timeout ?? 60 } }
}

function enabledPatch(flags: Flags, ctx: CliContext, mode: 'create' | 'edit'): Record<string, unknown> {
  const enabled = boolFlag(flags, 'enabled', ctx)
  const disabled = boolFlag(flags, 'disabled', ctx)
  if (enabled && disabled) usage(ctx, '--enabled and --disabled are mutually exclusive.')
  if (enabled) return { enabled: true }
  if (disabled) return { enabled: false }
  return mode === 'create' ? { enabled: true } : {}
}


function commonDefinitionPatch(flags: Flags, ctx: CliContext): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const name = stringFlag(flags, 'name', ctx)
  if (name !== undefined) patch.name = name.trim() || 'Untitled automation'
  const prompt = stringFlag(flags, 'prompt', ctx)
  if (prompt !== undefined) patch.prompt = prompt
  const provider = stringFlag(flags, 'provider', ctx)
  if (provider !== undefined) patch.agentId = provider
  const creationKey = stringFlag(flags, 'creationKey', ctx)
  if (creationKey !== undefined) patch.creationKey = creationKey
  const grace = numericFlag(flags, 'missedRunGraceMinutes', ctx)
  if (grace !== undefined) {
    if (grace < 0) usage(ctx, '--missed-run-grace-minutes must be zero or greater.')
    patch.missedRunGraceMinutes = grace
  }
  const sourceContext = parseJsonRecord(stringFlag(flags, 'sourceContext', ctx), 'source-context', ctx)
  if (sourceContext !== undefined) patch.sourceContext = sourceContext
  return patch
}

async function definitionInput(args: CliArgs, ctx: CliContext, mode: 'create' | 'edit', old?: AutomationDefinition): Promise<Record<string, unknown>> {
  const flags = args.flags
  const patch: Record<string, unknown> = {
    ...commonDefinitionPatch(flags, ctx),
    ...targetPatch(flags, ctx, mode, old),
    ...enabledPatch(flags, ctx, mode),
    ...precheckPatch(flags, ctx)
  }
  if (mode === 'create' && !own(flags, 'missedRunGraceMinutes')) patch.missedRunGraceMinutes = 720
  if (mode === 'create') {
    const name = stringFlag(flags, 'name', ctx)
    const prompt = stringFlag(flags, 'prompt', ctx)
    const provider = stringFlag(flags, 'provider', ctx)
    if (name === undefined) usage(ctx, 'Create requires --name.')
    if (prompt === undefined || prompt.trim() === '') usage(ctx, 'Create requires a non-empty --prompt.')
    if (provider !== 'claude' && provider !== 'codex') usage(ctx, '--provider must be claude or codex.')
  }
  const choice = scheduleChoice(flags, ctx, mode, old)
  if (choice.rule !== undefined) {
    patch.rrule = choice.rule
    patch.dtstart = ctx.now()
  }
  if (choice.timezone !== undefined) patch.timezone = choice.timezone
  if (mode === 'create' && choice.timezone === undefined) patch.timezone = localTimezone()
  if (mode === 'create' && choice.rule === undefined) usage(ctx, 'Create requires a valid schedule.')

  const launch = launchInput(flags, ctx, mode)
  const providerChanged = mode === 'edit' && own(flags, 'provider') && stringFlag(flags, 'provider', ctx) !== old?.agentId
  const launchOverrides = mode === 'edit'
    ? await mergeLaunchInput(String(old?.id), flags, ctx, launch, providerChanged, old)
    : launch.value
  if (launch.present || providerChanged) patch.launchOverrides = launchOverrides ?? null
  return patch
}

function displayTime(value: number): string {
  try { return new Date(value).toISOString() } catch { return String(value) }
}

function scheduleLabel(rule: string): string {
  try {
    return describeAutomationSchedule(rule).label
  } catch {
    return 'Invalid schedule'
  }
}
function definitionSummary(definition: AutomationDefinition): string {
  const next = definition.enabled ? displayTime(definition.nextRunAt) : 'Paused'
  return `${scheduleLabel(definition.rrule)}  ${definition.enabled ? 'enabled' : 'disabled'}  next: ${next}`
}
function ownerLabel(definition: AutomationDefinition): string {
  const owner = definition.owner
  if (!owner) return 'not captured'
  return `${owner.repoPath}${owner.workspacePath ? ` / ${owner.workspacePath}` : ''}`
}


function definitionText(definition: AutomationDefinition): string {
  const pairs: Array<[string, string]> = [
    ['id', definition.id], ['name', definition.name], ['provider', definition.agentId], ['projectId', definition.projectId],
    ['owner', ownerLabel(definition)], ['workspaceMode', definition.workspaceMode], ['workspaceId', definition.workspaceId ?? 'none'], ['enabled', definition.enabled ? 'yes' : 'no'],
    ['timezone', definition.timezone], ['schedule', scheduleLabel(definition.rrule)], ['rrule', definition.rrule],
    ['nextRunAt', definition.enabled ? displayTime(definition.nextRunAt) : 'Paused'],
    ['prompt', definition.prompt]
  ]
  return pairs.map(([key, value]) => `${key}: ${value}`).join('\n')
}

function runLine(run: AutomationRun): string {
  const dispatch = run.dispatchState
    ? `  ${run.dispatchState.reused ? 'reused' : 'new'} structured session (cursor ${run.dispatchState.messageCursor})`
    : ''
  return `${run.id}  ${run.title}  ${run.status}  ${run.trigger}  ${displayTime(run.scheduledFor)}${dispatch}`
}

async function list(args: CliArgs, ctx: CliContext): Promise<void> {
  assertKnownFlags(args.flags, [], ctx)
  positionals(args, 0, ctx)
  const definitions = await ctx.call('quirky.automations/list', {}) as AutomationDefinition[]
  const rows: string[][] = []
  for (const definition of definitions) {
    rows.push([
      definition.id,
      definition.name,
      definition.agentId,
      ownerLabel(definition),
      definition.enabled ? 'enabled' : 'disabled',
      scheduleLabel(definition.rrule),
      definition.enabled ? displayTime(definition.nextRunAt) : 'Paused'
    ])
  }
  ctx.out.result(definitions, () => ctx.format.table(['ID', 'NAME', 'PROVIDER', 'TARGET', 'STATE', 'SCHEDULE', 'NEXT RUN'], rows))
}

async function show(args: CliArgs, ctx: CliContext): Promise<void> {
  assertKnownFlags(args.flags, ['id'], ctx)
  const id = idOf(args, ctx)
  const definition = await ctx.call('quirky.automations/show', { id }) as AutomationDefinition
  ctx.out.result(definition, () => definitionText(definition))
}

async function create(args: CliArgs, ctx: CliContext): Promise<void> {
  assertKnownFlags(args.flags, createFlags, ctx)
  positionals(args, 0, ctx)
  const params = await definitionInput(args, ctx, 'create')
  const definition = await ctx.call('quirky.automations/create', params) as AutomationDefinition
  ctx.out.result(definition, () => `Created automation ${definition.id} (${definition.name}).\n${definitionSummary(definition)}`)
}

async function edit(args: CliArgs, ctx: CliContext): Promise<void> {
  assertKnownFlags(args.flags, editFlags, ctx)
  const id = idOf(args, ctx)
  const model = stringFlag(args.flags, 'model', ctx)
  const effort = stringFlag(args.flags, 'effort', ctx)
  const clearsAllOverrides = model?.toLowerCase() === 'inherit' && effort?.toLowerCase() === 'inherit'
    && !own(args.flags, 'provider') && Object.keys(args.flags).every((name) => name === 'model' || name === 'effort')
  const old = clearsAllOverrides ? undefined : await ctx.call('quirky.automations/show', { id }) as AutomationDefinition
  const patch = await definitionInput(args, ctx, 'edit', old)
  const definition = await ctx.call('quirky.automations/edit', { id, ...patch, ...expectedOwnerInput(args.flags, ctx) }) as AutomationDefinition
  ctx.out.result(definition, () => `Updated automation ${definition.id} (${definition.name}).\n${definitionSummary(definition)}`)
}

async function remove(args: CliArgs, ctx: CliContext): Promise<void> {
  assertKnownFlags(args.flags, ['id', 'expectedOwner'], ctx)
  const id = idOf(args, ctx)
  const result = await ctx.call('quirky.automations/remove', { id, ...expectedOwnerInput(args.flags, ctx) })
  ctx.out.result(result, () => `Removed automation ${id} and its run history.`)
}

async function run(args: CliArgs, ctx: CliContext): Promise<void> {
  assertKnownFlags(args.flags, ['id', 'expectedOwner'], ctx)
  const id = idOf(args, ctx)
  const result = await ctx.call('quirky.automations/run', { id, ...expectedOwnerInput(args.flags, ctx) }) as AutomationRun
  ctx.out.result(result, () => `Run ${result.id} is ${result.status}.\nHistory: quirky automations runs --id ${id}`)
}

async function target(args: CliArgs, ctx: CliContext): Promise<void> {
  assertKnownFlags(args.flags, ['id'], ctx)
  const id = idOf(args, ctx)
  const result = await ctx.call('quirky.automations/target', { id }) as {
    available: boolean
    target?: { repoId: string; repoPath: string; cwd: string; workspaceId: string | null }
    error?: string
  }
  ctx.out.result(result, () => result.available
    ? `Target ${result.target!.repoId} at ${result.target!.cwd}.`
    : `Target unavailable: ${result.error ?? 'No reason was returned.'}`)
}

async function dispatch(args: CliArgs, ctx: CliContext): Promise<void> {
  assertKnownFlags(args.flags, ['runId'], ctx)
  if (args.positionals.length > 1) usage(ctx, 'Provide at most one run ID.')
  const positional = args.positionals[0]
  const flagRunId = stringFlag(args.flags, 'runId', ctx)
  if (positional !== undefined && flagRunId !== undefined) usage(ctx, 'Provide the run ID either positionally or with --run-id, not both.')
  const runId = positional ?? flagRunId
  if (typeof runId !== 'string' || runId.trim() === '') usage(ctx, 'A run ID is required.')
  const result = await ctx.call('quirky.automations/dispatch', { runId: runId.trim() }) as AutomationRun
  ctx.out.result(result, () => `Run ${result.id} is ${result.status}.`)
}

function isReplyTooLarge(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ('code' in error && (error.code === 'reply_too_large' || error.code === 'reply-too-large')) return true
  if ('name' in error && error.name === 'ReplyTooLargeError') return true
  if ('data' in error && typeof error.data === 'object' && error.data !== null
    && 'code' in error.data && (error.data.code === 'reply_too_large' || error.data.code === 'reply-too-large')) return true
  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
  return /(?:reply|response)[\s\S]{0,64}too[\s_-]*(?:large|big)|too[\s_-]*(?:large|big)[\s\S]{0,64}(?:reply|response)/i.test(message)
}

async function fetchRunPage(
  ctx: CliContext,
  automationId: string | undefined,
  limit: number,
  cursor: string | undefined
): Promise<AutomationRunsPage> {
  return await ctx.call('quirky.automations/runs', {
    ...(automationId === undefined ? {} : { automationId }), limit,
    ...(cursor === undefined ? {} : { cursor })
  }) as AutomationRunsPage
}

async function runs(args: CliArgs, ctx: CliContext): Promise<void> {
  assertKnownFlags(args.flags, ['id', 'limit', 'cursor'], ctx)
  if (args.positionals.length > 1) usage(ctx, 'Provide at most one automation ID filter.')
  const positional = args.positionals[0]
  const flagId = stringFlag(args.flags, 'id', ctx)
  if (positional !== undefined && flagId !== undefined) usage(ctx, 'Provide the automation filter either positionally or with --id, not both.')
  const automationId = positional ?? flagId
  const rawLimit = numericFlag(args.flags, 'limit', ctx)
  const limit = rawLimit === undefined ? undefined : Math.max(1, Math.min(100, rawLimit))
  const cursor = stringFlag(args.flags, 'cursor', ctx)
  const explicitPage = limit !== undefined || cursor !== undefined
  let page: AutomationRunsPage
  if (explicitPage) {
    page = await fetchRunPage(ctx, automationId, limit ?? 100, cursor)
  } else {
    const collected: AutomationRun[] = []
    let nextCursor: string | null = null
    let pageCursor: string | undefined
    let pageSize = 25
    while (true) {
      try {
        const current = await fetchRunPage(ctx, automationId, pageSize, pageCursor)
        collected.push(...current.runs)
        nextCursor = current.nextCursor
        pageCursor = current.nextCursor ?? undefined
      } catch (error) {
        if (!isReplyTooLarge(error) || pageSize <= 1) throw error
        pageSize = Math.max(1, Math.floor(pageSize / 2))
        continue
      }
      if (pageCursor === undefined) break
    }
    page = { runs: collected, nextCursor }
  }
  ctx.out.result(page, () => {
    const text = page.runs.map(runLine).join('\n') || 'No runs.'
    return page.nextCursor === null ? text : `${text}\nNext page: --cursor ${page.nextCursor}`
  })
}

function command(handler: (args: CliArgs, ctx: CliContext) => Promise<void>) {
  return async (args: CliArgs, ctx: CliContext): Promise<void> => {
    const flags: Flags = Object.create(null)
    for (const [name, value] of Object.entries(args.flags)) {
      const normalized = name.replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())
      if (Object.hasOwn(flags, normalized)) usage(ctx, `Flag --${name} was supplied more than once.`)
      flags[normalized] = value
    }
    await handler({ ...args, flags }, ctx)
  }
}

export const commands: CliModule['commands'] = {
  ...uiCommands,
  list: command(list),
  show: command(show),
  create: command(create),
  edit: command(edit),
  remove: command(remove),
  run: command(run),
  runs: command(runs),
  target: command(target),
  dispatch: command(dispatch)
}
