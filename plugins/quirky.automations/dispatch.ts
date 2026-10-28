import { Buffer } from 'node:buffer'
import type { Session, StructuredMessage, WorktreeCreateResult } from '@quirky/protocol'
import type {
  AutomationDefinition,
  AutomationRun,
  AutomationRunPatch
} from './types'
import {
  AUTOMATION_FINAL_STATUSES,
  type AutomationRunDispatchState,
  type AutomationDispatchContext,
  type AutomationDispatchHooks,
  type AutomationDispatcher,
  type AutomationTarget,
  type AutomationTargetResolution
} from './dispatch-contract'

const OBSERVATION_INTERVAL_MS = 1_000
const OBSERVATION_DEADLINE_MS = 6 * 60 * 60 * 1_000
const SETUP_POLL_INTERVAL_MS = 1_000
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_PRECHECK_OUTPUT_CHARS = 4_000

type RecordValue = Record<string, unknown>
type Snapshot = { definition: string; target: string }
type VerifyResult =
  | { kind: 'ok'; run: AutomationRun; definition: AutomationDefinition; target: AutomationTarget }
  | { kind: 'deleted' }
  | { kind: 'changed'; reason: string }
  | { kind: 'unavailable'; status: 'skipped_unavailable' | 'skipped_needs_interactive_auth'; error: string }
type ProviderResult = { message: StructuredMessage; success: boolean; error: string | null }
type SetupResult = { ok: true } | { ok: false; error: string } | { ok: null }

type CheckEvidence = {
  command: string
  startedAt: number
  completedAt: number
  ran: boolean
  pass: boolean
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  durationMs: number
  error?: string
}

function record(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = record(value)
  if (object) {
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function semanticDefinition(definition: AutomationDefinition): string {
  const { updatedAt: _updatedAt, lastRunAt: _lastRunAt, nextRunAt: _nextRunAt, ...semantic } = definition
  return stableJson(semantic)
}

function targetIdentity(target: AutomationTarget): string {
  return stableJson({
    repoId: target.repoId,
    repoPath: target.repoPath,
    cwd: target.cwd,
    workspaceId: target.workspaceId,
    owner: target.owner
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function finalStatus(status: AutomationRun['status']): boolean {
  return AUTOMATION_FINAL_STATUSES.includes(status)
}

function outputPrefix(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return { text: value, truncated: false }
  let bytes = 0
  let end = 0
  for (let index = 0; index < value.length;) {
    const first = value.charCodeAt(index)
    let units = 1
    let size = first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1)
      if (second >= 0xdc00 && second <= 0xdfff) {
        size = 4
        units = 2
      }
    }
    if (bytes + size > maximumBytes) break
    bytes += size
    index += units
    end = index
  }
  return { text: value.slice(0, end), truncated: true }
}

function newWorkspaceName(definition: AutomationDefinition, run: AutomationRun, now: number): string {
  const slug = definition.name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'automation'
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return `auto-${slug}-${stamp}-${run.id}`
}

function checkEvidence(command: string, startedAt: number, completedAt: number, value: unknown): CheckEvidence {
  const result = record(value) ?? {}
  const stdout = typeof result.stdoutTail === 'string' ? result.stdoutTail : ''
  const stderr = typeof result.stderrTail === 'string' ? result.stderrTail : ''
  const pass = result.pass === true && result.ran === true && result.exitCode === 0 && result.timedOut !== true && result.aborted !== true && result.error === undefined
  const evidence: CheckEvidence = {
    command,
    startedAt,
    completedAt,
    ran: result.ran === true,
    pass,
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    timedOut: result.timedOut === true,
    aborted: result.aborted === true,
    stdout: stdout.slice(-MAX_PRECHECK_OUTPUT_CHARS),
    stderr: stderr.slice(-MAX_PRECHECK_OUTPUT_CHARS),
    stdoutTruncated: result.stdoutTruncated === true || stdout.length > MAX_PRECHECK_OUTPUT_CHARS,
    stderrTruncated: result.stderrTruncated === true || stderr.length > MAX_PRECHECK_OUTPUT_CHARS,
    durationMs: typeof result.durationMs === 'number' && Number.isFinite(result.durationMs) ? result.durationMs : Math.max(0, completedAt - startedAt),
    ...(typeof result.error === 'string' ? { error: result.error.slice(0, 2_000) } : {})
  }
  // JSON escaping can expand otherwise bounded character tails beyond the metadata budget.
  while (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > 65_536) {
    if (evidence.stdout.length === 0 && evidence.stderr.length === 0) {
      throw new Error('Precheck metadata exceeds the 64 KiB evidence limit.')
    }
    if (evidence.stdout.length >= evidence.stderr.length) {
      evidence.stdout = evidence.stdout.slice(Math.ceil(evidence.stdout.length / 2))
      evidence.stdoutTruncated = true
    } else {
      evidence.stderr = evidence.stderr.slice(Math.ceil(evidence.stderr.length / 2))
      evidence.stderrTruncated = true
    }
  }
  return evidence
}

function parsePrecheckError(command: string, startedAt: number, completedAt: number, error: unknown): CheckEvidence {
  return {
    command,
    startedAt,
    completedAt,
    ran: false,
    pass: false,
    exitCode: null,
    timedOut: false,
    aborted: false,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: Math.max(0, completedAt - startedAt),
    error: messageOf(error).slice(0, 2_000)
  }
}


function sessionIsStructured(value: unknown): value is Session {
  const session = record(value)
  return session !== null && typeof session.id === 'string' && session.kind === 'structured' && typeof session.agent === 'string' &&
    typeof session.worktreeId === 'string' && typeof session.status === 'string'
}

function messageList(value: unknown): StructuredMessage[] {
  return Array.isArray(value) ? value.filter((message): message is StructuredMessage => {
    const candidate = record(message)
    return candidate !== null && typeof candidate.seq === 'number' && typeof candidate.role === 'string' && typeof candidate.text === 'string'
  }) : []
}

function postCursorResult(messages: StructuredMessage[], cursor: number, agentId: string): ProviderResult | null {
  const results = messages.filter((message) => message.seq > cursor && message.role === 'result')
  if (results.length === 0) return null
  for (const message of results) {
    const data = record(message.data)
    if (agentId === 'claude') {
      const subtype = data?.subtype
      const hasErrors = Array.isArray(data?.errors) && data.errors.length > 0
      const failed = data?.is_error === true || hasErrors || (typeof subtype === 'string' && subtype !== 'success')
      if (failed || (subtype !== 'success' && data?.is_error !== false)) {
        return { message, success: false, error: providerError(message, data) }
      }
      if (subtype === 'success' || data?.is_error === false) continue
      return { message, success: false, error: providerError(message, data) }
    }
    const status = data?.status
    if (status !== 'completed' || (data?.error !== undefined && data.error !== null)) {
      return { message, success: false, error: providerError(message, data) }
    }
  }
  return { message: results[results.length - 1]!, success: true, error: null }
}

function providerError(message: StructuredMessage, data: RecordValue | null): string {
  const errors = Array.isArray(data?.errors) ? data.errors.filter((item): item is string => typeof item === 'string') : []
  if (data?.is_error === true || errors.length > 0) {
    return errors.join('; ') || (typeof data?.subtype === 'string' ? `Claude ${data.subtype}` : 'Claude provider reported an error')
  }
  if (typeof data?.status === 'string' && data.status !== 'completed') {
    const error = record(data.error)?.message
    return typeof error === 'string' ? error : `Codex turn ${data.status}`
  }
  if (data?.error !== undefined && data.error !== null) {
    const error = record(data.error)?.message
    return typeof error === 'string' ? error : typeof data.error === 'string' ? data.error : 'Provider result included an error.'
  }
  return message.text || 'Provider result did not report successful completion.'
}

function latestOutput(messages: StructuredMessage[], cursor: number, result: ProviderResult | null): { content: string; truncated: boolean } | null {
  let latest: string | null = null
  let diagnostic: string | null = null
  for (const message of messages) {
    if (message.seq <= cursor) continue
    if (message.role === 'assistant') latest = message.text
    if (message.role === 'system') diagnostic = message.text
  }
  const chosen = latest ?? result?.message.text ?? diagnostic
  if (chosen === null) return null
  const output = outputPrefix(chosen, MAX_OUTPUT_BYTES)
  return { content: output.text, truncated: output.truncated }
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function firstNumber(source: RecordValue | null, ...names: string[]): number | undefined {
  if (!source) return undefined
  for (const name of names) {
    const value = numeric(source[name])
    if (value !== undefined) return value
  }
  return undefined
}

function claudeUsage(data: RecordValue | null, baseline: number | null): RecordValue | null {
  const raw = record(data?.usage)
  const usage: RecordValue = { provider: 'claude' }
  const input = firstNumber(raw, 'input_tokens')
  const output = firstNumber(raw, 'output_tokens')
  const cached = firstNumber(raw, 'cache_read_input_tokens')
  const cacheWrite = firstNumber(raw, 'cache_creation_input_tokens')
  const cost = firstNumber(data, 'total_cost_usd')
  const turnCost = cost !== undefined && baseline !== null && cost >= baseline ? cost - baseline : undefined
  if (input !== undefined) usage.inputTokens = input
  if (output !== undefined) usage.outputTokens = output
  if (cached !== undefined) usage.cacheReadTokens = cached
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite
  if (input !== undefined && output !== undefined) usage.totalTokens = input + output + (cached ?? 0) + (cacheWrite ?? 0)
  usage.tokenScope = 'main_agent'
  usage.estimatedCostUsd = turnCost ?? null
  if (turnCost === undefined) usage.costUnavailableReason = 'Claude cumulative cost could not be isolated to this turn.'
  if (input === undefined && output === undefined && cached === undefined && cacheWrite === undefined) {
    usage.tokensUnavailableReason = 'Claude result did not include token usage.'
  }
  return Object.keys(usage).length > 1 ? usage : null
}

function codexUsage(messages: StructuredMessage[]): RecordValue | null {
  let selected: RecordValue | null = null
  for (const message of messages) {
    if (message.role !== 'system' && message.role !== 'result') continue
    const data = record(message.data)
    if (!data) continue
    const turnUsage = record(data.turnUsage) ?? record(record(data.tokenUsage)?.last) ?? record(data.usage)
    if (turnUsage) selected = turnUsage
  }
  const usage: RecordValue = { provider: 'codex' }
  const input = firstNumber(selected, 'inputTokens', 'input_tokens')
  const output = firstNumber(selected, 'outputTokens', 'output_tokens')
  const cached = firstNumber(selected, 'cachedInputTokens', 'cached_input_tokens')
  const reasoning = firstNumber(selected, 'reasoningOutputTokens', 'reasoning_output_tokens')
  if (input !== undefined) usage.inputTokens = input
  if (output !== undefined) usage.outputTokens = output
  if (cached !== undefined) usage.cacheReadTokens = cached
  if (reasoning !== undefined) usage.reasoningOutputTokens = reasoning
  if (input !== undefined && output !== undefined) usage.totalTokens = input + output
  usage.estimatedCostUsd = null
  usage.costUnavailableReason = 'Codex does not report per-turn cost.'
  if (input === undefined && output === undefined && cached === undefined && reasoning === undefined) {
    usage.tokensUnavailableReason = 'Codex did not report per-turn token usage.'
  }
  return usage
}

function mergeUsage(existing: Record<string, unknown> | null | undefined, collected: RecordValue | null): Record<string, unknown> | null {
  if (collected === null) return existing ?? null
  const current = record(existing) ?? {}
  const merged: Record<string, unknown> = { ...collected }
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningOutputTokens', 'totalTokens', 'estimatedCostUsd'] as const) {
    if ((merged[key] === null || merged[key] === undefined) && typeof current[key] === 'number') merged[key] = current[key]
  }
  if (typeof merged.estimatedCostUsd === 'number') delete merged.costUnavailableReason
  const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningOutputTokens']
  if (tokenFields.some((key) => typeof current[key] === 'number' || typeof merged[key] === 'number')) {
    delete merged.tokensUnavailableReason
  }
  return merged
}

function collectedUsage(run: AutomationRun, messages: StructuredMessage[], result: ProviderResult, agentId: string, session: Session, collectedAt: number): Record<string, unknown> | null {
  if (!result.success) return run.usage ?? null
  const data = record(result.message.data)
  const collected = agentId === 'claude'
    ? claudeUsage(data, run.dispatchState?.reused ? run.dispatchState.claudeCostBaseline ?? null : 0)
    : codexUsage(messages.filter((message) => message.seq > (run.dispatchState?.messageCursor ?? 0)))
  const usage = mergeUsage(run.usage, collected)
  if (!usage) return null
  const measured = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningOutputTokens', 'estimatedCostUsd']
    .some((field) => typeof usage[field] === 'number')
  usage.status = measured ? 'known' : 'unavailable'
  if (!measured) usage.unavailableReason = 'native_usage_missing'
  else delete usage.unavailableReason
  const model = record(record(run.launchSettings?.options)?.model)?.value
  usage.model = typeof model === 'string' ? model : null
  usage.providerSessionId = session.providerSession?.id ?? null
  usage.attribution = 'structured_turn'
  usage.collectedAt = collectedAt
  if (typeof usage.estimatedCostUsd === 'number') usage.estimatedCostSource = 'api_equivalent'
  return usage
}

function runsFor(store: AutomationDispatchHooks['store'], automationId?: string): AutomationRun[] {
  const all: AutomationRun[] = []
  let cursor: string | undefined
  do {
    const page = store.runs(automationId, 100, cursor)
    all.push(...page.runs)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return all
}

function setupError(result: WorktreeCreateResult, decision: 'run' | 'skip'): string | null {
  if (decision === 'skip') {
    return result.setup.ran === 'daemon' || result.setup.ran === 'terminal'
      ? 'Workspace setup ran despite the saved skip decision.'
      : null
  }
  if (result.setup.ran === 'daemon') {
    if (result.setup.timedOut) return 'Workspace setup timed out.'
    if (result.setup.exitCode !== 0) return `Workspace setup exited with ${String(result.setup.exitCode)}.`
    return null
  }
  if (result.setup.ran === 'terminal') return null
  if (result.setup.ran === 'skipped') return 'Workspace setup was skipped despite the run decision.'
  const warning = result.warnings.find((item) => /could not (?:prepare|start) setup/i.test(item))
  return warning ?? null
}

export function createAutomationDispatcher(context: AutomationDispatchContext, hooks: AutomationDispatchHooks): AutomationDispatcher {
  const observers = new Map<string, ReturnType<typeof setInterval>>()
  const observing = new Set<string>()
  const setupDelays = new Map<ReturnType<typeof setTimeout>, () => void>()
  const activeChecks = new Set<string>()
  const activeProvenanceCapabilities = new Set<string>()
  const revokeProvenanceCapability = (dispatchToken: string): void => {
    if (!activeProvenanceCapabilities.delete(dispatchToken)) return
    hooks.revokeWorkspaceProvenance(dispatchToken)
  }
  let disposed = false
  let startTask: Promise<void> | null = null
  let unsubscribe: (() => void) | undefined

  const stopObserving = (runId: string): void => {
    const timer = observers.get(runId)
    if (timer !== undefined) clearInterval(timer)
    observers.delete(runId)
    observing.delete(runId)
  }

  const update = (runId: string, patch: AutomationRunPatch): AutomationRun | null => {
    const before = hooks.store.getRun(runId)
    if (!before || !hooks.store.get(before.automationId)) return null
    if (finalStatus(before.status)) return before
    try {
      const result = hooks.store.updateRun(runId, patch, hooks.clock())
      hooks.changed(result.automationId, result.id)
      return result
    } catch (error) {
      const current = hooks.store.getRun(runId)
      if (!current || !hooks.store.get(current.automationId)) return null
      throw error
    }
  }

  const finish = (
    runId: string,
    status: Extract<AutomationRun['status'], 'completed' | 'skipped_precheck' | 'skipped_unavailable' | 'skipped_needs_interactive_auth' | 'dispatch_failed'>,
    error: string | null,
    patch: AutomationRunPatch = {}
  ): AutomationRun | null => {
    const current = hooks.store.getRun(runId)
    if (!current || !hooks.store.get(current.automationId)) return null
    if (finalStatus(current.status)) return current
    const usage = patch.usage ?? current.usage ?? {
      status: 'unavailable',
      provider: current.launchSettings?.agent ?? hooks.store.get(current.automationId)?.agentId,
      estimatedCostUsd: null,
      unavailableReason: status === 'completed' ? 'native_usage_missing' : 'run_not_finished',
      collectedAt: hooks.clock()
    }
    const completed = update(runId, { ...patch, status, error, usage })
    if (!completed || finalStatus(completed.status)) stopObserving(runId)
    return completed
  }

  const resolveTarget = async (definition: AutomationDefinition): Promise<AutomationTargetResolution> => {
    try {
      return await hooks.targets.resolve(definition)
    } catch (error) {
      return { available: false, status: 'skipped_unavailable', error: messageOf(error) }
    }
  }

  const verify = async (runId: string, snapshot: Snapshot, baseTarget: AutomationTarget): Promise<VerifyResult> => {
    const before = hooks.store.getRun(runId)
    if (!before) return { kind: 'deleted' }
    const definition = hooks.store.get(before.automationId)
    if (!definition) return { kind: 'deleted' }
    if (semanticDefinition(definition) !== snapshot.definition) return { kind: 'changed', reason: 'Automation definition changed while this run was preparing.' }

    const resolution = await resolveTarget(definition)
    const current = hooks.store.getRun(runId)
    if (!current) return { kind: 'deleted' }
    const freshDefinition = hooks.store.get(current.automationId)
    if (!freshDefinition) return { kind: 'deleted' }
    if (semanticDefinition(freshDefinition) !== snapshot.definition) return { kind: 'changed', reason: 'Automation definition changed while this run was preparing.' }
    if (!resolution.available) return { kind: 'unavailable', status: resolution.status, error: resolution.error }
    if (targetIdentity(resolution.target) !== snapshot.target || targetIdentity(resolution.target) !== targetIdentity(baseTarget)) {
      return { kind: 'changed', reason: 'Automation destination changed while this run was preparing.' }
    }
    return { kind: 'ok', run: current, definition: freshDefinition, target: resolution.target }
  }

  const applyVerifyFailure = (runId: string, result: VerifyResult): AutomationRun | null | undefined => {
    if (result.kind === 'deleted') return null
    if (result.kind === 'changed') return finish(runId, 'dispatch_failed', result.reason)
    if (result.kind === 'unavailable') return finish(runId, result.status, result.error)
    return undefined
  }

  const runPrecheck = async (runId: string, definition: AutomationDefinition, target: AutomationTarget): Promise<CheckEvidence> => {
    const command = definition.precheck!.command
    const startedAt = hooks.clock()
    activeChecks.add(runId)
    try {
      const result = await context.call('quirky.checks/run', {
        command,
        cwd: target.repoPath,
        timeoutSeconds: definition.precheck!.timeoutSeconds,
        checkId: runId
      })
      return checkEvidence(command, startedAt, hooks.clock(), result)
    } catch (error) {
      return parsePrecheckError(command, startedAt, hooks.clock(), error)
    } finally {
      activeChecks.delete(runId)
    }
  }

  const waitForSetup = async (setup: NonNullable<WorktreeCreateResult['setup']>): Promise<SetupResult> => {
    if (setup.ran !== 'terminal') return { ok: true }
    if (typeof setup.sessionId !== 'string' || setup.sessionId.length === 0) return { ok: false, error: 'Workspace setup did not identify its terminal session.' }
    const deadline = hooks.clock() + OBSERVATION_DEADLINE_MS
    const delay = (): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>()
      const timer = setTimeout(() => {
        setupDelays.delete(timer)
        resolve()
      }, SETUP_POLL_INTERVAL_MS)
      setupDelays.set(timer, resolve)
      return promise
    }
    while (!disposed && hooks.clock() < deadline) {
      try {
        const session = await context.call('quirky.session/get', { session: setup.sessionId }) as Session
        if (session.status === 'exited') {
          if (session.exitCode === 0) return { ok: true }
          return { ok: false, error: `Workspace setup exited with ${String(session.exitCode)}.` }
        }
      } catch (error) {
        return { ok: false, error: `Could not observe workspace setup: ${messageOf(error)}` }
      }
      await delay()
    }
    if (disposed) return { ok: null }
    return { ok: false, error: 'Workspace setup did not finish before the six-hour dispatch deadline.' }
  }

  const eligibleReuseRun = (definition: AutomationDefinition, currentRun: AutomationRun, workspaceId: string): AutomationRun | null => {
    if (!definition.reuseSession || definition.workspaceMode !== 'existing') return null
    const history = runsFor(hooks.store, definition.id)
    const mostRecent = history
      .filter((run) => run.id !== currentRun.id && run.runNumber < currentRun.runNumber && run.status === 'completed' && run.sessionId !== null && run.workspaceId === workspaceId)
      .sort((left, right) => right.runNumber - left.runNumber)[0]
    if (!mostRecent?.sessionId) return null
    if (history.some((run) => run.runNumber > mostRecent.runNumber && run.sessionId === mostRecent.sessionId)) return null
    return mostRecent.sessionKind === 'structured' ? mostRecent : null
  }

  const persistDispatching = (runId: string, patch: AutomationRunPatch): AutomationRun | null => {
    const current = hooks.store.getRun(runId)
    if (!current || !hooks.store.get(current.automationId) || finalStatus(current.status)) return null
    return update(runId, patch)
  }

  const markReuseDispatch = async (
    runId: string,
    snapshot: Snapshot,
    baseTarget: AutomationTarget,
    prior: AutomationRun,
    workspaceId: string
  ): Promise<{ kind: 'sent'; run: AutomationRun } | { kind: 'not-eligible' } | { kind: 'deleted' } | { kind: 'failed'; run: AutomationRun | null } | { kind: 'changed'; run: AutomationRun | null }> => {
    const sessionId = prior.sessionId!
    return hooks.inLane(sessionId, async () => {
      let verifyResult = await verify(runId, snapshot, baseTarget)
      if (verifyResult.kind !== 'ok') {
        if (verifyResult.kind === 'deleted') return { kind: 'deleted' }
        const failed = applyVerifyFailure(runId, verifyResult) ?? null
        return { kind: 'changed', run: failed }
      }
      let session: Session
      try {
        session = await context.call('quirky.session/get', { session: sessionId }) as Session
      } catch {
        return { kind: 'not-eligible' }
      }
      verifyResult = await verify(runId, snapshot, baseTarget)
      if (verifyResult.kind !== 'ok') {
        if (verifyResult.kind === 'deleted') return { kind: 'deleted' }
        const failed = applyVerifyFailure(runId, verifyResult) ?? null
        return { kind: 'changed', run: failed }
      }
      if (!sessionIsStructured(session) || session.id !== sessionId || session.agent !== verifyResult.definition.agentId ||
        session.worktreeId !== workspaceId || session.status !== 'done') return { kind: 'not-eligible' }

      let beforeMessages: StructuredMessage[]
      try {
        beforeMessages = messageList(await context.call('quirky.structured/messages', { session: sessionId }))
      } catch {
        return { kind: 'not-eligible' }
      }
      try {
        session = await context.call('quirky.session/get', { session: sessionId }) as Session
      } catch {
        return { kind: 'not-eligible' }
      }
      verifyResult = await verify(runId, snapshot, baseTarget)
      if (verifyResult.kind !== 'ok') {
        if (verifyResult.kind === 'deleted') return { kind: 'deleted' }
        const failed = applyVerifyFailure(runId, verifyResult) ?? null
        return { kind: 'changed', run: failed }
      }
      if (!sessionIsStructured(session) || session.id !== sessionId || session.status !== 'done' ||
        session.worktreeId !== workspaceId || session.agent !== verifyResult.definition.agentId) return { kind: 'not-eligible' }

      const cursor = beforeMessages.reduce((maximum, message) => Math.max(maximum, message.seq), 0)
      let claudeCostBaseline: number | null = null
      if (session.agent === 'claude') {
        for (let index = beforeMessages.length - 1; index >= 0; index--) {
          const message = beforeMessages[index]!
          if (message.seq > cursor || message.role !== 'result') continue
          claudeCostBaseline = numeric(record(message.data)?.total_cost_usd) ?? null
          break
        }
      }
      const state: AutomationRunDispatchState = {
        messageCursor: cursor,
        reused: true,
        observedWorking: false,
        observationStartedAt: hooks.clock(),
        ...(session.agent === 'claude' ? { claudeCostBaseline } : {})
      }
      const beforeSend = persistDispatching(runId, {
        sessionId,
        launchSettings: prior.launchSettings,
        dispatchState: state
      })
      if (!beforeSend) return { kind: 'deleted' }
      try {
        await context.call('quirky.structured/send', { session: sessionId, text: verifyResult.definition.prompt })
      } catch (error) {
        const failed = finish(runId, 'dispatch_failed', `Structured prompt submission failed ambiguously: ${messageOf(error)}`, {
          sessionId,
          launchSettings: prior.launchSettings,
          dispatchState: state
        })
        return { kind: 'failed', run: failed }
      }
      const current = hooks.store.getRun(runId)
      if (!current || !hooks.store.get(current.automationId)) return { kind: 'deleted' }
      if (finalStatus(current.status)) return { kind: 'sent', run: current }
      const dispatched = update(runId, { status: 'dispatched' })
      return dispatched ? { kind: 'sent', run: dispatched } : { kind: 'deleted' }
    })
  }

  const observe = async (runId: string): Promise<void> => {
    if (disposed || observing.has(runId)) return
    observing.add(runId)
    try {
      const run = hooks.store.getRun(runId)
      if (!run || run.status !== 'dispatched' || !run.sessionId || !run.dispatchState) {
        if (!run || finalStatus(run.status)) stopObserving(runId)
        return
      }
      await hooks.inLane(run.automationId, async () => {
        const current = hooks.store.getRun(runId)
        if (!current || current.status !== 'dispatched' || !current.sessionId || !current.dispatchState) {
          if (!current || (current && finalStatus(current.status))) stopObserving(runId)
          return
        }
        const definition = hooks.store.get(current.automationId)
        if (!definition) return
        let session: Session
        let messages: StructuredMessage[]
        try {
          ;[session, messages] = await Promise.all([
            context.call('quirky.session/get', { session: current.sessionId }) as Promise<Session>,
            context.call('quirky.structured/messages', { session: current.sessionId, afterSeq: current.dispatchState.messageCursor }).then(messageList)
          ])
        } catch (error) {
          finish(runId, 'dispatch_failed', `Structured runner was lost while observing this run: ${messageOf(error)}`)
          return
        }
        const afterRead = hooks.store.getRun(runId)
        if (!afterRead || finalStatus(afterRead.status) || afterRead.status !== 'dispatched') {
          if (!afterRead || (afterRead && finalStatus(afterRead.status))) stopObserving(runId)
          return
        }
        const agentId = typeof afterRead.launchSettings?.agent === 'string' ? afterRead.launchSettings.agent : definition.agentId
        if (!sessionIsStructured(session) || session.id !== afterRead.sessionId || session.agent !== agentId || session.worktreeId !== afterRead.workspaceId) {
          finish(runId, 'dispatch_failed', 'Structured session identity no longer matches the dispatched run.')
          return
        }
        const providerResult = postCursorResult(messages, afterRead.dispatchState!.messageCursor, agentId)
        const output = latestOutput(messages, afterRead.dispatchState!.messageCursor, providerResult)
        if (providerResult) {
          const usage = collectedUsage(afterRead, messages, providerResult, agentId, session, hooks.clock())
          const outputSnapshot = output ? {
            format: 'plain_text' as const,
            content: output.content,
            capturedAt: hooks.clock(),
            truncated: output.truncated
          } : undefined
          if (!providerResult.success) {
            finish(runId, 'dispatch_failed', providerResult.error, {
              ...(outputSnapshot ? { outputSnapshot } : {}), ...(usage ? { usage } : {})
            })
          } else {
            finish(runId, 'completed', null, {
              ...(outputSnapshot ? { outputSnapshot } : {}), ...(usage ? { usage } : {})
            })
          }
          return
        }
        if (session.status === 'waiting') {
          finish(runId, 'dispatch_failed', 'Structured provider is waiting for approval or user input; unattended automations cannot answer it.', {
            ...(output ? { outputSnapshot: { format: 'plain_text', content: output.content, capturedAt: hooks.clock(), truncated: output.truncated } } : {})
          })
          try { await context.call('quirky.structured/stop', { session: session.id }) } catch { /* Final state is already durable. */ }
          return
        }
        if (session.status === 'exited') {
          finish(runId, 'dispatch_failed', 'Structured runner exited without a successful post-dispatch provider result.', {
            ...(output ? { outputSnapshot: { format: 'plain_text', content: output.content, capturedAt: hooks.clock(), truncated: output.truncated } } : {})
          })
          return
        }
        if (hooks.clock() - afterRead.dispatchState!.observationStartedAt >= OBSERVATION_DEADLINE_MS) {
          finish(runId, 'dispatch_failed', 'Structured run exceeded the six-hour observation deadline.', {
            ...(output ? { outputSnapshot: { format: 'plain_text', content: output.content, capturedAt: hooks.clock(), truncated: output.truncated } } : {})
          })
          try { await context.call('quirky.structured/stop', { session: session.id }) } catch { /* Final state is already durable. */ }
          return
        }
        if (session.status === 'working' && !afterRead.dispatchState!.observedWorking) {
          update(runId, { dispatchState: { ...afterRead.dispatchState!, observedWorking: true } })
        }
      })
    } catch (error) {
      const current = hooks.store.getRun(runId)
      if (current && current.status === 'dispatched') finish(runId, 'dispatch_failed', `Could not reconcile structured run: ${messageOf(error)}`)
    } finally {
      observing.delete(runId)
    }
  }

  const watch = (runId: string): void => {
    if (disposed || observers.has(runId)) return
    void observe(runId)
    observers.set(runId, setInterval(() => { void observe(runId) }, OBSERVATION_INTERVAL_MS))
  }

  const verifyOrFinish = async (runId: string, snapshot: Snapshot, target: AutomationTarget): Promise<VerifyResult | null> => {
    if (disposed) return null
    const verified = await verify(runId, snapshot, target)
    if (verified.kind !== 'ok') applyVerifyFailure(runId, verified)
    return verified
  }

  const dispatchInLane = async (runId: string): Promise<AutomationRun | null> => {
    if (disposed) return hooks.store.getRun(runId)
    const originalRun = hooks.store.getRun(runId)
    if (!originalRun) return null
    if (originalRun.status !== 'pending') return originalRun
    const originalDefinition = hooks.store.get(originalRun.automationId)
    if (!originalDefinition) return null
    const snapshotDefinition = semanticDefinition(originalDefinition)
    const initialResolution = await resolveTarget(originalDefinition)
    if (disposed) return hooks.store.getRun(runId)
    const afterResolve = hooks.store.getRun(runId)
    if (!afterResolve || !hooks.store.get(afterResolve.automationId)) return null

    let claimed: AutomationRun
    try {
      claimed = hooks.store.claimRun(runId, hooks.clock())
      hooks.changed(claimed.automationId, claimed.id)
    } catch (error) {
      const current = hooks.store.getRun(runId)
      if (!current || current.status !== 'pending') return current
      throw error
    }
    const snapshot: Snapshot = {
      definition: snapshotDefinition,
      target: initialResolution.available ? targetIdentity(initialResolution.target) : ''
    }
    const afterClaimDefinition = hooks.store.get(claimed.automationId)
    if (!afterClaimDefinition) return null
    if (semanticDefinition(afterClaimDefinition) !== snapshot.definition) {
      return finish(runId, 'dispatch_failed', 'Automation definition changed while this run was being claimed.')
    }
    if (!initialResolution.available) return finish(runId, initialResolution.status, initialResolution.error)
    const baseTarget = initialResolution.target
    const verified = await verifyOrFinish(runId, snapshot, baseTarget)
    if (!verified || verified.kind !== 'ok') return hooks.store.getRun(runId)
    let definition = verified.definition
    let target = verified.target
    let current = verified.run

    if (current.trigger === 'scheduled' && definition.precheck) {
      const precheck = await runPrecheck(runId, definition, target)
      const rechecked = await verifyOrFinish(runId, snapshot, baseTarget)
      if (!rechecked || rechecked.kind !== 'ok') return hooks.store.getRun(runId)
      definition = rechecked.definition
      target = rechecked.target
      current = rechecked.run
      if (disposed) return hooks.store.getRun(runId)
      if (!precheck.pass) {
        const reason = precheck.timedOut
          ? 'Automation precheck timed out.'
          : precheck.aborted
            ? 'Automation precheck was cancelled.'
            : precheck.error
              ? `Automation precheck failed: ${precheck.error}`
              : `Automation precheck exited with ${String(precheck.exitCode)}.`
        return finish(runId, 'skipped_precheck', reason, { precheckResult: precheck })
      }
      update(runId, { precheckResult: precheck })
    }

    let workspaceId: string
    let workspaceDisplayName: string | null
    if (definition.workspaceMode === 'existing') {
      if (!target.workspaceId) return finish(runId, 'skipped_unavailable', 'The captured workspace is no longer available.')
      workspaceId = target.workspaceId
      workspaceDisplayName = target.workspaceDisplayName
      if (!update(runId, { workspaceDisplayName })) return null
    } else {
      const setupDecision = definition.setupDecision ?? 'skip'
      const name = newWorkspaceName(definition, current, hooks.clock())
      const params = {
        repo: `id:${target.repoId}`,
        name,
        ...(definition.baseBranch ? { base: definition.baseBranch } : {}),
        setup: setupDecision,
        noParent: true,
        activate: false,
        createdBy: 'api'
      }
      const provenanceRequest = hooks.issueWorkspaceProvenance(runId, target.repoId)
      activeProvenanceCapabilities.add(provenanceRequest.dispatchToken)
      let created: WorktreeCreateResult
      try {
        created = await context.call('quirky.worktree/create', {
          ...params,
          automationProvenanceRequest: provenanceRequest
        }) as WorktreeCreateResult
      } catch (error) {
        return finish(runId, 'dispatch_failed', `Could not create the run workspace: ${messageOf(error)}`)
      } finally {
        revokeProvenanceCapability(provenanceRequest.dispatchToken)
      }
      const worktree = record(created?.worktree)
      const id = worktree?.id
      const displayName = typeof worktree?.name === 'string' ? worktree.name : name
      if (typeof id !== 'string' || id.length === 0) return finish(runId, 'dispatch_failed', 'Workspace creation returned no workspace identity.')
      const existing = hooks.store.getRun(runId)
      if (!existing || !hooks.store.get(existing.automationId)) return null
      const recorded = update(runId, { workspaceId: id, workspaceDisplayName: displayName })
      if (!recorded) return null
      workspaceId = id
      workspaceDisplayName = displayName
      if (disposed) return recorded
      if (worktree?.repoId !== target.repoId) {
        return finish(runId, 'dispatch_failed', 'Workspace creation returned a destination outside the captured repository.')
      }
      const rechecked = await verifyOrFinish(runId, snapshot, baseTarget)
      if (!rechecked || rechecked.kind !== 'ok') return hooks.store.getRun(runId)
      definition = rechecked.definition
      target = rechecked.target
      current = rechecked.run
      const setupEvidence = record(created.setup)
      if (!setupEvidence || typeof setupEvidence.ran !== 'string' ||
        !['terminal', 'daemon', 'none', 'skipped'].includes(setupEvidence.ran) || !Array.isArray(created.warnings)) {
        return finish(runId, 'dispatch_failed', 'Workspace creation returned malformed setup evidence.')
      }
      const setupFailure = setupError(created, setupDecision)
      if (setupFailure) return finish(runId, 'dispatch_failed', setupFailure)
      const setup = await waitForSetup(created.setup)
      if (setup.ok === null || disposed) return hooks.store.getRun(runId)
      if (!setup.ok) return finish(runId, 'dispatch_failed', setup.error)
      const afterSetup = await verifyOrFinish(runId, snapshot, baseTarget)
      if (!afterSetup || afterSetup.kind !== 'ok') return hooks.store.getRun(runId)
      definition = afterSetup.definition
      target = afterSetup.target
      current = afterSetup.run
    }

    if (disposed) return hooks.store.getRun(runId)
    const reuse = eligibleReuseRun(definition, current, workspaceId)
    if (reuse) {
      const reused = await markReuseDispatch(runId, snapshot, baseTarget, reuse, workspaceId)
      if (reused.kind === 'sent') {
        watch(runId)
        return hooks.store.getRun(runId)
      }
      if (reused.kind === 'deleted') return null
      if (reused.kind === 'failed' || reused.kind === 'changed') return reused.run
    }

    let resolved: RecordValue | null = null
    const overrides = definition.launchOverrides
    if (overrides) {
      try {
        resolved = record(await context.call('quirky.agents/resolveLaunch', {
          agent: definition.agentId,
          host: 'local',
          ...(overrides.model === undefined ? {} : { model: overrides.model }),
          ...(overrides.optionValues === undefined ? {} : { options: overrides.optionValues }),
          structured: true
        }))
      } catch (error) {
        return finish(runId, 'dispatch_failed', `Saved structured launch picks are no longer valid: ${messageOf(error)}`)
      }
    }
    const afterCatalog = await verifyOrFinish(runId, snapshot, baseTarget)
    if (!afterCatalog || afterCatalog.kind !== 'ok') return hooks.store.getRun(runId)
    definition = afterCatalog.definition
    target = afterCatalog.target
    current = afterCatalog.run
    const resolvedOptions = record(resolved?.structured) ?? {}
    const model = typeof resolvedOptions.model === 'string' ? resolvedOptions.model : undefined
    const effort = typeof resolvedOptions.effort === 'string' ? resolvedOptions.effort : undefined
    const createParams = {
      worktree: `id:${workspaceId}`,
      agent: definition.agentId,
      prompt: definition.prompt,
      ...(model === undefined ? {} : { model }),
      background: true,
      ...(effort === undefined ? {} : { options: { effort } })
    }
    if (current.status !== 'dispatching' || disposed) return hooks.store.getRun(runId)

    let session: Session
    try {
      session = await context.call('quirky.structured/create', createParams) as Session
    } catch (error) {
      return finish(runId, 'dispatch_failed', `Structured launch failed: ${messageOf(error)}`)
    }
    const afterLaunch = hooks.store.getRun(runId)
    if (!afterLaunch || !hooks.store.get(afterLaunch.automationId)) {
      if (session && typeof session.id === 'string') {
        try { await context.call('quirky.structured/stop', { session: session.id }) } catch { /* The automation has been deleted. */ }
      }
      return null
    }
    if (disposed) return afterLaunch
    if (!sessionIsStructured(session) || session.agent !== definition.agentId || session.worktreeId !== workspaceId) {
      return finish(runId, 'dispatch_failed', 'Structured launch returned a session for a different provider or workspace.')
    }
    const state: AutomationRunDispatchState = {
      messageCursor: 0,
      reused: false,
      observedWorking: session.status === 'working',
      observationStartedAt: hooks.clock()
    }
    const dispatched = update(runId, {
      status: 'dispatched',
      workspaceId,
      workspaceDisplayName,
      sessionId: session.id,
      launchSettings: session.launchSettings ?? { agent: session.agent, options: {}, summary: session.agent },
      dispatchState: state
    })
    if (!dispatched) return null
    watch(runId)
    return hooks.store.getRun(runId)
  }

  const dispatch = (runId: string): Promise<AutomationRun | null> => {
    const run = hooks.store.getRun(runId)
    if (!run) return Promise.resolve(null)
    return hooks.inLane(run.automationId, () => dispatchInLane(runId)).catch((error: unknown) => {
      const current = hooks.store.getRun(runId)
      if (!current || finalStatus(current.status)) return current
      return finish(runId, 'dispatch_failed', `Automation dispatch failed: ${messageOf(error)}`)
    })
  }

  const start = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (startTask) return startTask
    startTask = (async () => {
      const activeRuns = runsFor(hooks.store).filter((run) => run.status === 'pending' || run.status === 'dispatching' || run.status === 'dispatched')
      for (const run of activeRuns) {
        if (disposed) return
        if (run.status === 'pending' && run.trigger === 'scheduled') {
          await dispatch(run.id)
          continue
        }
        if (run.status === 'dispatched') {
          const current = hooks.store.getRun(run.id)
          if (current?.status === 'dispatched' && current.sessionId && current.dispatchState) watch(current.id)
          else if (current?.status === 'dispatched') {
            await hooks.inLane(run.automationId, () => finish(run.id, 'dispatch_failed', 'Dispatched run has no durable message cursor; it cannot be safely reconciled.'))
          }
          continue
        }
        await hooks.inLane(run.automationId, () => {
          const current = hooks.store.getRun(run.id)
          if (!current || finalStatus(current.status)) return
          const reason = current.status === 'dispatching'
            ? 'Run was stranded while dispatching during daemon restart; launch was not replayed.'
            : 'Pending manual run was stranded during daemon restart; launch was not replayed.'
          finish(run.id, 'dispatch_failed', reason)
        })
      }
    })().finally(() => { startTask = null })
    return startTask
  }

  unsubscribe = context.subscribe((event) => {
    if (disposed || (event.type !== 'quirky.structured/message' && event.type !== 'quirky.session/changed')) return
    const data = record(event.data)
    const message = record(data?.message)
    const session = record(data?.session)
    const sessionId = typeof message?.sessionId === 'string' ? message.sessionId : typeof session?.id === 'string' ? session.id : null
    if (!sessionId) return
    for (const [runId] of observers) {
      if (hooks.store.getRun(runId)?.sessionId === sessionId) void observe(runId)
    }
  })

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    unsubscribe?.()
    unsubscribe = undefined
    for (const timer of observers.values()) clearInterval(timer)
    observers.clear()
    for (const [timer, resolve] of setupDelays) {
      clearTimeout(timer)
      resolve()
    }
    setupDelays.clear()
    observing.clear()
    for (const dispatchToken of [...activeProvenanceCapabilities]) {
      revokeProvenanceCapability(dispatchToken)
    }
    for (const checkId of activeChecks) {
      void context.call('quirky.checks/cancel', { checkId }).catch(() => {})
    }
    activeChecks.clear()
  }

  return { dispatch, start, dispose }
}
