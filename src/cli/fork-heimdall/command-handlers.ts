import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'
import {
  HEIMDALL_COMMANDS_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall/capability'
import type {
  WatcherCommand,
  WatcherCommandResult,
  WatcherDetail,
  WatcherFleetEntry
} from '../../shared/fork-heimdall/fleet-types'
import { OWNER_INTERVENTION_TEXT_MAX_LENGTH } from '../../shared/fork-heimdall/owner/intervention'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import { formatWatcherCommandResult } from './watcher-text-format'
import {
  latestApprovalScopeForEscalation,
  parseBudgetHours,
  parseBudgetTurns,
  parseWatcherConcurrency,
  requireAnswerText
} from './watcher-command-values'
import { resolveWatcherRow } from './watcher-row'

type CommandFactory = (
  row: WatcherFleetEntry,
  context: HandlerContext
) => WatcherCommand | Promise<WatcherCommand>

const CAPABILITY_DESCRIPTIONS: Record<string, string> = {
  [HEIMDALL_COMMANDS_RUNTIME_CAPABILITY]: 'Heimdall watcher commands',
  [HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY]: 'live objective concurrency changes',
  [HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY]: 'answering owner escalations',
  [HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY]: 'permanent watcher deletion'
}

async function runCommand(
  context: HandlerContext,
  watcherId: string,
  factory: CommandFactory,
  appliedText: (command: WatcherCommand) => string,
  extraCapability?: string
): Promise<void> {
  const status = await context.client.call<RuntimeStatus>('status.get')
  const capabilities = status.result.capabilities
  const missingCapability = !capabilities?.includes(HEIMDALL_COMMANDS_RUNTIME_CAPABILITY)
    ? HEIMDALL_COMMANDS_RUNTIME_CAPABILITY
    : extraCapability !== undefined && !capabilities.includes(extraCapability)
      ? extraCapability
      : undefined
  if (missingCapability !== undefined) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      `The running Quirky runtime does not support ${CAPABILITY_DESCRIPTIONS[missingCapability]}. Update or restart Quirky and try again.`
    )
  }

  const row = await resolveWatcherRow(context.client, watcherId)
  const command = await factory(row, context)
  const response = await context.client.call<WatcherCommandResult>(HEIMDALL_CHANNELS.command, {
    target: row.target,
    expectedOwner: row.ownerFence,
    command
  })
  if (response.result.status !== 'applied') {
    process.exitCode = 1
  }
  printResult(response, context.json, (result) =>
    formatWatcherCommandResult(result, appliedText(command))
  )
}

export const HEIMDALL_COMMAND_HANDLERS: Record<string, CommandHandler> = {
  'heimdall pause': async ({ flags, ...context }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    await runCommand(
      { flags, ...context },
      watcherId,
      () => ({ kind: 'pause' }),
      () => `Paused Heimdall watcher ${watcherId}.`
    )
  },
  'heimdall resume': async ({ flags, ...context }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    await runCommand(
      { flags, ...context },
      watcherId,
      () => ({ kind: 'resume' }),
      () => `Resumed Heimdall watcher ${watcherId}.`
    )
  },
  'heimdall disarm': async ({ flags, ...context }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    await runCommand(
      { flags, ...context },
      watcherId,
      () => ({ kind: 'disarm' }),
      () => `Disabled Heimdall watcher ${watcherId}.`
    )
  },
  'heimdall rm': async ({ flags, ...context }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    await runCommand(
      { flags, ...context },
      watcherId,
      () => ({ kind: 'delete' }),
      () => `Removed Heimdall watcher ${watcherId}.`,
      HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
    )
  },
  'heimdall approve': async ({ flags, ...context }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    const escalationId = getRequiredStringFlag(flags, 'escalation-id').trim()
    await runCommand(
      { flags, ...context },
      watcherId,
      async (row, handlerContext) => {
        const detail = await handlerContext.client.call<WatcherDetail>(
          HEIMDALL_CHANNELS.detail,
          row.target
        )
        const scope = latestApprovalScopeForEscalation(detail.result.ledger, escalationId)
        if (scope === null) {
          throw new RuntimeClientError(
            'invalid_argument',
            `Escalation ${escalationId} is not the latest unresolved approval for Heimdall watcher ${watcherId}`
          )
        }
        return { kind: 'approve', scope }
      },
      () => `Approved escalation ${escalationId} for Heimdall watcher ${watcherId}.`
    )
  },
  'heimdall answer': async ({ flags, ...context }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    const messageId = getRequiredStringFlag(flags, 'message-id').trim()
    const body = requireAnswerText(getRequiredStringFlag(flags, 'body'), 'body')
    await runCommand(
      { flags, ...context },
      watcherId,
      () => ({ kind: 'answer-question', messageId, body }),
      () => `Answered worker question ${messageId} for Heimdall watcher ${watcherId}.`
    )
  },
  'heimdall answer-escalation': async ({ flags, ...context }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    const escalationId = getRequiredStringFlag(flags, 'escalation-id').trim()
    const body = requireAnswerText(
      getRequiredStringFlag(flags, 'body'),
      'body',
      OWNER_INTERVENTION_TEXT_MAX_LENGTH
    )
    await runCommand(
      { flags, ...context },
      watcherId,
      () => ({ kind: 'answer-escalation', escalationId, body }),
      () => `Answered owner escalation ${escalationId} for Heimdall watcher ${watcherId}.`,
      HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY
    )
  },
  'heimdall stop-worker': async ({ flags, ...context }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    const dispatchId = getRequiredStringFlag(flags, 'dispatch-id').trim()
    await runCommand(
      { flags, ...context },
      watcherId,
      () => ({ kind: 'stop-worker', dispatchId }),
      () => `Requested stop for worker ${dispatchId} on Heimdall watcher ${watcherId}.`
    )
  },
  'heimdall budget': async ({ flags, ...context }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    const hours = parseBudgetHours(getOptionalStringFlag(flags, 'hours'))
    const turns = parseBudgetTurns(getOptionalStringFlag(flags, 'turns'))
    if (hours === undefined && turns === undefined) {
      throw new RuntimeClientError('invalid_argument', 'Specify --hours or --turns')
    }
    await runCommand(
      { flags, ...context },
      watcherId,
      (row) => {
        const current = row.entry.enrollment.budget
        const budget = {
          wallClockActiveMs: hours === undefined ? current.wallClockActiveMs : hours,
          turns: turns === undefined ? current.turns : turns
        }
        return { kind: 'adjust-budget', budget }
      },
      (command) => {
        if (command.kind !== 'adjust-budget') {
          return `Updated the budget for Heimdall watcher ${watcherId}.`
        }
        const hoursText =
          command.budget.wallClockActiveMs === null
            ? 'none'
            : `${command.budget.wallClockActiveMs / 3_600_000} hours`
        const turnsText = command.budget.turns === null ? 'none' : `${command.budget.turns} turns`
        return `Updated Heimdall watcher ${watcherId} budget to ${hoursText} / ${turnsText}.`
      }
    )
  },
  'heimdall set-concurrency': async ({ flags, ...context }) => {
    const watcherId = getRequiredStringFlag(flags, 'watcher-id')
    const maxConcurrency = parseWatcherConcurrency(getRequiredStringFlag(flags, 'max-concurrency'))
    let effectiveMaxConcurrency = maxConcurrency
    await runCommand(
      { flags, ...context },
      watcherId,
      (row) => {
        const kindPayload = row.entry.enrollment.kindPayload
        effectiveMaxConcurrency =
          row.entry.enrollment.kind === 'objective' &&
          typeof kindPayload === 'object' &&
          kindPayload !== null &&
          'workspaceKind' in kindPayload &&
          kindPayload.workspaceKind === 'folder'
            ? 1
            : maxConcurrency
        return { kind: 'set-concurrency', maxConcurrency: effectiveMaxConcurrency }
      },
      () => `Set Heimdall watcher ${watcherId} concurrency to ${effectiveMaxConcurrency}.`,
      HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
    )
  }
}
