import type { DecisionInput, IterationDetail, LoopConfig, LoopDecision } from './types'
import { hasNoProgress } from './progress'

function sameDoneConfig(left: LoopConfig['done'], right: LoopConfig['done']): boolean {
  const checkMatches =
    left.check === undefined
      ? right.check === undefined
      : right.check !== undefined &&
        left.check.command === right.check.command &&
        left.check.timeoutSeconds === right.check.timeoutSeconds &&
        left.check.runWhen === right.check.runWhen
  const evaluatorMatches =
    left.evaluator === undefined
      ? right.evaluator === undefined
      : right.evaluator !== undefined && left.evaluator.condition === right.evaluator.condition
  return checkMatches && evaluatorMatches
}

function doneSignalsPass(iteration: IterationDetail): boolean {
  const done = iteration.doneConfig
  if (!done.check && !done.evaluator) return false
  if (done.check) {
    const check = iteration.check
    if (
      !check ||
      !check.ran ||
      check.exitCode !== 0 ||
      check.timedOut ||
      check.aborted ||
      check.error !== undefined ||
      !check.pass ||
      (done.check.runWhen === 'on-claim' && !iteration.markers.done)
    ) return false
  }
  if (done.evaluator && iteration.evaluator?.verdict !== 'met') return false
  return true
}

function capDecision(input: DecisionInput, latest: IterationDetail | null): LoopDecision | null {
  const { loop } = input
  const caps = loop.config.caps
  if (caps.maxIterations !== undefined && loop.iterationsCompleted >= caps.maxIterations) {
    return { kind: 'pause', reason: 'cap-iterations' }
  }
  if (caps.maxActiveMinutes !== undefined && loop.activeMs >= caps.maxActiveMinutes * 60_000) {
    return { kind: 'pause', reason: 'cap-time' }
  }
  if (caps.maxCostUsd !== undefined) {
    const hasSettledHistory = latest?.endReason === 'settled' || input.history.some((iteration) => iteration.endReason === 'settled')
    if (hasSettledHistory && (latest?.costUsd === null || loop.costUsd === null)) {
      return { kind: 'pause', reason: 'cap-cost', detail: 'usage-unavailable' }
    }
    if (loop.costUsd !== null && loop.costUsd >= caps.maxCostUsd) return { kind: 'pause', reason: 'cap-cost' }
  }
  return null
}

function usageLimitDecision(input: DecisionInput, latest: IterationDetail): LoopDecision | null {
  const limit = latest.usageLimit
  if (!limit) return null
  const resetsAt = limit.resetsAt
  if (resetsAt !== null && Number.isFinite(resetsAt) && resetsAt > 0 && resetsAt <= 8_640_000_000_000_000) {
    const until = resetsAt + 60_000
    if (input.loop.config.resumeAtLimitReset) {
      return Number.isFinite(until) && until > input.now ? { kind: 'wait', reason: 'usage-limit-reset', until } : null
    }
    return { kind: 'pause', reason: 'usage-limit', detail: new Date(resetsAt).toISOString() }
  }
  return { kind: 'pause', reason: 'usage-limit', detail: limit.provider }
}

/** Maps the latest loop evidence to exactly one action, using the locked precedence order. */
export function decideNext(input: DecisionInput): LoopDecision {
  const { loop, latest } = input
  if (input.stopRequested) return { kind: 'stop' }
  if (input.pauseRequested) return { kind: 'pause', reason: 'user' }
  if (input.unverifiable) return { kind: 'wait', reason: 'unverifiable' }

  if (latest) {
    if (latest.endReason === 'crashed') return latest.attempt < 2 ? { kind: 'retry-crashed' } : { kind: 'pause', reason: 'crashed' }
    if (latest.endReason === 'interrupted') return { kind: 'pause', reason: 'interrupted-by-restart' }
    if (latest.endReason === 'stopped') return { kind: 'pause', reason: 'user' }
    if (latest.endReason === 'unverifiable') return { kind: 'wait', reason: 'unverifiable' }
    if (latest.endReason !== 'settled') return { kind: 'wait', reason: 'iteration-unsettled' }

    if (sameDoneConfig(loop.config.done, latest.doneConfig) && doneSignalsPass(latest)) return { kind: 'complete' }
    if (latest.protectedPathHits.length > 0) return { kind: 'pause', reason: 'protected-path', detail: latest.protectedPathHits.join(', ') }
    if (latest.markers.blocked !== undefined) return { kind: 'pause', reason: 'agent-blocked', detail: latest.markers.blocked }
    if (latest.markers.decide !== undefined) return { kind: 'pause', reason: 'agent-decide', detail: latest.markers.decide }
  }

  const cap = capDecision(input, latest)
  if (cap) return cap

  if (loop.config.noProgress && latest?.endReason === 'settled') {
    const history = input.history.some((iteration) => iteration.n === latest.n && iteration.attempt === latest.attempt)
      ? input.history
      : [...input.history, latest]
    if (hasNoProgress(history, loop.workspaceKind)) return { kind: 'pause', reason: 'no-progress' }
  }

  if (latest?.endReason === 'settled') {
    const usageLimit = usageLimitDecision(input, latest)
    if (usageLimit) return usageLimit
  }

  if (latest !== null && loop.config.askBeforeNext) {
    return { kind: 'pause', reason: 'ask-before-next' }
  }
  if (input.userIdle === false) return { kind: 'wait', reason: 'user-idle' }
  if (input.agentIdle === false) return { kind: 'wait', reason: 'agent-idle' }
  return { kind: 'start-iteration', freshSession: loop.config.sessionPolicy === 'fresh' }
}
