// The `plan` and `mode` journal items: identities, bodies and how an approval's resolution settles
// a plan version. Pure, so the host observer and its tests share one reading of an approval.

import type {
  AgentJournalApprovalItem,
  AgentJournalItemIdentity,
  AgentJournalResolution
} from '../../../shared/agent-session-journal-types'
import { isPlanApprovalSubject } from '../../../shared/agent-session-approval-subject'
import type {
  AgentJournalChatMode,
  AgentJournalModeItem,
  AgentJournalPlanItem
} from '../../../shared/agent-session-journal-v1-items'

/** One row per plan version, so a resolution revises the row the proposal wrote. */
export function planIdentity(version: number): AgentJournalItemIdentity {
  return { provider: 'quirky', clientMessageId: `plan:${version}` }
}

/** One row per mode change, numbered from 1 in the order written. */
export function modeIdentity(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'quirky', clientMessageId: `mode:${ordinal}` }
}

/** The waiting plan for a plan approval; null for any other approval. `previousText` is the text
 *  of the last version, which a repeat of is flagged `unchanged`. */
export function waitingPlanItem(
  approval: AgentJournalApprovalItem,
  approvalItemId: string,
  version: number,
  previousText: string | null
): AgentJournalPlanItem | null {
  if (!isPlanApprovalSubject(approval.subject)) {
    return null
  }
  const { text, filePath } = approval.subject
  const empty = text.trim() === ''
  return {
    kind: 'plan',
    version,
    status: 'waiting',
    text,
    ...(filePath ? { filePath } : {}),
    approvalItemId,
    ...(empty ? { empty: true } : {}),
    ...(!empty && text === previousText ? { unchanged: true } : {})
  }
}

export type PlanSettlement = Pick<AgentJournalPlanItem, 'status' | 'reason'>

/** How an approval's resolution ends a plan; null while it still waits. A cancelled approval is
 *  `stopped`, or `restarted` when it outlived the host process that raised it. */
export function planSettlement(
  resolution: AgentJournalResolution,
  outlivedHost: boolean
): PlanSettlement | null {
  if (resolution.state === 'pending') {
    return null
  }
  const choice = resolution.selectedOptionId
  if (resolution.state === 'resolved' && (choice === 'allow' || choice === 'allowForSession')) {
    return { status: 'approved' }
  }
  if (resolution.state === 'resolved' && choice === 'deny') {
    return { status: 'revised' }
  }
  return { status: 'not-answered', reason: outlivedHost ? 'restarted' : 'stopped' }
}

/** The plan row after `settlement`: the proposal with its status and reason replaced. */
export function settledPlanItem(
  plan: AgentJournalPlanItem,
  settlement: PlanSettlement
): AgentJournalPlanItem {
  const { reason: _open, ...rest } = plan
  return {
    ...rest,
    status: settlement.status,
    ...(settlement.reason ? { reason: settlement.reason } : {})
  }
}

export function modeItem(
  mode: AgentJournalChatMode,
  previous: AgentJournalChatMode | undefined
): AgentJournalModeItem {
  return { kind: 'mode', mode, ...(previous ? { previous } : {}) }
}
