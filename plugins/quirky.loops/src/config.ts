import type { LoopConfig, LoopConfigPatch, LoopPreset } from './types'

const objectOf = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`)
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown !== undefined) throw new TypeError(`${path}.${unknown} is not supported`)
}

function text(value: unknown, path: string, nonBlank = false): string {
  if (typeof value !== 'string' || (nonBlank && value.trim() === '')) throw new TypeError(`${path} must be ${nonBlank ? 'a non-empty string' : 'a string'}`)
  return value
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean`)
  return value
}

function positive(value: unknown, path: string, integer: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer ? value < 1 || !Number.isInteger(value) : value <= 0)) {
    throw new TypeError(`${path} must be a finite ${integer ? 'integer greater than or equal to 1' : 'number greater than 0'}`)
  }
  return value
}

function optionalPositive(value: unknown, path: string, integer: boolean): number | undefined {
  return value === undefined ? undefined : positive(value, path, integer)
}

function normalizeDone(value: unknown): LoopConfig['done'] {
  const done = objectOf(value, 'done')
  onlyKeys(done, ['check', 'evaluator'], 'done')
  let check: LoopConfig['done']['check']
  if (done.check !== undefined) {
    const raw = objectOf(done.check, 'done.check')
    onlyKeys(raw, ['command', 'timeoutSeconds', 'runWhen'], 'done.check')
    const command = text(raw.command, 'done.check.command', true)
    const timeoutSeconds = raw.timeoutSeconds === undefined ? 300 : positive(raw.timeoutSeconds, 'done.check.timeoutSeconds', true)
    if (timeoutSeconds > 600) throw new TypeError('done.check.timeoutSeconds must be between 1 and 600')
    const runWhen = raw.runWhen === undefined ? 'every-iteration' : raw.runWhen
    if (runWhen !== 'every-iteration' && runWhen !== 'on-claim') throw new TypeError('done.check.runWhen is not supported')
    check = { command, timeoutSeconds, runWhen }
  }
  let evaluator: LoopConfig['done']['evaluator']
  if (done.evaluator !== undefined) {
    const raw = objectOf(done.evaluator, 'done.evaluator')
    onlyKeys(raw, ['condition'], 'done.evaluator')
    evaluator = { condition: text(raw.condition, 'done.evaluator.condition', true) }
  }
  return { ...(check === undefined ? {} : { check }), ...(evaluator === undefined ? {} : { evaluator }) }
}

function normalizeCaps(value: unknown): LoopConfig['caps'] {
  const caps = objectOf(value, 'caps')
  onlyKeys(caps, ['maxIterations', 'maxActiveMinutes', 'maxCostUsd'], 'caps')
  const maxIterations = optionalPositive(caps.maxIterations, 'caps.maxIterations', true)
  const maxActiveMinutes = optionalPositive(caps.maxActiveMinutes, 'caps.maxActiveMinutes', true)
  const maxCostUsd = optionalPositive(caps.maxCostUsd, 'caps.maxCostUsd', false)
  return {
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(maxActiveMinutes === undefined ? {} : { maxActiveMinutes }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd })
  }
}

export function normalizeLoopConfig(value: unknown, preset: LoopPreset = 'until-done'): LoopConfig {
  const config = objectOf(value, 'config')
  onlyKeys(config, ['promptSource', 'pacing', 'sessionPolicy', 'done', 'caps', 'noProgress', 'protectedPaths', 'checkpointCommits', 'askBeforeNext', 'resumeAtLimitReset'], 'config')

  const promptSource = objectOf(config.promptSource, 'config.promptSource')
  let normalizedPromptSource: LoopConfig['promptSource']
  if (promptSource.kind === 'repeat') {
    onlyKeys(promptSource, ['kind', 'body'], 'config.promptSource')
    normalizedPromptSource = { kind: 'repeat', body: text(promptSource.body, 'config.promptSource.body', true) }
  } else if (promptSource.kind === 'queue') {
    onlyKeys(promptSource, ['kind', 'repeatQueue'], 'config.promptSource')
    normalizedPromptSource = {
      kind: 'queue',
      repeatQueue: bool(promptSource.repeatQueue, 'config.promptSource.repeatQueue'),
    }
  } else {
    throw new TypeError('config.promptSource.kind must be repeat or queue')
  }

  const pacing = objectOf(config.pacing, 'config.pacing')
  let normalizedPacing: LoopConfig['pacing']
  if (pacing.kind === 'on-idle') {
    onlyKeys(pacing, ['kind'], 'config.pacing')
    normalizedPacing = { kind: 'on-idle' }
  } else if (pacing.kind === 'interval') {
    onlyKeys(pacing, ['kind', 'minutes', 'anchor'], 'config.pacing')
    const minutes = positive(pacing.minutes, 'config.pacing.minutes', true)
    const anchor = pacing.anchor
    if (anchor !== 'from-end' && anchor !== 'wall-clock') {
      throw new TypeError('config.pacing.anchor must be from-end or wall-clock')
    }
    normalizedPacing = { kind: 'interval', minutes, anchor }
  } else {
    throw new TypeError('config.pacing.kind must be on-idle or interval')
  }

  const sessionPolicy = config.sessionPolicy === undefined ? (preset === 'until-done' ? 'fresh' : 'continue') : config.sessionPolicy
  if (sessionPolicy !== 'fresh' && sessionPolicy !== 'continue') throw new TypeError('config.sessionPolicy must be fresh or continue')

  const rawDone = config.done === undefined ? {} : config.done
  const done = normalizeDone(rawDone)
  const caps = normalizeCaps(config.caps === undefined ? {} : config.caps)
  const noProgress = config.noProgress === undefined ? false : bool(config.noProgress, 'config.noProgress')
  const checkpointCommits = config.checkpointCommits === undefined ? false : bool(config.checkpointCommits, 'config.checkpointCommits')
  const askBeforeNext = config.askBeforeNext === undefined ? false : bool(config.askBeforeNext, 'config.askBeforeNext')
  const resumeAtLimitReset = config.resumeAtLimitReset === undefined ? false : bool(config.resumeAtLimitReset, 'config.resumeAtLimitReset')

  let protectedPaths: string[] | undefined
  if (config.protectedPaths !== undefined) {
    if (!Array.isArray(config.protectedPaths) || !config.protectedPaths.every((entry) => typeof entry === 'string' && entry.trim() !== '')) {
      throw new TypeError('config.protectedPaths must be an array of non-empty globs')
    }
    protectedPaths = [...config.protectedPaths]
  }

  return {
    promptSource: normalizedPromptSource,
    pacing: normalizedPacing,
    sessionPolicy,
    done,
    caps,
    noProgress,
    ...(protectedPaths === undefined ? {} : { protectedPaths }),
    checkpointCommits,
    askBeforeNext,
    resumeAtLimitReset
  }
}

/** Replaces supplied sections and preserves omitted sections, then validates the complete config. */
export function mergeLoopConfig(current: LoopConfig, patch: LoopConfigPatch): LoopConfig {
  const raw = patch as Record<string, unknown>
  onlyKeys(raw, ['promptSource', 'pacing', 'sessionPolicy', 'done', 'caps', 'noProgress', 'protectedPaths', 'checkpointCommits', 'askBeforeNext', 'resumeAtLimitReset'], 'patch')
  const merged: Record<string, unknown> = { ...current, ...raw }
  if (raw.protectedPaths === null) delete merged.protectedPaths
  return normalizeLoopConfig(merged)
}

export function validateLoopAgent(agent: unknown): asserts agent is 'claude' | 'codex' {
  if (agent !== 'claude' && agent !== 'codex') throw new TypeError('agent must be claude or codex')
}
