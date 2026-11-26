import { computerUseErrorRecoveryData } from '../shared/computer-use-error-recovery'
import {
  matchAutomationOwnerConflict,
  stripAutomationOwnerConflictCode
} from '../shared/automation-owner-conflict'
import {
  normalizeErrorCode,
  requiresNext,
  type NextStep,
  type StableErrorCode
} from '../shared/public-rpc/error-contract'
import { automationOwnerConflictRecovery } from './automation-owner-conflict-recovery'
import { rawCliErrorCode } from './public-cli/exit-codes'
import { quoteCliCommandArgument } from './shell-command-quote'
import { worktreeSelectorRecovery } from './worktree-selector-recovery'
import { selectorAmbiguityRecovery } from './selector-ambiguity-recovery'
import type { RuntimeRpcFailure } from './runtime-client'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime/types'

export type CliErrorContext = {
  commandPath?: readonly string[]
  /** The invocation's argv, used to spell the `--yes` re-run for a confirmation prompt. */
  rawArgs?: readonly string[]
  /** The `--worktree` value this invocation sent; the runtime's error never echoes it. */
  worktreeSelector?: string
  /** The `--repo` value this invocation sent, for the same reason. */
  repoSelector?: string
  /** True when --environment, --pairing-code, --host runtime:, or their env vars chose a server. */
  remoteServerSelected?: boolean
  /** Report the stable code in `error.code`; unset, legacy commands keep their original code there. */
  publicContract?: true
}

// errors are marked, not contexts, because index.ts builds the context without knowing which handler ran
const publicContractErrors = new WeakSet<object>()

/** Marks an error raised by a public-contract command so `reportCliError` gives it the stable `error.code`. */
export function markPublicContractError<T>(error: T): T {
  if (typeof error === 'object' && error !== null) {
    publicContractErrors.add(error)
  }
  return error
}

const PUBLIC_CONTRACT_COMMAND_ROOTS: ReadonlySet<string> = new Set([
  'rpc',
  'schema',
  'events',
  'ui',
  'action',
  'layout',
  'chat',
  'settings',
  'notifications',
  'plugins'
])

function usesPublicContract(error: unknown, context: CliErrorContext): boolean {
  return (
    context.publicContract === true ||
    (typeof error === 'object' && error !== null && publicContractErrors.has(error)) ||
    PUBLIC_CONTRACT_COMMAND_ROOTS.has(context.commandPath?.[0] ?? '')
  )
}

type ContextRecovery = { nextSteps: readonly string[] } & Record<string, unknown>

const STALE_HANDLE_SERVER_HINT =
  'Terminal handles belong to the Quirky server that issued them. If this handle came from a paired server (for example `quirky terminal list --environment <server>`), pass the same --environment <server> to this command.'

function contextRecovery(
  code: string | undefined,
  context: CliErrorContext
): ContextRecovery | undefined {
  if (code === 'selector_not_found' && context.worktreeSelector) {
    return worktreeSelectorRecovery(context.worktreeSelector)
  }
  if (code === 'selector_ambiguous') {
    return selectorAmbiguityRecovery({
      repo: context.repoSelector,
      worktree: context.worktreeSelector,
      remoteServerSelected: context.remoteServerSelected
    })
  }
  // Why: a paired server's handle sent to this machine reads as a dead terminal, not a missing flag.
  if (
    code === 'terminal_handle_stale' &&
    context.commandPath?.[0] === 'terminal' &&
    context.remoteServerSelected === false
  ) {
    return { nextSteps: [STALE_HANDLE_SERVER_HINT] }
  }
  return undefined
}

function errorData(error: unknown): unknown {
  if (error instanceof RuntimeRpcFailureError) {
    return error.response.error.data
  }
  return error instanceof RuntimeClientError ? error.data : undefined
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof RuntimeRpcFailureError) {
    return error.response.error.code
  }
  return error instanceof RuntimeClientError ? error.code : undefined
}

/** The human message plus `Next: <command>  (<why>)` lines for follow-ups the runtime or contract names. */
export function formatCliError(error: unknown, context: CliErrorContext = {}): string {
  const message = formatCliErrorMessage(error, context)
  const next = textNextSteps(error)
  return next.length === 0 ? message : `${message}\n${next.map(formatNextStep).join('\n')}`
}

function formatCliErrorMessage(error: unknown, context: CliErrorContext): string {
  const message = error instanceof Error ? error.message : String(error)
  const selector = contextRecovery(errorCode(error), context)
  if (selector) {
    return formatMessageWithNextSteps(
      message,
      nextStepsFromData(mergeContextRecovery(errorData(error), selector))
    )
  }
  if (error instanceof RuntimeClientError && error.code === 'runtime_unavailable') {
    if (hasOrchestrationRequestId(error.data)) {
      return message
    }
    return `${message}\nQuirky is not running. Run 'quirky open' first.`
  }
  // Why: error-specific recovery must win over the generic computer fallback.
  // Classified from the whole error, not just `.code`: a hop that flattens the class leaves only the token.
  const conflict = automationOwnerConflictRecovery(matchAutomationOwnerConflict(error))
  if (conflict) {
    return formatMessageWithNextSteps(stripAutomationOwnerConflictCode(message), conflict.nextSteps)
  }
  if (error instanceof RuntimeClientError) {
    const nextSteps = nextStepsFromData(error.data)
    if (nextSteps.length > 0) {
      return formatMessageWithNextSteps(message, nextSteps)
    }
    if (error.code === 'invalid_argument' && context.commandPath?.[0] === 'computer') {
      return formatMessageWithNextSteps(
        message,
        computerUseErrorRecoveryData('invalid_argument')?.nextSteps ?? []
      )
    }
  }
  if (
    error instanceof RuntimeRpcFailureError &&
    error.response.error.code === 'runtime_unavailable'
  ) {
    return `${message}\nQuirky is not running. Run 'quirky open' first.`
  }
  if (error instanceof RuntimeRpcFailureError) {
    return formatMessageWithNextSteps(message, nextStepsFromData(error.response.error.data))
  }
  return message
}

function hasOrchestrationRequestId(data: unknown): boolean {
  return (
    data !== null &&
    typeof data === 'object' &&
    typeof (data as { orchestrationRequestId?: unknown }).orchestrationRequestId === 'string'
  )
}

export function reportCliError(error: unknown, json: boolean, context: CliErrorContext = {}): void {
  const selector = contextRecovery(errorCode(error), context)
  if (json) {
    let response: RuntimeRpcFailure
    if (error instanceof RuntimeRpcFailureError) {
      const recovered = withAutomationOwnerConflictRecovery(error.response)
      response = selector
        ? {
            ...recovered,
            error: {
              ...recovered.error,
              data: mergeContextRecovery(recovered.error.data, selector)
            }
          }
        : recovered
    } else {
      response = {
        id: 'local',
        ok: false,
        error: {
          code: rawCliErrorCode(error),
          message: stripAutomationOwnerConflictCode(
            error instanceof Error ? error.message : String(error)
          ),
          data: localCliErrorData(error, context)
        },
        _meta: {
          runtimeId: null
        }
      }
    }
    console.log(
      JSON.stringify(
        withStableErrorContract(response, context, usesPublicContract(error, context)),
        null,
        2
      )
    )
  } else {
    console.error(formatCliError(error, context))
  }
}

const RUNTIME_PREDATES_PUBLIC_CLI: NextStep = {
  command: 'quirky status',
  why: 'runtime predates public-cli.v1; update it'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nextStepsSentIn(data: unknown): NextStep[] {
  if (!isRecord(data) || !Array.isArray(data.next)) {
    return []
  }
  return data.next.flatMap((entry: unknown): NextStep[] =>
    isRecord(entry) && typeof entry.command === 'string' && entry.command.length > 0
      ? [{ command: entry.command, why: typeof entry.why === 'string' ? entry.why : '' }]
      : []
  )
}

function formatNextStep(step: NextStep): string {
  return step.why ? `Next: ${step.command}  (${step.why})` : `Next: ${step.command}`
}

function confirmCommand(context: CliErrorContext): string | null {
  const args = context.rawArgs ?? context.commandPath
  if (!args || args.length === 0) {
    return null
  }
  const spelled = args.map(quoteCliCommandArgument).join(' ')
  return args.includes('--yes') ? `quirky ${spelled}` : `quirky ${spelled} --yes`
}

/** Generic follow-ups for a stable code whose error carried none, so an agent always has a next move. */
function genericNextSteps(
  normalized: { code: StableErrorCode; reason: string },
  context: CliErrorContext
): NextStep[] {
  const command = context.commandPath?.join(' ')
  const schemaStep: NextStep = {
    command: command ? `quirky schema ${command}` : 'quirky schema',
    why: 'check the command and its inputs'
  }
  switch (normalized.code) {
    case 'unavailable':
      return [
        normalized.reason === 'capability_missing'
          ? RUNTIME_PREDATES_PUBLIC_CLI
          : { command: 'quirky status', why: 'check that Quirky is running and what it supports' }
      ]
    case 'invalid_argument':
      return command ? [schemaStep] : []
    case 'not_found':
      return [schemaStep]
    case 'needs_confirmation': {
      const confirm = confirmCommand(context)
      return [confirm ? { command: confirm, why: 'run again with --yes to confirm' } : schemaStep]
    }
    case 'conflict':
      return [{ command: 'quirky status', why: 'state changed; check it, then retry' }]
    case 'internal':
    case 'timeout':
    case 'unauthorized':
      return []
  }
}

/** Text mode shows what the runtime sent, plus the compat hint for a runtime that lacks the method. */
function textNextSteps(error: unknown): NextStep[] {
  const sent = nextStepsSentIn(errorData(error))
  if (sent.length > 0) {
    return sent
  }
  const normalized = normalizeErrorCode(rawCliErrorCode(error))
  return normalized.code === 'unavailable' && normalized.reason === 'capability_missing'
    ? [RUNTIME_PREDATES_PUBLIC_CLI]
    : []
}

/**
 * Adds the public error contract to a failure: the specific cause in `error.data.reason` and
 * `error.data.next` wherever the contract requires it. A public command also gets the stable code in
 * `error.code`; a legacy command keeps its original code there and carries the stable one in
 * `error.data.stableCode`, so scripts written before the contract keep working.
 */
function withStableErrorContract(
  response: RuntimeRpcFailure,
  context: CliErrorContext,
  publicContract: boolean
): RuntimeRpcFailure {
  const normalized = normalizeErrorCode(response.error.code)
  const sent = response.error.data
  const base: Record<string, unknown> = isRecord(sent)
    ? sent
    : sent === undefined
      ? {}
      : { detail: sent }
  const reason =
    typeof base.reason === 'string'
      ? base.reason
      : normalized.reason !== normalized.code
        ? normalized.reason
        : undefined
  const sentNext = nextStepsSentIn(base)
  const next =
    sentNext.length > 0
      ? sentNext
      : requiresNext(normalized.code) || normalized.code === 'invalid_argument'
        ? genericNextSteps(normalized, context)
        : []
  const data = {
    ...base,
    ...(publicContract ? {} : { stableCode: normalized.code }),
    ...(reason === undefined ? {} : { reason }),
    ...(next.length === 0 ? {} : { next })
  }
  return {
    ...response,
    error: {
      code: publicContract ? normalized.code : response.error.code,
      message: response.error.message,
      ...(Object.keys(data).length === 0 ? {} : { data })
    }
  }
}

/** Machine-readable half of the same recovery the human message carries. */
function withAutomationOwnerConflictRecovery(response: RuntimeRpcFailure): RuntimeRpcFailure {
  const code = matchAutomationOwnerConflict(response)
  const conflict = automationOwnerConflictRecovery(code)
  if (!conflict || !code) {
    return response
  }
  return {
    ...response,
    error: {
      ...response.error,
      // Restores the classification a flattening hop dropped, so --json consumers read the conflict, not the transport.
      code,
      message: stripAutomationOwnerConflictCode(response.error.message),
      data: response.error.data ?? conflict
    }
  }
}

function formatMessageWithNextSteps(message: string, nextSteps: readonly string[]): string {
  if (nextSteps.length === 0) {
    return message
  }
  return `${message}\n${nextSteps.map((step) => `Next step: ${step}`).join('\n')}`
}

/** Why merge: a mutation error already carries its request id, and `??` dropped the selector grammar. */
function mergeContextRecovery(
  data: unknown,
  selector: ReturnType<typeof contextRecovery>
): unknown {
  if (!selector) {
    return data
  }
  if (data === null || typeof data !== 'object') {
    return selector
  }
  return {
    ...selector,
    ...data,
    nextSteps: [...selector.nextSteps, ...nextStepsFromData(data)]
  }
}

function nextStepsFromData(data: unknown): string[] {
  if (
    data &&
    typeof data === 'object' &&
    Array.isArray((data as { nextSteps?: unknown }).nextSteps)
  ) {
    return (data as { nextSteps: unknown[] }).nextSteps.filter(
      (step): step is string => typeof step === 'string'
    )
  }
  return []
}

function localCliErrorData(error: unknown, context: CliErrorContext): unknown {
  const selector = contextRecovery(errorCode(error), context)
  // Why: error-specific recovery must win over the generic computer fallback.
  if (error instanceof RuntimeClientError && error.data !== undefined) {
    return mergeContextRecovery(error.data, selector)
  }
  if (selector) {
    return selector
  }
  const conflict = automationOwnerConflictRecovery(matchAutomationOwnerConflict(error))
  if (conflict) {
    return conflict
  }
  if (
    error instanceof RuntimeClientError &&
    error.code === 'invalid_argument' &&
    context.commandPath?.[0] === 'computer'
  ) {
    return computerUseErrorRecoveryData('invalid_argument')
  }
  return undefined
}
