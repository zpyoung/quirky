import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { PluginContext, PluginStore } from '@quirky/protocol'
import type {
  AutomationDefinition,
  AutomationPrecheck,
  AutomationRun,
  AutomationRunPatch,
  AutomationRunsPage,
  ScheduleDescription
} from './types'
import {
  describeAutomationSchedule,
  isRunnableAutomationSchedule,
  isValidAutomationSchedule,
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from './schedule'
import { AutomationStoreError, PrunedAutomationOccurrenceError, createAutomationStore, migrations } from './store'
import type { AutomationDispatcher, AutomationDispatchHooks, AutomationServiceOptions, AutomationTargetResolution } from './dispatch-contract'

const TICK_INTERVAL_MS = 60_000
const MISSED_JITTER_ALLOWANCE_MS = 120_000
const MISSED_RUN_ERROR = 'This run was past its missed-run grace window when Orca next checked.'
const UNEVALUABLE_SCHEDULE_ERROR = 'Orca could not evaluate this automation and skipped the occurrence.'
const MAX_NAME_LENGTH = 256
const MAX_PROMPT_LENGTH = 64 * 1024
const MAX_ID_LENGTH = 512
const MAX_TIMEZONE_LENGTH = 128
const MAX_RRULE_LENGTH = 2048
const MAX_BRANCH_LENGTH = 256
const MAX_CREATION_KEY_LENGTH = 256
const MAX_PRECHECK_LENGTH = 4096
const MAX_MODEL_LENGTH = 128
const MAX_OPTION_COUNT = 16
const MAX_OPTION_VALUE_LENGTH = 128
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_JSON_RECORD_BYTES = 64 * 1024
const MAX_SAFE_GRACE_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60_000)
const RUN_STATUSES: Record<AutomationRun['status'], true> = {
  pending: true, dispatching: true, dispatched: true, completed: true, skipped_precheck: true,
  skipped_missed: true, skipped_unavailable: true, skipped_needs_interactive_auth: true, dispatch_failed: true
}

type Params = Record<string, unknown>
type RunReason = 'definition' | 'run'
type ServiceResult = { now: number; evaluated: number }
type ScheduleInspection = {
  valid: boolean
  runnable: boolean
  description: ScheduleDescription
  next: number | null
  latest: number | null
}
type LaunchOverrides = NonNullable<AutomationDefinition['launchOverrides']>

export type AutomationServiceContext = Pick<PluginContext, 'pluginId' | 'openStore' | 'emit' | 'error' | 'log'> & Partial<Pick<PluginContext, 'call'>>
export type AutomationService = {
  list(params: Params): AutomationDefinition[]
  show(params: Params): AutomationDefinition
  create(params: Params): Promise<AutomationDefinition>
  edit(params: Params): Promise<AutomationDefinition>
  remove(params: Params): Promise<{ id: string; removed: true }>
  run(params: Params): Promise<AutomationRun>
  runs(params: Params): AutomationRunsPage
  schedule(params: Params): ScheduleInspection
  target(params: Params): Promise<AutomationTargetResolution>
  dispatch(params: Params): Promise<AutomationRun>
  tick(): Promise<ServiceResult>
  claim(params: Params): Promise<AutomationRun>
  updateRun(params: Params): Promise<AutomationRun>
  start(): Promise<void>
  dispose(): void
}

function isPlainRecord(value: unknown): value is Params {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}
function utf8PrefixLength(value: string, maximumBytes: number): number {
  let bytes = 0
  let end = 0
  while (end < value.length) {
    const first = value.charCodeAt(end)
    let sequenceBytes = first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3
    let codeUnits = 1
    if (first >= 0xd800 && first <= 0xdbff && end + 1 < value.length) {
      const second = value.charCodeAt(end + 1)
      if (second >= 0xdc00 && second <= 0xdfff) {
        sequenceBytes = 4
        codeUnits = 2
      }
    }
    if (bytes + sequenceBytes > maximumBytes) break
    bytes += sequenceBytes
    end += codeUnits
  }
  return end
}

function errorKind(value: unknown): value is AutomationStoreError {
  return value instanceof AutomationStoreError
}


function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

function empty(value: string): boolean {
  return value.trim().length === 0
}

function throwStoreError(context: AutomationServiceContext, error: unknown): never {
  if (errorKind(error)) throw context.error(error.code, error.message)
  throw error
}

function checkRecord(context: AutomationServiceContext, value: unknown, label: string): Params {
  if (!isPlainRecord(value)) throw context.error('invalid-params', `${label} must be an object.`)
  return value
}

function checkFields(context: AutomationServiceContext, value: Params, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw context.error('invalid-params', `${label}.${key} is not allowed.`)
  }
}

function requiredString(
  context: AutomationServiceContext,
  value: unknown,
  label: string,
  maximum = MAX_ID_LENGTH,
  trim = true
): string {
  if (typeof value !== 'string') throw context.error('invalid-params', `${label} must be a string.`)
  const normalized = trim ? value.trim() : value
  if (empty(normalized)) throw context.error('invalid-params', `${label} must not be blank.`)
  if (normalized.length > maximum) throw context.error('invalid-params', `${label} must be at most ${maximum} characters.`)
  return normalized
}

function nullableString(
  context: AutomationServiceContext,
  value: unknown,
  label: string,
  maximum: number
): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw context.error('invalid-params', `${label} must be a string or null.`)
  const normalized = value.trim()
  if (normalized.length > maximum) throw context.error('invalid-params', `${label} must be at most ${maximum} characters.`)
  return normalized || null
}

function optionalBoolean(context: AutomationServiceContext, value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw context.error('invalid-params', `${label} must be a boolean.`)
  return value
}

function epoch(context: AutomationServiceContext, value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw context.error('invalid-params', `${label} must be a non-negative safe integer timestamp.`)
  }
  return value
}

function objectOrNull(context: AutomationServiceContext, value: unknown, label: string): Params | null {
  if (value === null) return null
  if (!isPlainRecord(value)) throw context.error('invalid-params', `${label} must be an object or null.`)
  return value
}

function normalizedContext(context: AutomationServiceContext, value: unknown, label: string): Params | null {
  const result = objectOrNull(context, value, label)
  if (result === null) return null
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw context.error('invalid-params', `${label} must contain serializable JSON.`)
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_RECORD_BYTES) {
    throw context.error('invalid-params', `${label} must be at most ${MAX_JSON_RECORD_BYTES} JSON bytes.`)
  }
  // Copy enumerable JSON fields so the service never retains caller-owned mutable records.
  return { ...result }
}

function normalizedOverrides(context: AutomationServiceContext, value: unknown): LaunchOverrides | null {
  if (value === null) return null
  const object = objectOrNull(context, value, 'launchOverrides')
  if (object === null) return null
  checkFields(context, object, ['model', 'optionValues'], 'launchOverrides')
  const result: LaunchOverrides = {}
  if (object.model !== undefined) result.model = requiredString(context, object.model, 'launchOverrides.model', MAX_MODEL_LENGTH)
  if (object.optionValues !== undefined) {
    if (!isPlainRecord(object.optionValues)) throw context.error('invalid-params', 'launchOverrides.optionValues must be an object.')
    const options = object.optionValues
    const names = Object.keys(options)
    if (names.length > MAX_OPTION_COUNT) throw context.error('invalid-params', `launchOverrides.optionValues supports at most ${MAX_OPTION_COUNT} values.`)
    const normalized: Record<string, string | boolean> = {}
    for (const name of names) {
      if (empty(name) || name.length > MAX_OPTION_VALUE_LENGTH) throw context.error('invalid-params', 'Launch option IDs must contain 1 to 128 characters.')
      const option = options[name]
      if (typeof option === 'string') normalized[name] = requiredString(context, option, `launchOverrides.optionValues.${name}`, MAX_OPTION_VALUE_LENGTH)
      else if (typeof option === 'boolean') normalized[name] = option
      else throw context.error('invalid-params', `launchOverrides.optionValues.${name} must be a string or boolean.`)
    }
    if (names.length > 0) result.optionValues = normalized
  }
  return Object.keys(result).length === 0 ? null : result
}

function normalizedPrecheck(context: AutomationServiceContext, value: unknown): AutomationPrecheck | null {
  if (value === null) return null
  const object = objectOrNull(context, value, 'precheck')
  if (object === null) return null
  checkFields(context, object, ['command', 'timeoutSeconds'], 'precheck')
  if (typeof object.command !== 'string') throw context.error('invalid-params', 'precheck.command must be a string.')
  const command = object.command.trim()
  if (command.length > MAX_PRECHECK_LENGTH) throw context.error('invalid-params', `precheck.command must be at most ${MAX_PRECHECK_LENGTH} characters.`)
  const timeoutValue = object.timeoutSeconds === undefined ? 60 : object.timeoutSeconds
  if (typeof timeoutValue !== 'number' || !Number.isSafeInteger(timeoutValue)) {
    throw context.error('invalid-params', 'precheck.timeoutSeconds must be an integer.')
  }
  if (empty(command)) return null
  return { command, timeoutSeconds: Math.max(1, Math.min(600, timeoutValue)) }
}

function normalizedName(context: AutomationServiceContext, value: unknown, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string') throw context.error('invalid-params', 'name must be a string.')
  const name = value.trim()
  if (name.length > MAX_NAME_LENGTH) throw context.error('invalid-params', `name must be at most ${MAX_NAME_LENGTH} characters.`)
  return name || 'Untitled automation'
}

function normalizedPrompt(context: AutomationServiceContext, value: unknown, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || empty(value)) throw context.error('invalid-params', 'prompt must be a non-empty string.')
  if (value.length > MAX_PROMPT_LENGTH) throw context.error('invalid-params', `prompt must be at most ${MAX_PROMPT_LENGTH} characters.`)
  return value
}

function normalizedProvider(context: AutomationServiceContext, value: unknown, optional = false): AutomationDefinition['agentId'] | undefined {
  if (value === undefined && optional) return undefined
  if (value !== 'claude' && value !== 'codex') throw context.error('invalid-params', 'agentId must be claude or codex.')
  return value
}

function normalizedProjectId(context: AutomationServiceContext, value: unknown, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  return requiredString(context, value, 'projectId')
}

function normalizedTimezone(context: AutomationServiceContext, value: unknown, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  const timezone = requiredString(context, value, 'timezone', MAX_TIMEZONE_LENGTH)
  if (!validTimezone(timezone)) throw context.error('invalid-params', `timezone is not a valid IANA timezone: ${timezone}`)
  return timezone
}

function normalizedRule(context: AutomationServiceContext, value: unknown, timezone: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined
  const rule = requiredString(context, value, 'rrule', MAX_RRULE_LENGTH)
  if (!isValidAutomationSchedule(rule, timezone)) throw context.error('invalid-params', 'Invalid automation schedule.')
  return rule
}

function normalizedGrace(context: AutomationServiceContext, value: unknown, optional = false): number | undefined {
  if (value === undefined) return optional ? undefined : 720
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_GRACE_MINUTES) {
    throw context.error('invalid-params', `missedRunGraceMinutes must be an integer from 0 to ${MAX_SAFE_GRACE_MINUTES}.`)
  }
  return value
}

function validWorkspaceMode(context: AutomationServiceContext, value: unknown): AutomationDefinition['workspaceMode'] {
  if (value !== 'existing' && value !== 'new_per_run') throw context.error('invalid-params', 'workspaceMode must be existing or new_per_run.')
  return value
}

function optionalEpoch(context: AutomationServiceContext, value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : epoch(context, value, label)
}

function normalizedDefinitionInput(
  context: AutomationServiceContext,
  input: Params,
  now: number,
  current?: AutomationDefinition
): Partial<AutomationDefinition> {
  const creating = current === undefined
  const allowed = [
    'creationKey', 'name', 'prompt', 'agentId', 'projectId', 'workspaceMode', 'workspaceId', 'baseBranch', 'setupDecision',
    'reuseSession', 'runContext', 'sourceContext', 'launchOverrides', 'precheck', 'timezone', 'rrule', 'dtstart', 'enabled',
    'missedRunGraceMinutes', 'extraAgentArgs'
  ]
  checkFields(context, input, allowed, creating ? 'definition' : 'patch')

  const result: Partial<AutomationDefinition> = {}
  const name = creating && input.name === undefined ? 'Untitled automation' : normalizedName(context, input.name, !creating)
  if (name !== undefined) result.name = name
  const prompt = normalizedPrompt(context, input.prompt, !creating)
  if (prompt !== undefined) result.prompt = prompt
  const agentId = normalizedProvider(context, input.agentId, !creating)
  if (agentId !== undefined) result.agentId = agentId
  const projectId = normalizedProjectId(context, input.projectId, !creating)
  if (projectId !== undefined) result.projectId = projectId

  const timezone = normalizedTimezone(context, input.timezone, true) ?? current?.timezone ?? defaultTimezone()
  if (input.timezone !== undefined || creating) result.timezone = timezone
  const rrule = normalizedRule(context, input.rrule, timezone, !creating)
  if (rrule !== undefined) result.rrule = rrule
  const explicitDtstart = optionalEpoch(context, input.dtstart, 'dtstart')
  const scheduleChanged = creating || (rrule !== undefined && rrule !== current?.rrule) || (explicitDtstart !== undefined && explicitDtstart !== current?.dtstart)
  const timezoneChanged = creating || (input.timezone !== undefined && timezone !== current?.timezone)
  if (explicitDtstart !== undefined) result.dtstart = explicitDtstart
  else if (creating || scheduleChanged) result.dtstart = now

  if (creating) {
    const workspaceMode = input.workspaceMode === undefined
      ? (input.workspaceId !== undefined && input.workspaceId !== null ? 'existing' : 'new_per_run')
      : validWorkspaceMode(context, input.workspaceMode)
    const workspaceId = input.workspaceId === undefined ? null : nullableString(context, input.workspaceId, 'workspaceId', MAX_ID_LENGTH)
    if (workspaceMode === 'existing' && (workspaceId === null || workspaceId === undefined)) {
      throw context.error('invalid-params', 'workspaceMode existing requires workspaceId.')
    }
    result.workspaceMode = workspaceMode
    result.workspaceId = workspaceMode === 'existing' ? workspaceId : null
    const baseBranch = input.baseBranch === undefined ? null : nullableString(context, input.baseBranch, 'baseBranch', MAX_BRANCH_LENGTH)
    const setupDecision = input.setupDecision
    if (setupDecision !== undefined && setupDecision !== null && setupDecision !== 'run' && setupDecision !== 'skip') {
      throw context.error('invalid-params', 'setupDecision must be run or skip.')
    }
    result.baseBranch = workspaceMode === 'existing' ? null : baseBranch
    if (workspaceMode === 'existing') {
      result.setupDecision = undefined
    } else if (setupDecision === null) {
      throw context.error('invalid-params', 'setupDecision must be run or skip.')
    } else if (setupDecision !== undefined) {
      result.setupDecision = setupDecision
    }
    const requestedReuse = optionalBoolean(context, input.reuseSession, 'reuseSession') ?? false
    result.reuseSession = workspaceMode === 'existing' && requestedReuse
  } else {
    const workspaceMode = input.workspaceMode === undefined ? current.workspaceMode : validWorkspaceMode(context, input.workspaceMode)
    const workspaceIdInput = input.workspaceId === undefined ? current.workspaceId : nullableString(context, input.workspaceId, 'workspaceId', MAX_ID_LENGTH)
    if (workspaceMode === 'existing' && (workspaceIdInput === null || workspaceIdInput === undefined)) {
      throw context.error('invalid-params', 'workspaceMode existing requires workspaceId.')
    }
    if (input.workspaceMode !== undefined || input.workspaceId !== undefined) {
      result.workspaceMode = workspaceMode
      result.workspaceId = workspaceMode === 'existing' ? workspaceIdInput : null
    }
    if (workspaceMode === 'existing') {
      if (input.baseBranch !== undefined) nullableString(context, input.baseBranch, 'baseBranch', MAX_BRANCH_LENGTH)
      if (input.setupDecision !== undefined && input.setupDecision !== 'run' && input.setupDecision !== 'skip') {
        throw context.error('invalid-params', 'setupDecision must be run or skip.')
      }
      result.workspaceMode = 'existing'
      result.baseBranch = null
      result.setupDecision = undefined
      const reuse = optionalBoolean(context, input.reuseSession, 'reuseSession')
      if (reuse !== undefined) result.reuseSession = reuse
    } else {
      if (input.baseBranch !== undefined) result.baseBranch = nullableString(context, input.baseBranch, 'baseBranch', MAX_BRANCH_LENGTH)
      else if (current.workspaceMode === 'existing' || input.workspaceMode !== undefined) result.baseBranch = null
      if (input.setupDecision !== undefined) {
        if (input.setupDecision === null) throw context.error('invalid-params', 'setupDecision must be run or skip.')
        if (input.setupDecision === 'run' || input.setupDecision === 'skip') result.setupDecision = input.setupDecision
        else throw context.error('invalid-params', 'setupDecision must be run or skip.')
      } else if (current.workspaceMode === 'existing' || input.workspaceMode !== undefined) {
        result.setupDecision = undefined
      }
      const reuse = optionalBoolean(context, input.reuseSession, 'reuseSession')
      if (reuse !== undefined || current.workspaceMode === 'existing' || input.workspaceMode !== undefined) result.reuseSession = false
    }
  }

  if (input.runContext !== undefined || creating) result.runContext = normalizedContext(context, input.runContext ?? null, 'runContext')
  if (input.sourceContext !== undefined || creating) result.sourceContext = normalizedContext(context, input.sourceContext ?? null, 'sourceContext')
  if (input.launchOverrides !== undefined || creating) result.launchOverrides = normalizedOverrides(context, input.launchOverrides ?? null)
  else if (!creating && input.agentId !== undefined && agentId !== current.agentId) result.launchOverrides = null
  if (input.precheck !== undefined || creating) result.precheck = normalizedPrecheck(context, input.precheck ?? null)

  const enabled = optionalBoolean(context, input.enabled, 'enabled')
  if (enabled !== undefined || creating) result.enabled = enabled ?? true
  const grace = normalizedGrace(context, input.missedRunGraceMinutes, !creating)
  if (grace !== undefined || creating) result.missedRunGraceMinutes = grace ?? 720

  if (creating) {
    const creationKey = input.creationKey === undefined
      ? undefined
      : requiredString(context, input.creationKey, 'creationKey', MAX_CREATION_KEY_LENGTH)
    if (creationKey) result.creationKey = creationKey
    result.missedRunPolicy = 'run_once_within_grace'
  } else if (input.creationKey !== undefined) {
    throw context.error('invalid-params', 'creationKey cannot be changed.')
  }

  if (scheduleChanged || timezoneChanged) {
    const effectiveRule = result.rrule ?? current?.rrule
    if (!effectiveRule) throw context.error('invalid-params', 'rrule is required.')
    const validInput = creating || input.rrule !== undefined
      ? isValidAutomationSchedule(effectiveRule, timezone)
      : isRunnableAutomationSchedule(effectiveRule, timezone)
    if (!validInput) throw context.error('invalid-params', 'Invalid automation schedule.')
    result.nextRunAt = nextAutomationOccurrenceAfter(effectiveRule, result.dtstart ?? current?.dtstart ?? now, now, timezone)
  }
  return result
}

function idParam(context: AutomationServiceContext, params: unknown, method: string): { object: Params; id: string } {
  const object = checkRecord(context, params, method)
  checkFields(context, object, ['id'], method)
  return { object, id: requiredString(context, object.id, `${method}.id`) }
}

function throwNotFound(context: AutomationServiceContext, kind: string, id: string): never {
  throw context.error('not-found', `${kind} ${id} was not found.`)
}

function outputSnapshot(context: AutomationServiceContext, value: unknown): AutomationRunPatch['outputSnapshot'] {
  if (value === null) return null
  const object = objectOrNull(context, value, 'patch.outputSnapshot')
  if (object === null) return null
  checkFields(context, object, ['format', 'content', 'capturedAt', 'truncated'], 'patch.outputSnapshot')
  if (object.format !== 'plain_text') throw context.error('invalid-params', 'patch.outputSnapshot.format must be plain_text.')
  if (typeof object.content !== 'string') throw context.error('invalid-params', 'patch.outputSnapshot.content must be a string.')
  const capturedAt = epoch(context, object.capturedAt, 'patch.outputSnapshot.capturedAt')
  const truncated = optionalBoolean(context, object.truncated, 'patch.outputSnapshot.truncated')
  let content = object.content
  let wasTruncated = truncated ?? false
  if (byteLength(content) > MAX_OUTPUT_BYTES) {
    content = content.slice(0, utf8PrefixLength(content, MAX_OUTPUT_BYTES))
    wasTruncated = true
  }
  return { format: 'plain_text', content, capturedAt, truncated: wasTruncated }
}

function runPatch(context: AutomationServiceContext, value: unknown): AutomationRunPatch {
  const patch = checkRecord(context, value, 'patch')
  checkFields(context, patch, [
    'status', 'workspaceId', 'workspaceDisplayName', 'sessionId', 'launchSettings', 'outputSnapshot', 'precheckResult', 'usage', 'error'
  ], 'patch')
  const result: AutomationRunPatch = {}
  if (patch.status !== undefined) {
    if (typeof patch.status !== 'string' || !Object.hasOwn(RUN_STATUSES, patch.status)) {
      throw context.error('invalid-params', 'patch.status is not a supported run status.')
    }
    result.status = patch.status as AutomationRun['status']
  }
  if (patch.workspaceId !== undefined) result.workspaceId = nullableString(context, patch.workspaceId, 'patch.workspaceId', MAX_ID_LENGTH)
  if (patch.workspaceDisplayName !== undefined) result.workspaceDisplayName = nullableString(context, patch.workspaceDisplayName, 'patch.workspaceDisplayName', MAX_NAME_LENGTH)
  if (patch.sessionId !== undefined) result.sessionId = nullableString(context, patch.sessionId, 'patch.sessionId', MAX_ID_LENGTH)
  if (patch.launchSettings !== undefined) result.launchSettings = normalizedContext(context, patch.launchSettings, 'patch.launchSettings')
  if (patch.outputSnapshot !== undefined) result.outputSnapshot = outputSnapshot(context, patch.outputSnapshot)
  for (const name of ['precheckResult', 'usage'] as const) {
    if (patch[name] !== undefined) result[name] = normalizedContext(context, patch[name], `patch.${name}`)
  }
  if (patch.error !== undefined) {
    if (patch.error === null) result.error = null
    else {
      if (typeof patch.error !== 'string') throw context.error('invalid-params', 'patch.error must be a string or null.')
      if (patch.error.length > MAX_PROMPT_LENGTH) throw context.error('invalid-params', `patch.error must be at most ${MAX_PROMPT_LENGTH} characters.`)
      result.error = patch.error
    }
  }
  return result
}

function inspection(context: AutomationServiceContext, params: unknown, now: () => number): ScheduleInspection {
  const object = checkRecord(context, params, 'schedule')
  checkFields(context, object, ['rrule', 'timezone', 'dtstart', 'after', 'now'], 'schedule')
  const timezone = normalizedTimezone(context, object.timezone)!
  const rule = requiredString(context, object.rrule, 'schedule.rrule', MAX_RRULE_LENGTH)
  const dtstart = epoch(context, object.dtstart, 'schedule.dtstart')
  const after = epoch(context, object.after, 'schedule.after')
  const current = object.now === undefined ? now() : epoch(context, object.now, 'schedule.now')
  const valid = isValidAutomationSchedule(rule, timezone)
  const runnable = isRunnableAutomationSchedule(rule, timezone)
  const description = describeAutomationSchedule(rule)
  return {
    valid,
    runnable,
    description,
    next: runnable ? nextAutomationOccurrenceAfter(rule, dtstart, after, timezone) : null,
    latest: runnable ? latestAutomationOccurrenceAtOrBefore(rule, dtstart, current, timezone) : null
  }
}

function mutationEvent(context: AutomationServiceContext, reason: RunReason, automationId: string, extras: Params = {}): void {
  context.emit('changed', { reason, automationId, ...extras })
}

function runInLane<T>(lanes: Map<string, Promise<void>>, id: string, work: () => T | Promise<T>): Promise<T> {
  const previous = lanes.get(id) ?? Promise.resolve()
  const current = previous.then(work, work)
  const settled = current.then(() => undefined, () => undefined)
  lanes.set(id, settled)
  return current.finally(() => {
    if (lanes.get(id) === settled) lanes.delete(id)
  })
}

function handleError<T>(context: AutomationServiceContext, work: () => T): T {
  try {
    return work()
  } catch (error) {
    return throwStoreError(context, error)
  }
}

function handleAsyncError<T>(context: AutomationServiceContext, work: () => Promise<T>): Promise<T> {
  return work().catch((error) => throwStoreError(context, error))
}

export function createAutomationService(
  context: AutomationServiceContext,
  clock: () => number = Date.now,
  options: AutomationServiceOptions = {}
): AutomationService {
  const database: PluginStore = context.openStore(migrations)
  const store = createAutomationStore(database)
  const lanes = new Map<string, Promise<void>>()
  const targets = options.targets
  if (options.createDispatcher && !targets) {
    throw context.error('invalid-params', 'An automation dispatcher requires a target resolver.')
  }
  const hooks: AutomationDispatchHooks | undefined = targets ? {
    store,
    targets,
    clock,
    inLane: <T>(automationId: string, work: () => T | Promise<T>) => runInLane(lanes, automationId, work),
    changed: (automationId, runId) => mutationEvent(context, 'run', automationId, { runId, action: 'dispatched' })
  } : undefined
  const dispatcher: AutomationDispatcher | undefined = hooks && options.createDispatcher
    ? options.createDispatcher(hooks)
    : undefined
  let evaluating = false
  let started = false
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined

  const rejectExtraAgentArgs = (object: Params): void => {
    if (object.extraAgentArgs === undefined) return
    if (typeof object.extraAgentArgs !== 'string') {
      throw context.error('invalid-params', 'extraAgentArgs must be a string.')
    }
    if (!empty(object.extraAgentArgs)) {
      throw context.error('invalid-params', 'Raw agent arguments are unsupported for structured automation runs.')
    }
  }

  const validateLaunchPicks = async (definition: AutomationDefinition): Promise<void> => {
    const overrides = definition.launchOverrides
    if (!overrides) return
    if (!context.call) {
      if (targets) throw context.error('invalid-params', 'Structured launch validation is unavailable.')
      return
    }
    await context.call('quirky.agents/resolveLaunch', {
      agent: definition.agentId,
      structured: true,
      ...(overrides.model === undefined ? {} : { model: overrides.model }),
      ...(overrides.optionValues === undefined ? {} : { options: overrides.optionValues })
    })
  }

  const captureTarget = async (definition: AutomationDefinition): Promise<AutomationDefinition> => {
    if (!targets) return definition
    const captured = await targets.capture(definition)
    if (!captured.owner) throw context.error('conflict', 'The automation target resolver did not capture a local owner.')
    const runContext = normalizedContext(context, captured.runContext, 'runContext')
    return { ...captured, runContext }
  }

  const assertExpectedOwner = (definition: AutomationDefinition, value: unknown): void => {
    if (value === undefined) return
    if (!targets) throw context.error('conflict', 'The saved owner cannot be checked without a target resolver.')
    targets.assertExpectedOwner(definition, value)
  }

  const list = (params: Params) => handleError(context, () => {
    const object = checkRecord(context, params, 'list')
    checkFields(context, object, [], 'list')
    return store.list().sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  })

  const show = (params: Params) => handleError(context, () => {
    const { id } = idParam(context, params, 'show')
    const definition = store.get(id)
    if (!definition) throw context.error('not-found', `Automation ${id} was not found.`)
    return definition
  })

  const create = (params: Params) => handleAsyncError(context, async () => {
    const object = checkRecord(context, params, 'create')
    checkFields(context, object, [
      'creationKey', 'name', 'prompt', 'agentId', 'projectId', 'workspaceMode', 'workspaceId', 'baseBranch', 'setupDecision',
      'reuseSession', 'runContext', 'sourceContext', 'launchOverrides', 'precheck', 'timezone', 'rrule', 'dtstart', 'enabled',
      'missedRunGraceMinutes', 'extraAgentArgs'
    ], 'create')
    rejectExtraAgentArgs(object)
    const now = clock()
    const key = object.creationKey === undefined ? undefined : requiredString(context, object.creationKey, 'creationKey', MAX_CREATION_KEY_LENGTH)
    const normalized = normalizedDefinitionInput(context, object, now)
    const createInsideLane = async (): Promise<AutomationDefinition> => {
      if (key) {
        const existing = store.findByCreationKey(key)
        if (existing) return existing
      }
      let definition: AutomationDefinition = {
        id: randomUUID(),
        name: normalized.name!,
        prompt: normalized.prompt!,
        agentId: normalized.agentId!,
        projectId: normalized.projectId!,
        workspaceMode: normalized.workspaceMode!,
        workspaceId: normalized.workspaceId ?? null,
        baseBranch: normalized.baseBranch ?? null,
        ...(normalized.setupDecision === undefined ? {} : { setupDecision: normalized.setupDecision }),
        reuseSession: normalized.reuseSession ?? false,
        runContext: normalized.runContext ?? null,
        sourceContext: normalized.sourceContext ?? null,
        launchOverrides: normalized.launchOverrides ?? null,
        precheck: normalized.precheck ?? null,
        timezone: normalized.timezone!,
        rrule: normalized.rrule!,
        dtstart: normalized.dtstart!,
        enabled: normalized.enabled ?? true,
        nextRunAt: normalized.nextRunAt!,
        missedRunPolicy: 'run_once_within_grace',
        missedRunGraceMinutes: normalized.missedRunGraceMinutes ?? 720,
        createdAt: now,
        updatedAt: now,
        ...(normalized.creationKey === undefined ? {} : { creationKey: normalized.creationKey })
      }
      await validateLaunchPicks(definition)
      definition = await captureTarget(definition)
      const saved = store.insert(definition)
      mutationEvent(context, 'definition', saved.id, { action: 'created' })
      return saved
    }
    return key ? runInLane(lanes, `creation:${key}`, createInsideLane) : createInsideLane()
  })

  const edit = (params: Params) => handleAsyncError(context, async () => {
    const object = checkRecord(context, params, 'edit')
    checkFields(context, object, ['id', 'expectedOwner', 'creationKey', 'name', 'prompt', 'agentId', 'projectId', 'workspaceMode',
      'workspaceId', 'baseBranch', 'setupDecision', 'reuseSession', 'runContext', 'sourceContext', 'launchOverrides', 'precheck',
      'timezone', 'rrule', 'dtstart', 'enabled', 'missedRunGraceMinutes', 'extraAgentArgs'], 'edit')
    rejectExtraAgentArgs(object)
    const id = requiredString(context, object.id, 'edit.id')
    const expectedOwner = object.expectedOwner
    const patch = { ...object }
    delete patch.id
    delete patch.expectedOwner
    return runInLane(lanes, id, async () => {
      const current = store.get(id)
      if (!current) throw context.error('not-found', `Automation ${id} was not found.`)
      assertExpectedOwner(current, expectedOwner)
      const now = clock()
      const normalized = normalizedDefinitionInput(context, patch, now, current)
      const changedSchedule = normalized.rrule !== undefined && normalized.rrule !== current.rrule
      const changedTimezone = normalized.timezone !== undefined && normalized.timezone !== current.timezone
      const changedDtstart = normalized.dtstart !== undefined && normalized.dtstart !== current.dtstart
      if (changedSchedule && patch.dtstart === undefined) normalized.dtstart = now
      if (!changedSchedule && patch.dtstart === undefined) delete normalized.dtstart
      if (!changedSchedule && !changedTimezone && !changedDtstart) delete normalized.nextRunAt
      const targetMoved =
        (normalized.projectId !== undefined && normalized.projectId !== current.projectId)
        || (normalized.workspaceMode !== undefined && normalized.workspaceMode !== current.workspaceMode)
        || (normalized.workspaceId !== undefined && normalized.workspaceId !== current.workspaceId)
        || (normalized.runContext !== undefined && JSON.stringify(normalized.runContext) !== JSON.stringify(current.runContext))
      let candidate = { ...current, ...normalized }
      await validateLaunchPicks(candidate)
      if (targetMoved) {
        candidate = await captureTarget(candidate)
        normalized.projectId = candidate.projectId
        normalized.workspaceId = candidate.workspaceId
        normalized.owner = candidate.owner
        normalized.runContext = candidate.runContext
      }
      const saved = store.update(id, { ...normalized, updatedAt: now })
      mutationEvent(context, 'definition', id, { action: 'updated' })
      return saved
    })
  })

  const remove = (params: Params) => handleAsyncError(context, async () => {
    const object = checkRecord(context, params, 'remove')
    checkFields(context, object, ['id', 'yes', 'expectedOwner'], 'remove')
    const id = requiredString(context, object.id, 'remove.id')
    optionalBoolean(context, object.yes, 'remove.yes')
    return runInLane(lanes, id, () => {
      const current = store.get(id)
      if (!current) throw context.error('not-found', `Automation ${id} was not found.`)
      assertExpectedOwner(current, object.expectedOwner)
      if (!store.remove(id)) throw context.error('not-found', `Automation ${id} was not found.`)
      mutationEvent(context, 'definition', id, { action: 'removed' })
      return { id, removed: true as const }
    })
  })

  const run = (params: Params) => handleAsyncError(context, async () => {
    const object = checkRecord(context, params, 'run')
    checkFields(context, object, ['id', 'expectedOwner'], 'run')
    const id = requiredString(context, object.id, 'run.id')
    const created = await runInLane(lanes, id, () => {
      const definition = store.get(id)
      if (!definition) throw context.error('not-found', `Automation ${id} was not found.`)
      assertExpectedOwner(definition, object.expectedOwner)
      const now = clock()
      const run = database.transaction(() => store.createRun(id, { trigger: 'manual', scheduledFor: now, now }))
      mutationEvent(context, 'run', id, { runId: run.id, trigger: 'manual' })
      return run
    })
    if (dispatcher) await dispatcher.dispatch(created.id)
    const current = store.getRun(created.id)
    if (!current) throwNotFound(context, 'Run', created.id)
    return current
  })

  const runs = (params: Params) => handleError(context, () => {
    const object = checkRecord(context, params, 'runs')
    checkFields(context, object, ['automationId', 'limit', 'cursor'], 'runs')
    const automationId = object.automationId === undefined ? undefined : requiredString(context, object.automationId, 'runs.automationId')
    const rawLimit = object.limit
    if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isSafeInteger(rawLimit))) {
      throw context.error('invalid-params', 'runs.limit must be an integer.')
    }
    const limit = rawLimit === undefined ? undefined : Math.max(1, Math.min(100, rawLimit as number))
    const cursor = object.cursor === undefined ? undefined : requiredString(context, object.cursor, 'runs.cursor', MAX_ID_LENGTH)
    return store.runs(automationId, limit, cursor)
  })

  const schedule = (params: Params): ScheduleInspection => handleError(context, () => inspection(context, params, clock))

  const target = (params: Params) => handleAsyncError(context, async () => {
    const { id } = idParam(context, params, 'target')
    if (!targets) throw context.error('conflict', 'Automation target inspection is unavailable.')
    return runInLane(lanes, id, async () => {
      const definition = store.get(id)
      if (!definition) throw context.error('not-found', `Automation ${id} was not found.`)
      return targets.resolve(definition)
    })
  })

  const dispatch = (params: Params) => handleAsyncError(context, async () => {
    const object = checkRecord(context, params, 'dispatch')
    checkFields(context, object, ['runId'], 'dispatch')
    const runId = requiredString(context, object.runId, 'dispatch.runId')
    if (!dispatcher) throw context.error('conflict', 'Automation dispatch is unavailable.')
    const dispatched = await dispatcher.dispatch(runId)
    const current = store.getRun(runId)
    if (!current) throwNotFound(context, 'Run', runId)
    return current ?? dispatched!
  })

  const tick = async (): Promise<ServiceResult> => {
    const now = clock()
    if (disposed || evaluating) return { now, evaluated: 0 }
    evaluating = true
    let evaluated = 0
    const pendingRunIds: string[] = []
    try {
      const due = store.list()
        .filter((definition) => definition.enabled && definition.nextRunAt <= now)
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      await Promise.all(due.map((definition) => runInLane(lanes, definition.id, async () => {
        if (disposed) return
        const current = store.get(definition.id)
        if (!current || !current.enabled || current.nextRunAt > now) return
        evaluated++
        let scheduledFor: number | null
        let nextRunAt: number
        try {
          scheduledFor = latestAutomationOccurrenceAtOrBefore(current.rrule, current.dtstart, now, current.timezone)
          nextRunAt = nextAutomationOccurrenceAfter(current.rrule, current.dtstart, now, current.timezone)
        } catch {
          const skipped = database.transaction(() =>
            store.foldUnavailable(current.id, current.nextRunAt, UNEVALUABLE_SCHEDULE_ERROR, now)
          )
          mutationEvent(context, 'run', current.id, { runId: skipped.id, trigger: 'scheduled', folded: true })
          return
        }
        if (scheduledFor === null) {
          const saved = store.update(current.id, { nextRunAt, updatedAt: now })
          mutationEvent(context, 'definition', saved.id, { action: 'advanced' })
          return
        }
        const missed = now - scheduledFor > current.missedRunGraceMinutes * 60_000 + MISSED_JITTER_ALLOWANCE_MS
        const resolution = !missed && targets ? await targets.resolve(current) : undefined
        if (resolution && !resolution.available && resolution.status === 'skipped_unavailable') {
          const skipped = database.transaction(() => {
            const run = store.foldUnavailable(current.id, scheduledFor!, resolution.error, now)
            store.update(current.id, { nextRunAt, lastRunAt: now, updatedAt: now })
            return run
          })
          mutationEvent(context, 'run', current.id, { runId: skipped.id, trigger: 'scheduled', folded: true })
          return
        }
        const run = database.transaction(() => {
          let created: AutomationRun | null
          try {
            created = store.createRun(current.id, {
              trigger: 'scheduled',
              scheduledFor: scheduledFor!,
              ...(missed ? { status: 'skipped_missed' as const, error: MISSED_RUN_ERROR }
                : resolution && !resolution.available ? { status: resolution.status, error: resolution.error } : {}),
              now
            })
          } catch (error) {
            if (!(error instanceof PrunedAutomationOccurrenceError)) throw error
            created = null
          }
          store.update(current.id, { nextRunAt, ...(created ? { lastRunAt: now } : {}), updatedAt: now })
          return created
        })
        if (run) {
          mutationEvent(context, 'run', current.id, { runId: run.id, trigger: 'scheduled' })
          if (run.status === 'pending') pendingRunIds.push(run.id)
        } else {
          mutationEvent(context, 'definition', current.id, { action: 'advanced' })
        }
      }).catch((error: unknown) => {
        context.log(`scheduler failed for ${definition.id}: ${error instanceof Error ? error.message : String(error)}`)
      })))
      if (dispatcher) {
        await Promise.all(pendingRunIds.map(async (runId) => {
          try {
            await dispatcher.dispatch(runId)
          } catch (error) {
            context.log(`automation dispatch failed for ${runId}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }))
      }
      return { now, evaluated }
    } finally {
      evaluating = false
    }
  }

  const claim = (params: Params) => handleAsyncError(context, async () => {
    const object = checkRecord(context, params, 'claim')
    checkFields(context, object, ['runId'], 'claim')
    const runId = requiredString(context, object.runId, 'claim.runId')
    const existing = store.getRun(runId)
    if (!existing) throwNotFound(context, 'Run', runId)
    if (dispatcher) {
      const claimed = await dispatcher.dispatch(runId)
      const current = store.getRun(runId)
      if (!current) throwNotFound(context, 'Run', runId)
      return current ?? claimed!
    }
    return runInLane(lanes, existing.automationId, () => {
      const current = store.getRun(runId)
      if (!current) throwNotFound(context, 'Run', runId)
      const now = clock()
      const run = database.transaction(() => store.claimRun(runId, now))
      mutationEvent(context, 'run', current.automationId, { runId: run.id, action: 'claimed' })
      return run
    })
  })

  const updateRun = (params: Params) => handleAsyncError(context, async () => {
    const object = checkRecord(context, params, 'updateRun')
    checkFields(context, object, ['runId', 'patch'], 'updateRun')
    const runId = requiredString(context, object.runId, 'updateRun.runId')
    if (dispatcher) throw context.error('conflict', 'Run lifecycle evidence is owned by the automation dispatcher.')
    const patch = runPatch(context, object.patch)
    const existing = store.getRun(runId)
    if (!existing) throwNotFound(context, 'Run', runId)
    return runInLane(lanes, existing.automationId, () => {
      const current = store.getRun(runId)
      if (!current) throwNotFound(context, 'Run', runId)
      const now = clock()
      const run = database.transaction(() => store.updateRun(runId, patch, now))
      mutationEvent(context, 'run', current.automationId, { runId: run.id, action: 'updated' })
      return run
    })
  })

  const service: AutomationService = {
    list,
    show,
    create,
    edit,
    remove,
    run,
    runs,
    schedule,
    target,
    dispatch,
    tick,
    claim,
    updateRun,
    async start() {
      if (started || disposed) return
      started = true
      store.prune()
      await dispatcher?.start()
      timer = setInterval(() => {
        void tick().catch((error) => context.log(`scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`))
      }, TICK_INTERVAL_MS)
      await tick()
    },
    dispose() {
      if (disposed) return
      dispatcher?.dispose()
      disposed = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    }
  }
  return service
}
