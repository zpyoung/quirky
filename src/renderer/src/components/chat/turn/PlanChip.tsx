import { ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { AgentJournalPlanItem } from '../../../../../shared/agent-session-journal-v1-items'
import type { RenderItemOf } from '../chat-turns'
import { useChatTurnEnv } from './chat-turn-env'

const STATUS_WORDS: Record<AgentJournalPlanItem['status'], string> = {
  waiting: 'waiting for your decision',
  revised: 'revised',
  approved: 'approved',
  'not-answered': 'not answered'
}

/** "Plan v2 · approved": what one plan version shows on its chip. */
export function planChipText(plan: AgentJournalPlanItem): string {
  const state = plan.empty ? 'empty' : plan.unchanged ? 'unchanged' : STATUS_WORDS[plan.status]
  return `Plan v${plan.version} · ${state}`
}

/** A plan version in the turn; it opens the plan panel on that version. */
export function PlanChip({ item }: { item: RenderItemOf<'plan'> }): React.JSX.Element {
  const { onOpenPlan } = useChatTurnEnv()
  const { version, status } = item.body
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="self-start"
      data-chat-row="plan"
      data-plan-status={status}
      disabled={onOpenPlan === undefined}
      onClick={() => onOpenPlan?.(version)}
    >
      <ListChecks aria-hidden="true" />
      {planChipText(item.body)}
    </Button>
  )
}
