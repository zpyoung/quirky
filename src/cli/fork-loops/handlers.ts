import { LOOPS_CHANNELS } from '../../shared/fork-loops/api'
import { LOOPS_RUNTIME_CAPABILITY } from '../../shared/fork-loops/capability'
import {
  defaultSessionPolicyForPreset,
  type LoopConfig,
  type LoopCreateInput,
  type LoopEditPatch,
  type LoopPreset,
  type LoopSessionPolicy,
  type LoopSnapshot
} from '../../shared/fork-loops/loop-types'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  getOptionalNumberFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import { resolveHeimdallWorkspaceSelector } from '../fork-heimdall/watcher-row'
import { formatLoopChange, formatLoopDetail, formatLoopList } from './format'

type Flags = Map<string, string | boolean>

const DEFAULT_CHECK_TIMEOUT_SECONDS = 300

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

async function requireLoopsCapability(context: HandlerContext): Promise<void> {
  const status = await context.client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(LOOPS_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The running Quirky runtime does not support loops. Update or restart Quirky and try again.'
    )
  }
}

function getBooleanFlag(flags: Flags, name: string): boolean | undefined {
  const value = flags.get(name)
  if (value === undefined || typeof value === 'boolean') {
    return value
  }
  if (value === 'true' || value === 'false') {
    return value === 'true'
  }
  throw invalid(`--${name} is a switch; pass it bare or as --${name}=true|false (got "${value}")`)
}

function getEnumFlag<T extends string>(
  flags: Flags,
  name: string,
  allowed: readonly T[]
): T | undefined {
  const value = getOptionalStringFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  const match = allowed.find((candidate) => candidate === value)
  if (match === undefined) {
    throw invalid(`--${name} must be one of: ${allowed.join(', ')}`)
  }
  return match
}

function getPositiveNumberFlag(flags: Flags, name: string): number | undefined {
  const value = getOptionalNumberFlag(flags, name)
  if (value !== undefined && value <= 0) {
    throw invalid(`--${name} must be greater than 0`)
  }
  return value
}

function getCheckTimeoutFlag(flags: Flags): number | undefined {
  const value = getOptionalPositiveIntegerFlag(flags, 'check-timeout')
  if (value !== undefined && value > 600) {
    throw invalid('--check-timeout must be between 1 and 600 seconds')
  }
  return value
}

type CapsFlags = LoopConfig['caps']

function readCapsFlags(flags: Flags): CapsFlags {
  const maxIterations = getOptionalPositiveIntegerFlag(flags, 'max-iterations')
  const maxActiveMinutes = getOptionalPositiveIntegerFlag(flags, 'max-minutes')
  const maxCostUsd = getPositiveNumberFlag(flags, 'max-cost')
  return {
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(maxActiveMinutes === undefined ? {} : { maxActiveMinutes }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd })
  }
}

type CapKey = keyof LoopConfig['caps']

const CAP_CLEAR_FLAGS: { flag: string; cap: CapKey }[] = [
  { flag: 'no-max-iterations', cap: 'maxIterations' },
  { flag: 'no-max-minutes', cap: 'maxActiveMinutes' },
  { flag: 'no-max-cost', cap: 'maxCostUsd' }
]

const CAP_SET_FLAG: Record<CapKey, string> = {
  maxIterations: 'max-iterations',
  maxActiveMinutes: 'max-minutes',
  maxCostUsd: 'max-cost'
}

function isClearFlagSet(flags: Flags, name: string): boolean {
  return getBooleanFlag(flags, name) === true
}

type CreateDraft = {
  input: Omit<LoopCreateInput, 'worktreeId'>
  queueItems: string[]
}

function buildCreateDraft(flags: Flags): CreateDraft {
  const agent = getRequiredStringFlag(flags, 'agent')
  if (!isTuiAgent(agent)) {
    throw invalid(`--agent "${agent}" is not a supported agent`)
  }
  const preset: LoopPreset =
    getEnumFlag(flags, 'preset', ['until-done', 'interval', 'queue'] as const) ?? 'until-done'
  const prompt = getOptionalStringFlag(flags, 'prompt')
  const queueItems = getRepeatedStringFlag(flags, 'queue-item')
  const every = getOptionalPositiveIntegerFlag(flags, 'every')
  const anchor = getEnumFlag(flags, 'anchor', ['from-end', 'wall-clock'] as const)
  const repeatQueue = getBooleanFlag(flags, 'repeat-queue')

  if (preset === 'queue') {
    if (queueItems.length === 0) {
      throw invalid('A queue loop needs at least one --queue-item')
    }
    if (prompt !== undefined) {
      throw invalid(
        '--prompt is for until-done and interval loops; use --queue-item with --preset queue'
      )
    }
  } else {
    if (prompt === undefined) {
      throw invalid(`A ${preset} loop needs --prompt`)
    }
    if (queueItems.length > 0 || repeatQueue !== undefined) {
      throw invalid('--queue-item and --repeat-queue need --preset queue')
    }
  }
  if (preset === 'interval') {
    if (every === undefined) {
      throw invalid('An interval loop needs --every <minutes>')
    }
  } else if (every !== undefined || anchor !== undefined) {
    throw invalid('--every and --anchor need --preset interval')
  }

  const session: LoopSessionPolicy =
    getEnumFlag(flags, 'session', ['fresh', 'continue'] as const) ??
    defaultSessionPolicyForPreset(preset)
  const checkCommand = getOptionalStringFlag(flags, 'check')
  const checkTimeout = getCheckTimeoutFlag(flags)
  const checkWhen = getEnumFlag(flags, 'check-when', ['every-iteration', 'on-claim'] as const)
  if (checkCommand === undefined && (checkTimeout !== undefined || checkWhen !== undefined)) {
    throw invalid('--check-timeout and --check-when need --check')
  }
  const evaluator = getOptionalStringFlag(flags, 'evaluator')
  const protectedPaths = getRepeatedStringFlag(flags, 'protected-path')

  const config: LoopConfig = {
    promptSource:
      preset === 'queue'
        ? { kind: 'queue', repeatQueue: repeatQueue ?? false }
        : { kind: 'repeat', body: prompt ?? '' },
    pacing:
      preset === 'interval'
        ? { kind: 'interval', minutes: every ?? 1, anchor: anchor ?? 'from-end' }
        : { kind: 'on-idle' },
    sessionPolicy: session,
    done: {
      ...(checkCommand === undefined
        ? {}
        : {
            check: {
              command: checkCommand,
              timeoutSeconds: checkTimeout ?? DEFAULT_CHECK_TIMEOUT_SECONDS,
              runWhen: checkWhen ?? 'every-iteration'
            }
          }),
      ...(evaluator === undefined ? {} : { evaluator: { condition: evaluator } })
    },
    caps: readCapsFlags(flags),
    noProgress: getBooleanFlag(flags, 'no-progress') ?? false,
    ...(protectedPaths.length === 0 ? {} : { protectedPaths }),
    checkpointCommits: getBooleanFlag(flags, 'checkpoint-commits') ?? false,
    askBeforeNext: getBooleanFlag(flags, 'ask-before-next') ?? false,
    resumeAtLimitReset: getBooleanFlag(flags, 'resume-at-reset') ?? false
  }
  return {
    input: {
      name: getOptionalStringFlag(flags, 'name') ?? `${agent} ${preset}`,
      agent,
      preset,
      config
    },
    queueItems
  }
}

async function resolveWorktreeId(context: HandlerContext, requested: string): Promise<string> {
  const selector = await resolveHeimdallWorkspaceSelector(requested, context.cwd, context.client)
  const response = await context.client.call<{ worktree: { id: string } }>('worktree.show', {
    worktree: selector
  })
  return response.result.worktree.id
}

function requireLoopId(flags: Flags): string {
  return getRequiredStringFlag(flags, 'loop-id')
}

/**
 * Builds a partial config patch from the edit flags, merging each touched section with the
 * loop's current config because the runtime replaces whole sections rather than fields.
 */
function buildEditPatch(flags: Flags, current: LoopConfig): LoopEditPatch {
  const patch: LoopEditPatch = {}
  const name = getOptionalStringFlag(flags, 'name')
  if (name !== undefined) {
    patch.name = name
  }

  const prompt = getOptionalStringFlag(flags, 'prompt')
  const repeatQueue = getBooleanFlag(flags, 'repeat-queue')
  if (prompt !== undefined) {
    if (current.promptSource.kind !== 'repeat') {
      throw invalid('--prompt does not apply to a queue loop')
    }
    patch.promptSource = { kind: 'repeat', body: prompt }
  }
  if (repeatQueue !== undefined) {
    if (current.promptSource.kind !== 'queue') {
      throw invalid('--repeat-queue only applies to a queue loop')
    }
    patch.promptSource = { kind: 'queue', repeatQueue }
  }

  const every = getOptionalPositiveIntegerFlag(flags, 'every')
  const anchor = getEnumFlag(flags, 'anchor', ['from-end', 'wall-clock'] as const)
  if (every !== undefined || anchor !== undefined) {
    const pacing = current.pacing
    if (pacing.kind !== 'interval') {
      throw invalid('--every and --anchor only apply to an interval loop')
    }
    patch.pacing = {
      kind: 'interval',
      minutes: every ?? pacing.minutes,
      anchor: anchor ?? pacing.anchor
    }
  }

  const session = getEnumFlag(flags, 'session', ['fresh', 'continue'] as const)
  if (session !== undefined) {
    patch.sessionPolicy = session
  }

  const checkCommand = getOptionalStringFlag(flags, 'check')
  const checkTimeout = getCheckTimeoutFlag(flags)
  const checkWhen = getEnumFlag(flags, 'check-when', ['every-iteration', 'on-claim'] as const)
  const evaluator = getOptionalStringFlag(flags, 'evaluator')
  const clearCheck = isClearFlagSet(flags, 'no-check')
  const clearEvaluator = isClearFlagSet(flags, 'no-evaluator')
  if (
    clearCheck &&
    (checkCommand !== undefined || checkTimeout !== undefined || checkWhen !== undefined)
  ) {
    throw invalid('--no-check cannot be combined with --check, --check-timeout, or --check-when')
  }
  if (clearEvaluator && evaluator !== undefined) {
    throw invalid('--no-evaluator cannot be combined with --evaluator')
  }
  if (
    clearCheck ||
    clearEvaluator ||
    checkCommand !== undefined ||
    checkTimeout !== undefined ||
    checkWhen !== undefined ||
    evaluator !== undefined
  ) {
    const check = current.done.check
    const command = checkCommand ?? check?.command
    const touchesCheck =
      checkCommand !== undefined || checkTimeout !== undefined || checkWhen !== undefined
    if (touchesCheck && command === undefined) {
      throw invalid('--check-timeout and --check-when need a check; pass --check <command>')
    }
    const nextCheck =
      touchesCheck && command !== undefined
        ? {
            command,
            timeoutSeconds: checkTimeout ?? check?.timeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS,
            runWhen: checkWhen ?? check?.runWhen ?? 'every-iteration'
          }
        : check
    const nextEvaluator =
      evaluator === undefined ? current.done.evaluator : { condition: evaluator }
    patch.done = {
      ...(clearCheck || nextCheck === undefined ? {} : { check: nextCheck }),
      ...(clearEvaluator || nextEvaluator === undefined ? {} : { evaluator: nextEvaluator })
    }
  }

  const caps = readCapsFlags(flags)
  const clearedCaps = CAP_CLEAR_FLAGS.filter(({ flag }) => isClearFlagSet(flags, flag))
  for (const { flag, cap } of clearedCaps) {
    if (caps[cap] !== undefined) {
      throw invalid(`--${flag} cannot be combined with --${CAP_SET_FLAG[cap]}`)
    }
  }
  if (Object.keys(caps).length > 0 || clearedCaps.length > 0) {
    const nextCaps: LoopConfig['caps'] = { ...current.caps, ...caps }
    for (const { cap } of clearedCaps) {
      delete nextCaps[cap]
    }
    patch.caps = nextCaps
  }

  const noProgress = getBooleanFlag(flags, 'no-progress')
  if (noProgress !== undefined) {
    patch.noProgress = noProgress
  }
  const protectedPaths = getRepeatedStringFlag(flags, 'protected-path')
  if (isClearFlagSet(flags, 'no-protected-paths')) {
    if (protectedPaths.length > 0) {
      throw invalid('--no-protected-paths cannot be combined with --protected-path')
    }
    patch.protectedPaths = []
  } else if (protectedPaths.length > 0) {
    patch.protectedPaths = protectedPaths
  }
  const checkpointCommits = getBooleanFlag(flags, 'checkpoint-commits')
  if (checkpointCommits !== undefined) {
    patch.checkpointCommits = checkpointCommits
  }
  const askBeforeNext = getBooleanFlag(flags, 'ask-before-next')
  if (askBeforeNext !== undefined) {
    patch.askBeforeNext = askBeforeNext
  }
  const resumeAtLimitReset = getBooleanFlag(flags, 'resume-at-reset')
  if (resumeAtLimitReset !== undefined) {
    patch.resumeAtLimitReset = resumeAtLimitReset
  }

  if (Object.keys(patch).length === 0) {
    throw invalid('Nothing to edit; pass at least one setting flag')
  }
  return patch
}

async function callLoopMutation(
  context: HandlerContext,
  channel: string,
  params: Record<string, unknown>,
  verb: string
): Promise<void> {
  const response = await context.client.call<LoopSnapshot>(channel, params)
  printResult(response, context.json, (loop) => formatLoopChange(verb, loop))
}

export const LOOP_HANDLERS: Record<string, CommandHandler> = {
  'loop create': async (context) => {
    await requireLoopsCapability(context)
    const draft = buildCreateDraft(context.flags)
    const worktreeId = await resolveWorktreeId(
      context,
      getOptionalStringFlag(context.flags, 'worktree') ?? 'current'
    )
    const created = await context.client.call<LoopSnapshot>(LOOPS_CHANNELS.create, {
      worktreeId,
      ...draft.input,
      ...(draft.queueItems.length === 0 ? {} : { queueItems: draft.queueItems })
    })
    printResult(created, context.json, (loop) => formatLoopChange('Started', loop))
  },
  'loop list': async (context) => {
    await requireLoopsCapability(context)
    const requested = getOptionalStringFlag(context.flags, 'worktree')
    const worktreeId =
      requested === undefined ? undefined : await resolveWorktreeId(context, requested)
    const response = await context.client.call<LoopSnapshot[]>(
      LOOPS_CHANNELS.list,
      worktreeId === undefined ? {} : { worktreeId }
    )
    printResult(response, context.json, formatLoopList)
  },
  'loop show': async (context) => {
    await requireLoopsCapability(context)
    const response = await context.client.call<LoopSnapshot>(LOOPS_CHANNELS.get, {
      loopId: requireLoopId(context.flags)
    })
    printResult(response, context.json, formatLoopDetail)
  },
  'loop pause': async (context) => {
    await requireLoopsCapability(context)
    await callLoopMutation(
      context,
      LOOPS_CHANNELS.pause,
      { loopId: requireLoopId(context.flags), mode: 'after-iteration' },
      'Pausing'
    )
  },
  'loop resume': async (context) => {
    await requireLoopsCapability(context)
    const addIterations = getOptionalPositiveIntegerFlag(context.flags, 'add-iterations')
    await callLoopMutation(
      context,
      LOOPS_CHANNELS.resume,
      {
        loopId: requireLoopId(context.flags),
        ...(addIterations === undefined ? {} : { addIterations })
      },
      'Resumed'
    )
  },
  'loop stop': async (context) => {
    await requireLoopsCapability(context)
    await callLoopMutation(
      context,
      LOOPS_CHANNELS.stop,
      {
        loopId: requireLoopId(context.flags),
        mode: getBooleanFlag(context.flags, 'now') === true ? 'now' : 'after-iteration'
      },
      'Stopping'
    )
  },
  'loop steer': async (context) => {
    await requireLoopsCapability(context)
    await callLoopMutation(
      context,
      LOOPS_CHANNELS.steer,
      { loopId: requireLoopId(context.flags), text: getRequiredStringFlag(context.flags, 'text') },
      'Steered'
    )
  },
  'loop edit': async (context) => {
    await requireLoopsCapability(context)
    const loopId = requireLoopId(context.flags)
    const current = await context.client.call<LoopSnapshot>(LOOPS_CHANNELS.get, { loopId })
    const patch = buildEditPatch(context.flags, current.result.config)
    await callLoopMutation(context, LOOPS_CHANNELS.edit, { loopId, patch }, 'Edited')
  }
}
