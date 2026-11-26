import type { AgentJournalRenderItem } from '../../../../../shared/agent-session-journal-types'
import type { AgentJournalPlanItem } from '../../../../../shared/agent-session-journal-v1-items'
import type { StructuredPromptItem } from '../../native-chat/use-structured-agent-session'

export type PlanRenderItem = AgentJournalRenderItem & { body: AgentJournalPlanItem }

export function isPlanItem(item: AgentJournalRenderItem): item is PlanRenderItem {
  return item.body.kind === 'plan'
}

/** Claude's plan approval offers `allow` ("Approve plan") and `deny` ("Keep planning"). */
export const PLAN_APPROVE_OPTION_ID = 'allow'
export const PLAN_KEEP_OPTION_ID = 'deny'

const STATUS_WORDS: Record<AgentJournalPlanItem['status'], string> = {
  waiting: 'waiting',
  revised: 'revised',
  approved: 'approved',
  'not-answered': 'not answered'
}

export function planStatusWords(status: AgentJournalPlanItem['status']): string {
  return STATUS_WORDS[status]
}

/** Every plan version once, newest version first; a version seen twice keeps its newest revision. */
export function planVersionsNewestFirst(
  items: readonly AgentJournalRenderItem[]
): PlanRenderItem[] {
  const byVersion = new Map<number, PlanRenderItem>()
  for (const item of items) {
    if (!isPlanItem(item)) {
      continue
    }
    const held = byVersion.get(item.body.version)
    if (!held || item.revision >= held.revision) {
      byVersion.set(item.body.version, item)
    }
  }
  return [...byVersion.values()].sort((a, b) => b.body.version - a.body.version)
}

/** "v2 · waiting · revised": the version, its status, and for a waiting later version how it differs. */
export function planVersionMarker(plan: AgentJournalPlanItem): string {
  const parts = [`v${plan.version}`, planStatusWords(plan.status)]
  if (plan.status === 'waiting' && plan.version > 1) {
    parts.push(plan.unchanged === true ? 'unchanged' : 'revised')
  }
  return parts.join(' · ')
}

export type PlanAnswerTarget = {
  prompt: StructuredPromptItem
  /** Null when the plan cannot be approved, as when it is empty. */
  approveOptionId: string | null
  keepOptionId: string | null
}

/**
 * The pending approval a plan version can be answered through, or null when it cannot be: only a
 * waiting version whose own approval is still pending takes an answer.
 */
export function planAnswerTarget(
  plan: PlanRenderItem,
  prompts: readonly StructuredPromptItem[]
): PlanAnswerTarget | null {
  const { approvalItemId, status, empty } = plan.body
  if (status !== 'waiting' || approvalItemId === undefined) {
    return null
  }
  const prompt = prompts.find(
    (candidate) =>
      candidate.itemId === approvalItemId &&
      candidate.body.kind === 'approval' &&
      candidate.body.resolution.state === 'pending'
  )
  if (!prompt) {
    return null
  }
  const offered = new Set(prompt.body.options.map((option) => option.id))
  return {
    prompt,
    approveOptionId:
      empty !== true && offered.has(PLAN_APPROVE_OPTION_ID) ? PLAN_APPROVE_OPTION_ID : null,
    keepOptionId: offered.has(PLAN_KEEP_OPTION_ID) ? PLAN_KEEP_OPTION_ID : null
  }
}
