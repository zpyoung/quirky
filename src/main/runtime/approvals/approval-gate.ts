import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AttributedCaller } from '../../../shared/public-rpc/caller-hint'
import type { ApprovalCategory } from '../../../shared/public-rpc/public-method-spec'
import type { AskSpec } from '../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskRegistry } from '../../fork-ask-question-tool/ask-registry'
import { PublicRpcError } from '../rpc/public-rpc-error'

export const APPROVAL_TIMEOUT_MS = 600_000
const APPROVAL_QUESTION_ID = 'approve'
const APPROVAL_REQUEST_ID_PREFIX = 'approval-'

/** Whether an ask was registered by this gate, so only the app's own UI may answer it. */
export function isApprovalRequestId(requestId: string): boolean {
  return requestId.startsWith(APPROVAL_REQUEST_ID_PREFIX)
}

export type ApprovalMode = 'agent' | 'ask'
export type ApprovalRegistry = Pick<AskRegistry, 'register' | 'waitChunk' | 'cancel'>

export type ApprovalRequestOptions = {
  worktreeId?: string | null
  /** The pane whose card should show the question; without one nothing renders it until it times out. */
  paneKey?: string | null
  /** Aborts the wait, and cancels the question, when the requesting client goes away. */
  signal?: AbortSignal
}

type ApprovalGateDeps = {
  /** The raw `agentApprovalPolicy` setting; validated here so a malformed value reads as all `agent`. */
  readPolicy: () => unknown
  registry: () => ApprovalRegistry
}

const ApprovalPolicySchema = z.record(z.string(), z.enum(['agent', 'ask']))

/** The `agentApprovalPolicy` setting out of a store whose typed contract narrows `getSettings()`. */
export function readAgentApprovalPolicySetting(
  store: { getSettings(): object } | null | undefined
): unknown {
  const settings = store?.getSettings()
  return settings && 'agentApprovalPolicy' in settings ? settings.agentApprovalPolicy : undefined
}

function describeRequest(caller: AttributedCaller, summary: string, effects: string[]): string {
  const lines = [`${caller.label} wants to: ${summary}`]
  if (effects.length > 0) {
    lines.push('', ...effects.map((effect) => `- ${effect}`))
  }
  return lines.join('\n')
}

/**
 * Holds an agent's gated call until the user answers a confirm question in the app. The policy
 * setting decides which categories need that; everything else passes straight through.
 */
export class ApprovalGate {
  constructor(private readonly deps: ApprovalGateDeps) {}

  policyFor(category: ApprovalCategory): ApprovalMode {
    const parsed = ApprovalPolicySchema.safeParse(this.deps.readPolicy())
    return parsed.success ? (parsed.data[category] ?? 'agent') : 'agent'
  }

  /**
   * Resolves once the user approves. Throws `needs_confirmation` with reason `declined` when they
   * refuse or dismiss, and `timed_out` when no answer arrives within APPROVAL_TIMEOUT_MS.
   */
  async require(
    category: ApprovalCategory,
    caller: AttributedCaller,
    summary: string,
    effects: string[],
    options: ApprovalRequestOptions = {}
  ): Promise<'approved'> {
    const registry = this.deps.registry()
    const spec: AskSpec = {
      questions: [
        {
          id: APPROVAL_QUESTION_ID,
          type: 'confirm',
          header: 'Approval needed',
          question: describeRequest(caller, summary, effects),
          required: true,
          default: false
        }
      ]
    }
    const { askId } = await registry.register(
      spec,
      { paneKey: options.paneKey ?? null, worktreeId: options.worktreeId ?? null },
      { requestId: `${APPROVAL_REQUEST_ID_PREFIX}${category}-${randomUUID()}` }
    )
    const signal = options.signal ?? new AbortController().signal
    const envelope = await registry.waitChunk(askId, APPROVAL_TIMEOUT_MS, signal)
    switch (envelope.status) {
      case 'answered': {
        const answer = envelope.answers[APPROVAL_QUESTION_ID]
        if (answer && 'value' in answer && answer.value === true) {
          // a client that left mid-prompt must not have its mutation released by a late yes
          if (signal.aborted) {
            throw declined(summary)
          }
          return 'approved'
        }
        throw declined(summary)
      }
      case 'partial':
      case 'declined':
        throw declined(summary)
      case 'timed_out':
      case 'unavailable':
        throw timedOut(summary)
      case 'registered':
      case 'pending':
        registry.cancel(askId, 'agent')
        throw signal.aborted ? declined(summary) : timedOut(summary)
    }
  }
}

function declined(summary: string): PublicRpcError {
  return new PublicRpcError(
    'needs_confirmation',
    'declined',
    [{ command: 'stop and tell the user it was declined', why: 'retrying asks them again' }],
    undefined,
    `The user declined: ${summary}`
  )
}

function timedOut(summary: string): PublicRpcError {
  return new PublicRpcError(
    'needs_confirmation',
    'timed_out',
    [
      {
        command: 'retry once the user is at Quirky',
        why: 'the approval prompt was not answered in time'
      }
    ],
    undefined,
    `No answer within ${APPROVAL_TIMEOUT_MS / 1000}s for: ${summary}`
  )
}
