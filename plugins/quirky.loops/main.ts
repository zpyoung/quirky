import type { MethodHandler, PluginCaller, PluginContext } from '@quirky/protocol'
import { LoopService } from './src/service'
import type { LoopConfig, LoopConfigPatch, LoopCreateInput, LoopPreset, LoopSnapshot, QueueOperation } from './src/types'

let service: LoopService | undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(context: PluginContext, message: string): never {
  throw context.error('invalid-params', message)
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, context: PluginContext): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra !== undefined) invalid(context, `${path} does not support ${extra}`)
}

function object(value: unknown, path: string, context: PluginContext): Record<string, unknown> {
  if (!isRecord(value)) invalid(context, `${path} must be an object`)
  return value
}

function requiredString(value: unknown, path: string, context: PluginContext): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(context, `${path} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, path: string, context: PluginContext): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) invalid(context, `${path} must be a non-empty string`)
}

function validateCheck(value: unknown, path: string, context: PluginContext): void {
  const check = object(value, path, context)
  onlyKeys(check, ['command', 'timeoutSeconds', 'runWhen'], path, context)
  requiredString(check.command, `${path}.command`, context)
  if (!Number.isInteger(check.timeoutSeconds) || (check.timeoutSeconds as number) < 1 || (check.timeoutSeconds as number) > 600) {
    invalid(context, `${path}.timeoutSeconds must be an integer from 1 to 600`)
  }
  if (check.runWhen !== 'every-iteration' && check.runWhen !== 'on-claim') {
    invalid(context, `${path}.runWhen must be every-iteration or on-claim`)
  }
}

function validateEvaluator(value: unknown, path: string, context: PluginContext): void {
  const evaluator = object(value, path, context)
  onlyKeys(evaluator, ['condition'], path, context)
  requiredString(evaluator.condition, `${path}.condition`, context)
}

function validateDone(value: unknown, path: string, context: PluginContext): void {
  const done = object(value, path, context)
  onlyKeys(done, ['check', 'evaluator'], path, context)
  if (done.check !== undefined) validateCheck(done.check, `${path}.check`, context)
  if (done.evaluator !== undefined) validateEvaluator(done.evaluator, `${path}.evaluator`, context)
}

function validateCaps(value: unknown, path: string, context: PluginContext): void {
  const caps = object(value, path, context)
  onlyKeys(caps, ['maxIterations', 'maxActiveMinutes', 'maxCostUsd'], path, context)
  for (const key of ['maxIterations', 'maxActiveMinutes'] as const) {
    const limit = caps[key]
    if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1)) {
      invalid(context, `${path}.${key} must be a positive integer`)
    }
  }
  const cost = caps.maxCostUsd
  if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0)) {
    invalid(context, `${path}.maxCostUsd must be a positive number`)
  }
}

function validatePromptSource(value: unknown, path: string, context: PluginContext): void {
  const source = object(value, path, context)
  if (source.kind === 'repeat') {
    onlyKeys(source, ['kind', 'body'], path, context)
    requiredString(source.body, `${path}.body`, context)
  } else if (source.kind === 'queue') {
    onlyKeys(source, ['kind', 'repeatQueue'], path, context)
    if (typeof source.repeatQueue !== 'boolean') invalid(context, `${path}.repeatQueue must be a boolean`)
  } else {
    invalid(context, `${path}.kind must be repeat or queue`)
  }
}

function validatePacing(value: unknown, path: string, context: PluginContext): void {
  const pacing = object(value, path, context)
  if (pacing.kind === 'on-idle') {
    onlyKeys(pacing, ['kind'], path, context)
  } else if (pacing.kind === 'interval') {
    onlyKeys(pacing, ['kind', 'minutes', 'anchor'], path, context)
    if (typeof pacing.minutes !== 'number' || !Number.isInteger(pacing.minutes) || pacing.minutes < 1) {
      invalid(context, `${path}.minutes must be a positive integer`)
    }
    if (pacing.anchor !== 'from-end' && pacing.anchor !== 'wall-clock') {
      invalid(context, `${path}.anchor must be from-end or wall-clock`)
    }
  } else {
    invalid(context, `${path}.kind must be on-idle or interval`)
  }
}

const CONFIG_KEYS = [
  'promptSource', 'pacing', 'sessionPolicy', 'done', 'caps', 'noProgress', 'protectedPaths',
  'checkpointCommits', 'askBeforeNext', 'resumeAtLimitReset'
] as const

function validateConfig(
  value: unknown,
  context: PluginContext,
  defaultSessionPolicy: LoopConfig['sessionPolicy']
): LoopConfig {
  const config = object(value, 'config', context)
  onlyKeys(config, CONFIG_KEYS, 'config', context)
  for (const key of ['promptSource', 'pacing', 'done', 'caps', 'noProgress', 'checkpointCommits', 'askBeforeNext', 'resumeAtLimitReset']) {
    if (config[key] === undefined) invalid(context, `config.${key} is required`)
  }
  validatePromptSource(config.promptSource, 'config.promptSource', context)
  validatePacing(config.pacing, 'config.pacing', context)
  if (config.sessionPolicy !== undefined && config.sessionPolicy !== 'fresh' && config.sessionPolicy !== 'continue') {
    invalid(context, 'config.sessionPolicy must be fresh or continue')
  }
  validateDone(config.done, 'config.done', context)
  validateCaps(config.caps, 'config.caps', context)
  for (const key of ['noProgress', 'checkpointCommits', 'askBeforeNext', 'resumeAtLimitReset'] as const) {
    if (typeof config[key] !== 'boolean') invalid(context, `config.${key} must be a boolean`)
  }
  if (config.protectedPaths !== undefined && (!Array.isArray(config.protectedPaths) || config.protectedPaths.some((item) => typeof item !== 'string' || item.trim() === ''))) {
    invalid(context, 'config.protectedPaths must contain non-empty strings')
  }
  return { ...config, sessionPolicy: config.sessionPolicy ?? defaultSessionPolicy } as unknown as LoopConfig
}
function validateQueueItems(value: unknown, context: PluginContext): { body: string }[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) invalid(context, 'queueItems must be an array')
  return value.map((candidate, index) => {
    const item = object(candidate, `queueItems[${index}]`, context)
    onlyKeys(item, ['body'], `queueItems[${index}]`, context)
    return { body: requiredString(item.body, `queueItems[${index}].body`, context) }
  })
}

function validatePresetConfig(
  preset: LoopPreset,
  config: LoopConfig,
  queueItems: { body: string }[] | undefined,
  context: PluginContext,
  requireQueueItems = false
): void {
  if (preset === 'queue') {
    if (config.promptSource.kind !== 'queue') invalid(context, 'queue preset requires a queue prompt source')
    if (requireQueueItems && (queueItems === undefined || queueItems.length === 0)) {
      invalid(context, 'queue preset requires at least one initial queue item')
    }
  } else if (preset === 'interval') {
    if (config.promptSource.kind !== 'repeat') invalid(context, 'interval preset requires a repeat prompt source')
    if (config.pacing.kind !== 'interval') invalid(context, 'interval preset requires interval pacing')
  } else if (config.promptSource.kind !== 'repeat' || config.pacing.kind !== 'on-idle') {
    invalid(context, 'until-done preset requires a repeat prompt source and on-idle pacing')
  }
  if (preset !== 'queue' && queueItems !== undefined) invalid(context, 'queueItems are only supported by the queue preset')
}

function validateQueueOperation(value: unknown, context: PluginContext): QueueOperation {
  const operation = object(value, 'op', context)
  if (operation.kind === 'add') {
    onlyKeys(operation, ['kind', 'body', 'position'], 'op', context)
    if (operation.position !== undefined && (
      typeof operation.position !== 'number' || !Number.isInteger(operation.position) || operation.position < 0
    )) invalid(context, 'op.position must be a nonnegative integer')
    return {
      kind: 'add',
      body: requiredString(operation.body, 'op.body', context),
      ...(operation.position === undefined ? {} : { position: operation.position as number })
    }
  }
  if (operation.kind === 'edit') {
    onlyKeys(operation, ['kind', 'id', 'body'], 'op', context)
    return {
      kind: 'edit',
      id: requiredString(operation.id, 'op.id', context),
      body: requiredString(operation.body, 'op.body', context)
    }
  }
  if (operation.kind === 'move') {
    onlyKeys(operation, ['kind', 'id', 'position'], 'op', context)
    if (typeof operation.position !== 'number' || !Number.isInteger(operation.position) || operation.position < 0) {
      invalid(context, 'op.position must be a nonnegative integer')
    }
    return {
      kind: 'move',
      id: requiredString(operation.id, 'op.id', context),
      position: operation.position
    }
  }
  if (operation.kind === 'remove') {
    onlyKeys(operation, ['kind', 'id'], 'op', context)
    return { kind: 'remove', id: requiredString(operation.id, 'op.id', context) }
  }
  return invalid(context, 'op.kind must be add, edit, move, or remove')
}

function validateOptions(value: unknown, context: PluginContext): void {
  if (!isRecord(value)) invalid(context, 'options must be an object')
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() === '' || (typeof entry !== 'string' && typeof entry !== 'boolean')) {
      invalid(context, 'options must map non-empty IDs to strings or booleans')
    }
  }
}

function validateConfigPatch(value: unknown, context: PluginContext): LoopConfigPatch & { name?: string } {
  const patch = object(value, 'patch', context)
  onlyKeys(patch, [...CONFIG_KEYS, 'name'], 'patch', context)
  if (Object.keys(patch).length === 0) invalid(context, 'patch must contain at least one setting')
  if (patch.name !== undefined) requiredString(patch.name, 'patch.name', context)
  if (patch.promptSource !== undefined) validatePromptSource(patch.promptSource, 'patch.promptSource', context)
  if (patch.pacing !== undefined) validatePacing(patch.pacing, 'patch.pacing', context)
  if (patch.sessionPolicy !== undefined && patch.sessionPolicy !== 'fresh' && patch.sessionPolicy !== 'continue') {
    invalid(context, 'patch.sessionPolicy must be fresh or continue')
  }
  if (patch.done !== undefined) validateDone(patch.done, 'patch.done', context)
  if (patch.caps !== undefined) validateCaps(patch.caps, 'patch.caps', context)
  for (const key of ['noProgress', 'checkpointCommits', 'askBeforeNext', 'resumeAtLimitReset'] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') invalid(context, `patch.${key} must be a boolean`)
  }
  if (patch.protectedPaths !== undefined && (!Array.isArray(patch.protectedPaths) || patch.protectedPaths.some((item) => typeof item !== 'string' || item.trim() === ''))) {
    invalid(context, 'patch.protectedPaths must contain non-empty strings')
  }
  return patch as LoopConfigPatch & { name?: string }
}

function loopId(params: Record<string, unknown>, context: PluginContext): string {
  return requiredString(params.loopId, 'loopId', context)
}

function tabById(node: unknown, tabId: string): Record<string, unknown> | null {
  if (!isRecord(node)) return null
  if (node.kind === 'split') return tabById(node.first, tabId) ?? tabById(node.second, tabId)
  if (node.kind !== 'group' || !Array.isArray(node.tabs)) return null
  const tab = node.tabs.find((candidate) => isRecord(candidate) && candidate.id === tabId)
  return isRecord(tab) ? tab : null
}

async function isBoundLoopView(context: PluginContext, loop: LoopSnapshot, tabId: string): Promise<boolean> {
  const result = await context.call('quirky.terminal/workspace', { workspace: loop.worktreeId }) as unknown
  if (!isRecord(result) || !isRecord(result.workspace)) return false
  const tab = tabById(result.workspace.root, tabId)
  return tab !== null &&
    tab.kind === 'view' &&
    tab.viewId === 'view:quirky.loops/loop' &&
    tab.key === loop.id &&
    tab.closeMethod === 'quirky.loops/viewCloseGuard' &&
    isRecord(tab.closeParams) &&
    tab.closeParams.loopId === loop.id &&
    isRecord(tab.input) &&
    tab.input.loopId === loop.id
}

function isLiveLoop(loop: LoopSnapshot): boolean {
  return loop.state === 'running' || loop.state === 'needs-you'
}

export async function activate(context: PluginContext): Promise<void> {
  const active = new LoopService(context)
  const authorizedViewCloses = new Set<string>()
  service = active
  try {
    await active.start()
  } catch (error) {
    service = undefined
    await active.shutdown()
    throw error
  }

  const handlers: Record<string, MethodHandler> = {
    create: (params, caller: PluginCaller) => {
      onlyKeys(params, ['worktree', 'worktreeId', 'name', 'agent', 'preset', 'queueItems', 'config', 'model', 'options'], 'create', context)
      optionalString(params.worktree, 'worktree', context)
      optionalString(params.worktreeId, 'worktreeId', context)
      if (params.worktree !== undefined && params.worktreeId !== undefined) invalid(context, 'use worktree or worktreeId, not both')
      optionalString(params.name, 'name', context)
      if (params.agent !== 'claude' && params.agent !== 'codex') invalid(context, 'agent must be claude or codex')
      if (params.preset !== undefined && params.preset !== 'until-done' && params.preset !== 'queue' && params.preset !== 'interval') {
        invalid(context, 'preset must be until-done, queue, or interval')
      }
      const preset = (params.preset ?? 'until-done') as LoopPreset
      optionalString(params.model, 'model', context)
      if (params.options !== undefined) validateOptions(params.options, context)
      const config = validateConfig(params.config, context, preset === 'until-done' ? 'fresh' : 'continue')
      const queueItems = validateQueueItems(params.queueItems, context)
      validatePresetConfig(preset, config, queueItems, context, true)
      return active.create({ ...params, preset, queueItems, config } as LoopCreateInput, caller)
    },
    list: (params) => {
      onlyKeys(params, ['worktreeId', 'worktree'], 'list', context)
      optionalString(params.worktreeId, 'worktreeId', context)
      optionalString(params.worktree, 'worktree', context)
      if (params.worktreeId !== undefined && params.worktree !== undefined) invalid(context, 'use worktree or worktreeId, not both')
      return active.list(params as { worktreeId?: string; worktree?: string })
    },
    get: (params) => {
      onlyKeys(params, ['loopId'], 'get', context)
      return active.get(loopId(params, context))
    },
    iterations: (params) => {
      onlyKeys(params, ['loopId', 'limit'], 'iterations', context)
      if (params.limit !== undefined && (!Number.isInteger(params.limit) || (params.limit as number) < 1)) invalid(context, 'limit must be a positive integer')
      return active.iterations(loopId(params, context), params.limit as number | undefined)
    },
    pause: (params) => {
      onlyKeys(params, ['loopId', 'mode'], 'pause', context)
      if (params.mode !== 'after-iteration') invalid(context, 'pause mode must be after-iteration')
      return active.pause(loopId(params, context))
    },
    resume: (params) => {
      onlyKeys(params, ['loopId', 'addIterations'], 'resume', context)
      if (params.addIterations !== undefined && (!Number.isInteger(params.addIterations) || (params.addIterations as number) < 1)) {
        invalid(context, 'addIterations must be a positive integer')
      }
      return active.resume(loopId(params, context), params.addIterations as number | undefined)
    },
    stop: (params) => {
      onlyKeys(params, ['loopId', 'mode'], 'stop', context)
      if (params.mode !== 'after-iteration' && params.mode !== 'now') invalid(context, 'stop mode must be after-iteration or now')
      return active.stop(loopId(params, context), params.mode === 'now')
    },
    steer: (params) => {
      onlyKeys(params, ['loopId', 'text'], 'steer', context)
      return active.steer(loopId(params, context), requiredString(params.text, 'text', context))
    },
    edit: (params) => {
      onlyKeys(params, ['loopId', 'patch'], 'edit', context)
      const id = loopId(params, context)
      const patch = validateConfigPatch(params.patch, context)
      return active.edit(id, patch)
    },
    queue: (params) => {
      onlyKeys(params, ['loopId', 'op'], 'queue', context)
      return active.queue(loopId(params, context), validateQueueOperation(params.op, context))
    },
    viewCloseGuard: async (params, caller: PluginCaller) => {
      onlyKeys(params, ['loopId', 'tabId', 'closeReason', 'closeViewId', 'closeViewKey', 'closeViewInput'], 'viewCloseGuard', context)
      if (caller.role !== 'plugin' || caller.pluginId !== 'quirky.terminal') return false
      const id = loopId(params, context)
      requiredString(params.tabId, 'tabId', context)
      const reason = params.closeReason
      if (reason !== undefined && reason !== 'single' && reason !== 'bulk' && reason !== 'replacement') {
        invalid(context, 'closeReason must be single, bulk, or replacement')
      }
      if (params.closeViewId !== undefined && params.closeViewId !== 'view:quirky.loops/loop') return true
      if (params.closeViewId === 'view:quirky.loops/loop' && (
        params.closeViewKey !== id ||
        !isRecord(params.closeViewInput) ||
        params.closeViewInput.loopId !== id
      )) return false
      const loop = active.get(id)
      if (!isLiveLoop(loop)) return true
      if (reason === 'bulk' || reason === 'replacement') return true
      return authorizedViewCloses.delete(JSON.stringify([id, params.tabId]))
    },
    closeView: async (params) => {
      onlyKeys(params, ['loopId', 'tabId', 'choice'], 'closeView', context)
      const id = loopId(params, context)
      const tabId = requiredString(params.tabId, 'tabId', context)
      if (params.choice !== 'cancel' && params.choice !== 'keep-running' && params.choice !== 'stop') {
        invalid(context, 'choice must be cancel, keep-running, or stop')
      }
      const loop = active.get(id)
      if (!(await isBoundLoopView(context, loop, tabId))) {
        throw context.error('not-found', `no hosted loop tab ${tabId} for ${id}`)
      }
      if (params.choice === 'cancel') return { closed: false }
      if (params.choice === 'stop' && isLiveLoop(loop)) await active.stop(id, true)
      const authorization = JSON.stringify([id, tabId])
      authorizedViewCloses.add(authorization)
      try {
        await context.call('quirky.terminal/closeTab', { tab: tabId })
        return { closed: true }
      } finally {
        authorizedViewCloses.delete(authorization)
      }
    },
  }
  for (const [name, handler] of Object.entries(handlers)) context.provide(`method:${context.pluginId}/${name}`, handler)
}

export async function deactivate(): Promise<void> {
  const current = service
  service = undefined
  await current?.shutdown()
}
