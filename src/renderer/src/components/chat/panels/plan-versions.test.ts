import { describe, expect, it } from 'vitest'
import type {
  AgentJournalApprovalItem,
  AgentJournalRenderItem
} from '../../../../../shared/agent-session-journal-types'
import type { AgentJournalPlanItem } from '../../../../../shared/agent-session-journal-v1-items'
import type { StructuredPromptItem } from '../../native-chat/use-structured-agent-session'
import {
  planAnswerTarget,
  planVersionMarker,
  planVersionsNewestFirst,
  type PlanRenderItem
} from './plan-versions'

function planItem(
  version: number,
  status: AgentJournalPlanItem['status'],
  extra: Partial<AgentJournalPlanItem> = {},
  revision = 1
): AgentJournalRenderItem {
  return {
    itemId: `plan-${version}`,
    revision,
    sequence: version * 10,
    observedAt: version,
    body: { kind: 'plan', version, status, text: `plan ${version}`, ...extra }
  }
}

function approvalPrompt(
  itemId: string,
  state: 'pending' | 'resolved' = 'pending',
  options = [
    { id: 'allow', label: 'Approve plan' },
    { id: 'deny', label: 'Keep planning' }
  ]
): StructuredPromptItem {
  const body: AgentJournalApprovalItem = {
    kind: 'approval',
    title: 'Review proposed plan',
    detail: null,
    options,
    resolution: { state, selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
  return { itemId, revision: 1, sequence: 1, observedAt: 1, body }
}

function asPlan(item: AgentJournalRenderItem): PlanRenderItem {
  const [plan] = planVersionsNewestFirst([item])
  if (!plan) {
    throw new Error('not a plan item')
  }
  return plan
}

describe('planVersionsNewestFirst', () => {
  it('lists every version, newest first, ignoring other kinds', () => {
    const visual: AgentJournalRenderItem = {
      itemId: 'v',
      revision: 1,
      sequence: 5,
      observedAt: 5,
      body: {
        kind: 'visual',
        viewId: 'v1',
        version: 1,
        placement: 'pane',
        spec: { head: '{}', byteLength: 2, digest: 'd', truncated: false }
      }
    }
    const versions = planVersionsNewestFirst([
      planItem(1, 'revised'),
      visual,
      planItem(3, 'waiting'),
      planItem(2, 'revised')
    ])
    expect(versions.map((item) => item.body.version)).toEqual([3, 2, 1])
  })

  it('keeps the newest revision when a version appears twice', () => {
    const versions = planVersionsNewestFirst([
      planItem(1, 'waiting', {}, 1),
      planItem(1, 'approved', {}, 2)
    ])
    expect(versions).toHaveLength(1)
    expect(versions[0]?.body.status).toBe('approved')
  })
})

describe('planVersionMarker', () => {
  it('names a later waiting version as revised or unchanged', () => {
    expect(planVersionMarker(asPlan(planItem(1, 'waiting')).body)).toBe('v1 · waiting')
    expect(planVersionMarker(asPlan(planItem(2, 'waiting')).body)).toBe('v2 · waiting · revised')
    expect(planVersionMarker(asPlan(planItem(2, 'waiting', { unchanged: true })).body)).toBe(
      'v2 · waiting · unchanged'
    )
  })

  it('words not-answered with a space', () => {
    expect(planVersionMarker(asPlan(planItem(1, 'not-answered')).body)).toBe('v1 · not answered')
  })
})

describe('planAnswerTarget', () => {
  const waiting = asPlan(planItem(2, 'waiting', { approvalItemId: 'appr-2' }))

  it('offers answers on a waiting version whose approval is pending', () => {
    const target = planAnswerTarget(waiting, [approvalPrompt('appr-2')])
    expect(target?.prompt.itemId).toBe('appr-2')
    expect(target?.approveOptionId).toBe('allow')
    expect(target?.keepOptionId).toBe('deny')
  })

  it.each(['revised', 'approved', 'not-answered'] as const)(
    'offers nothing on a %s version',
    (status) => {
      const plan = asPlan(planItem(1, status, { approvalItemId: 'appr-1' }))
      expect(planAnswerTarget(plan, [approvalPrompt('appr-1')])).toBeNull()
    }
  )

  it('offers nothing when no pending prompt matches the approval id', () => {
    expect(planAnswerTarget(waiting, [approvalPrompt('other')])).toBeNull()
    expect(planAnswerTarget(waiting, [approvalPrompt('appr-2', 'resolved')])).toBeNull()
    expect(planAnswerTarget(waiting, [])).toBeNull()
  })

  it('offers nothing when the plan names no approval', () => {
    const plan = asPlan(planItem(2, 'waiting'))
    expect(planAnswerTarget(plan, [approvalPrompt('appr-2')])).toBeNull()
  })

  it('cannot approve an empty plan', () => {
    const plan = asPlan(planItem(2, 'waiting', { approvalItemId: 'appr-2', empty: true }))
    const target = planAnswerTarget(plan, [approvalPrompt('appr-2')])
    expect(target?.approveOptionId).toBeNull()
    expect(target?.keepOptionId).toBe('deny')
  })
})
