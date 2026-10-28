import { performance } from 'node:perf_hooks'
import type { PluginContext, StructuredMessage } from '@quirky/protocol'
import type {
  CheckResult,
  EvidenceEngineContract,
  EvaluatorResult,
  GatherInput,
  IterationEvidence,
  LoopAgent,
  LoopConfig
} from './types'
import { diffTrees, snapshotWorkingTree, checkpointChangedPaths } from './diff'
import { evaluateCondition, validateEvaluatorAvailable } from './evaluator'
import { parseMarkers } from './markers'
import { findProtectedPaths } from './progress'

const OUTPUT_TAIL_LIMIT = 16_384
const CHECK_TAIL_LIMIT = 4_000
const REASON_LIMIT = 500
const UNVERIFIED_PROTECTED_PATHS = 'protected paths unverified: working tree snapshot unavailable'

type ActiveGather = {
  controller: AbortController
  checkId: string | null
  cancelledCheckId: string | null
  task?: Promise<IterationEvidence>
}

type RawObject = Record<string, unknown>

function record(value: unknown): RawObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RawObject : null
}

function boundedTail(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  return value.length > limit ? value.slice(-limit) : value
}

function boundedReason(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  return text.slice(0, REASON_LIMIT)
}

function outputTail(messages: StructuredMessage[]): string {
  let output = ''
  for (const message of messages) {
    if (message.role !== 'assistant' && message.role !== 'tool') continue
    const addition = `${message.text}\n`
    output = addition.length >= OUTPUT_TAIL_LIMIT ? addition.slice(-OUTPUT_TAIL_LIMIT) : `${output}${addition}`.slice(-OUTPUT_TAIL_LIMIT)
  }
  return output
}

/** Reads only explicit cumulative USD fields from the newest native result; token counts are never priced. */
export function sessionCumulativeCostUsd(messages: StructuredMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'result') continue
    const data = record(message.data)
    const cost = data?.total_cost_usd
    return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null
  }
  return null
}

function resetTimestamp(value: unknown): number | null {
  let timestamp: number | null = null
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) timestamp = value < 1_000_000_000_000 ? value * 1000 : value
  else if (typeof value === 'string' && value.trim() !== '') timestamp = Date.parse(value)
  return timestamp !== null && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8_640_000_000_000_000 ? timestamp : null
}


function explicitlyExhausted(value: RawObject): boolean {
  for (const key of [
    'isRateLimited', 'is_rate_limited', 'rateLimited', 'rate_limited', 'limitReached', 'limit_reached',
    'limitExceeded', 'limit_exceeded', 'isLimitExceeded', 'is_limit_exceeded', 'exhausted', 'isExhausted', 'is_exhausted'
  ]) {
    if (value[key] === true) return true
  }
  for (const key of ['status', 'state', 'code', 'type', 'kind', 'errorType', 'error_type', 'rateLimitStatus', 'rate_limit_status']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && /^(?:rejected|exceeded|exhausted|limit[_ -]?exceeded|rate[_ -]?limit(?:[_ -]?exceeded)?|usage[_ -]?limit(?:[_ -]?exceeded)?)$/i.test(candidate)) return true
  }
  for (const key of ['usedPercent', 'used_percent', 'utilization']) {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 100) return true
  }
  return false
}

function resetValues(value: unknown, output: number[]): void {
  if (Array.isArray(value)) {
    for (const child of value) resetValues(child, output)
    return
  }
  const object = record(value)
  if (!object) return
  for (const [key, child] of Object.entries(object)) {
    if (/^(?:resetAt|resetsAt|reset_at|resets_at|resetTime|reset_time)$/i.test(key)) {
      const timestamp = resetTimestamp(child)
      if (timestamp !== null) output.push(timestamp)
    } else if (child !== null && typeof child === 'object') resetValues(child, output)
  }
}

function exhaustedRecords(value: unknown, output: RawObject[]): void {
  if (Array.isArray(value)) {
    for (const child of value) exhaustedRecords(child, output)
    return
  }
  const object = record(value)
  if (!object) return
  if (explicitlyExhausted(object)) output.push(object)
  for (const child of Object.values(object)) {
    if (child !== null && typeof child === 'object') exhaustedRecords(child, output)
  }
}

/** Extracts provider reset evidence from structured raw fields only, never from natural-language text. */
export function usageLimitFromMessages(messages: StructuredMessage[], agent: LoopAgent): IterationEvidence['usageLimit'] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'system' && message.role !== 'result') continue
    const data = record(message.data)
    if (!data) continue
    const method = data.method
    const isCodexRateUpdate = method === 'account/rateLimits/updated'
    const isClaudeRateEvent = data.type === 'rate_limit_event' || data.type === 'rate-limit-event'
    const directLimit = data.usageLimit ?? data.usage_limit
    const target = isCodexRateUpdate
      ? record(data.params)?.rateLimits ?? record(data.params)?.rate_limits ?? data.params
      : isClaudeRateEvent
        ? data.rate_limit_info ?? data.rateLimitInfo ?? data
        : directLimit
    const records: RawObject[] = []
    if (directLimit === true) records.push({ provider: agent })
    else if (target !== undefined && target !== null) {
      if (directLimit !== undefined && directLimit !== null && (data.usageLimit !== undefined || data.usage_limit !== undefined)) {
        const limit = record(directLimit)
        if (limit) records.push(limit)
      } else exhaustedRecords(target, records)
    }
    if (!records.length && (isCodexRateUpdate || isClaudeRateEvent) && explicitlyExhausted(data)) records.push(data)
    if (!records.length) continue
    const timestamps: number[] = []
    for (const candidate of records) resetValues(candidate, timestamps)
    const provider = records.map((candidate) => candidate.provider).find((candidate): candidate is string => typeof candidate === 'string')
    return { provider: provider ?? agent, resetsAt: timestamps.length ? Math.max(...timestamps) : null }
  }
  return null
}

function failedCheck(error: unknown, aborted: boolean, durationMs: number): CheckResult {
  return {
    ran: false,
    pass: false,
    exitCode: null,
    timedOut: false,
    aborted,
    stdoutTail: '',
    stderrTail: '',
    durationMs: Math.max(0, durationMs),
    error: boundedReason(error)
  }
}

function normalizeCheck(value: unknown, durationMs: number): CheckResult {
  const result = record(value)
  if (!result) return failedCheck('checks returned an invalid result', false, durationMs)
  const ran = result.ran === true
  const exitCode = typeof result.exitCode === 'number' && Number.isInteger(result.exitCode) ? result.exitCode : null
  const timedOut = result.timedOut === true
  const aborted = result.aborted === true
  const error = result.error === undefined ? undefined : boundedReason(result.error)
  const check: CheckResult = {
    ran,
    pass: ran && exitCode === 0 && !timedOut && !aborted && error === undefined,
    exitCode,
    timedOut,
    aborted,
    stdoutTail: boundedTail(result.stdoutTail, CHECK_TAIL_LIMIT),
    stderrTail: boundedTail(result.stderrTail, CHECK_TAIL_LIMIT),
    durationMs: typeof result.durationMs === 'number' && Number.isFinite(result.durationMs) ? Math.max(0, result.durationMs) : Math.max(0, durationMs),
    ...(error === undefined ? {} : { error })
  }
  return check
}

export class EvidenceEngine implements EvidenceEngineContract {
  private readonly active = new Map<string, ActiveGather>()
  private shuttingDown = false

  constructor(private readonly context: PluginContext) {}

  snapshot(cwd: string): Promise<string | null> {
    return snapshotWorkingTree(cwd)
  }

  async validate(agent: LoopAgent, config: LoopConfig, _cwd: string): Promise<void> {
    const check = config.done.check
    if (check) {
      if (typeof check.command !== 'string' || check.command.trim() === '') throw new Error('done check command must not be blank')
      if (!Number.isInteger(check.timeoutSeconds) || check.timeoutSeconds < 1 || check.timeoutSeconds > 600) {
        throw new Error('check timeoutSeconds must be an integer from 1 to 600')
      }
    }
    if (config.done.evaluator) {
      if (config.done.evaluator.condition.trim() === '') throw new Error('done evaluator condition must not be blank')
      await validateEvaluatorAvailable(this.context, agent)
    }
  }

  gather(input: GatherInput): Promise<IterationEvidence> {
    if (this.shuttingDown) return Promise.reject(new Error('evidence engine is shut down'))
    if (this.active.has(input.loop.id)) return Promise.reject(new Error(`evidence is already being gathered for loop ${input.loop.id}`))
    const active: ActiveGather = { controller: new AbortController(), checkId: null, cancelledCheckId: null }
    const onAbort = () => {
      active.controller.abort()
      void this.cancelCheck(active)
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
    this.active.set(input.loop.id, active)
    const task = this.gatherActive(input, active).finally(() => {
      input.signal?.removeEventListener('abort', onAbort)
      if (this.active.get(input.loop.id) === active) this.active.delete(input.loop.id)
    })
    active.task = task
    return task
  }

  private async runCheck(input: GatherInput, active: ActiveGather, doneMarker: boolean): Promise<CheckResult | null> {
    const definition = input.loop.config.done.check
    if (!definition || (definition.runWhen === 'on-claim' && !doneMarker) || active.controller.signal.aborted) return null
    const checkId = `${input.loop.id}:${input.n}:${input.attempt}`
    active.checkId = checkId
    active.cancelledCheckId = null
    input.onPhase?.('checking')
    const startedAt = performance.now()
    try {
      const result = await this.context.call('quirky.checks/run', {
        checkId,
        command: definition.command,
        cwd: input.loop.cwd,
        timeoutSeconds: definition.timeoutSeconds ?? 300
      })
      return normalizeCheck(result, performance.now() - startedAt)
    } catch (error) {
      return failedCheck(error, active.controller.signal.aborted, performance.now() - startedAt)
    } finally {
      if (active.checkId === checkId) active.checkId = null
    }
  }

  private async cancelCheck(active: ActiveGather): Promise<void> {
    const checkId = active.checkId
    if (!checkId || active.cancelledCheckId === checkId) return
    active.cancelledCheckId = checkId
    try {
      await this.context.call('quirky.checks/cancel', { checkId })
    } catch {
      // Check cancellation is best-effort after a plugin or daemon shutdown.
    }
  }

  private async gatherActive(input: GatherInput, active: ActiveGather): Promise<IterationEvidence> {
    const markers = parseMarkers(input.messages)
    const agentOutput = outputTail(input.messages)
    const treeAfter = await snapshotWorkingTree(input.loop.cwd, active.controller.signal)
    const diff = await diffTrees(input.loop.cwd, input.treeBefore, treeAfter, active.controller.signal)
    const protectedPatterns = input.loop.config.protectedPaths?.filter((pattern) => pattern.trim() !== '') ?? []
    const protectedPathHits = protectedPatterns.length === 0
      ? []
      : input.loop.workspaceKind === 'git' && diff === null
        ? [UNVERIFIED_PROTECTED_PATHS]
        : findProtectedPaths(diff?.files ?? [], protectedPatterns)

    const check = await this.runCheck(input, active, markers.done)
    let evaluator: EvaluatorResult | null = null
    if (input.loop.config.done.evaluator && !active.controller.signal.aborted) {
      input.onPhase?.('evaluating')
      try {
        evaluator = await evaluateCondition({
          context: this.context,
          loop: input.loop,
          condition: input.loop.config.done.evaluator.condition,
          check,
          messages: input.messages,
          outputTail: agentOutput,
          signal: active.controller.signal
        })
      } catch (error) {
        evaluator = { verdict: 'not-met', reason: active.controller.signal.aborted ? 'evaluator-aborted' : boundedReason(error) }
      }
    }

    const aborted = active.controller.signal.aborted || input.signal?.aborted === true
    let checkpointCommit: string | null = null
    if (
      input.loop.config.checkpointCommits &&
      input.loop.workspaceKind === 'git' &&
      diff !== null &&
      diff.files.length > 0 &&
      protectedPathHits.length === 0 &&
      !aborted
    ) {
      checkpointCommit = await checkpointChangedPaths(
        input.loop.cwd,
        input.loop.name,
        input.n,
        diff.files,
        protectedPathHits,
        active.controller.signal
      )
    }

    const currentCost = sessionCumulativeCostUsd(input.messages)
    const costBefore = input.costBefore
    const costUsd = currentCost !== null && typeof costBefore === 'number' && Number.isFinite(costBefore) && costBefore >= 0 && currentCost >= costBefore
      ? currentCost - costBefore
      : null
    return {
      check,
      evaluator,
      markers,
      diff,
      treeBefore: input.treeBefore,
      treeAfter,
      protectedPathHits,
      checkpointCommit,
      costUsd,
      usageLimit: usageLimitFromMessages(input.messages, input.loop.agent),
      outputTail: agentOutput
    }
  }

  async cancel(loopId: string): Promise<void> {
    const active = this.active.get(loopId)
    if (!active) return
    active.controller.abort()
    await this.cancelCheck(active)
    await active.task
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const active = [...this.active.values()]
    await Promise.all(active.map(async (gathering) => {
      gathering.controller.abort()
      await this.cancelCheck(gathering)
    }))
    await Promise.allSettled(active.map((gathering) => gathering.task).filter((task): task is Promise<IterationEvidence> => task !== undefined))
  }
}
