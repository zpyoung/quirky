import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_V1_CHAT_ITEMS_CAPABILITY } from '../../../../shared/protocol-version'
import { STRUCTURED_CLIENT } from './structured-agent-session-rpc.test-fixture'
import {
  projectV1Item,
  projectV1ItemEvent,
  projectV1ItemHistory
} from './structured-agent-session-v1-items-capability'

const USER_ITEM: AgentJournalRenderItem = {
  itemId: 'user-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }
}
const PLAN_ITEM: AgentJournalRenderItem = {
  itemId: 'plan-1',
  revision: 3,
  sequence: 7,
  sequenceIndex: 2,
  observedAt: 9,
  body: { kind: 'plan', version: 2, status: 'revised', text: 'Step one' }
}
const PLACEHOLDER_ITEM: AgentJournalRenderItem = {
  ...PLAN_ITEM,
  body: { kind: 'status', text: 'Update the app to see this.', tone: 'muted' }
}
const CURRENT_CLIENT = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    AGENT_SESSION_V1_CHAT_ITEMS_CAPABILITY
  ]
}

function page(items: AgentJournalRenderItem[]): AgentSessionHistoryPage {
  return {
    sessionId: 'session-1',
    epoch: 'a',
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: { epoch: 'a', sequence: 0 } },
    hasOlder: false,
    hasNewer: false
  }
}

const history: AgentSessionHistoryResult = { ok: true, page: page([USER_ITEM, PLAN_ITEM]) }
const batch: AgentSessionSubscribeEvent = {
  type: 'batch',
  sessionId: 'session-1',
  fence: 1,
  batch: {
    cursor: { epoch: 'a', sequence: 7 },
    items: [USER_ITEM, PLAN_ITEM],
    removedItemIds: [],
    submissions: []
  }
}

describe('v1 chat item capability at the RPC boundary', () => {
  it('publishes a status row with the envelope intact to a reader without the capability', () => {
    const projected = projectV1ItemHistory(STRUCTURED_CLIENT, history)
    expect(projected.page.items).toEqual([USER_ITEM, PLACEHOLDER_ITEM])
    expect(projected.page.items[0]).toBe(USER_ITEM)
    expect(PLAN_ITEM.body.kind).toBe('plan')

    const event = projectV1ItemEvent(STRUCTURED_CLIENT, batch)
    expect(event.type === 'batch' ? event.batch.items : []).toEqual([USER_ITEM, PLACEHOLDER_ITEM])
    expect(projectV1Item(STRUCTURED_CLIENT, PLAN_ITEM)).toEqual(PLACEHOLDER_ITEM)
  })

  it.each([
    ['capable client', CURRENT_CLIENT],
    ['in-process caller', {}]
  ] as const)('hands a %s the same objects back', (_label, ctx) => {
    expect(projectV1ItemHistory(ctx, history)).toBe(history)
    expect(projectV1ItemEvent(ctx, batch)).toBe(batch)
    expect(projectV1Item(ctx, PLAN_ITEM)).toBe(PLAN_ITEM)
  })

  it('returns the same object when nothing needs downgrading', () => {
    const plain: AgentSessionHistoryResult = { ok: true, page: page([USER_ITEM]) }
    expect(projectV1ItemHistory(STRUCTURED_CLIENT, plain)).toBe(plain)
    expect(projectV1Item(STRUCTURED_CLIENT, null)).toBeNull()
  })
})
