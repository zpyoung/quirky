// Transitional: remove once no supported release lacks AGENT_SESSION_V1_CHAT_ITEMS_CAPABILITY.
//
// A client that predates the plan, turn-changes, mode, fork, visual and test-result items would
// draw the unknown kind as nothing or as raw text, so the host publishes a status row in its place
// at the RPC boundary only. The journal and every in-process reader keep the canonical body.

import { isV1ChatItemKind } from '../../../../shared/agent-session-journal-v1-items'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_V1_CHAT_ITEMS_CAPABILITY } from '../../../../shared/protocol-version'
import type { RpcContext } from '../core'

type V1ItemReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

function readsV1Items(ctx: V1ItemReader): boolean {
  // An in-process caller is this build; only a negotiated client can predate the items.
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_V1_CHAT_ITEMS_CAPABILITY) === true
  )
}

function placeholder(item: AgentJournalRenderItem): AgentJournalRenderItem {
  return {
    ...item,
    body: { kind: 'status', text: 'Update the app to see this.', tone: 'muted' }
  }
}

function projectItems(items: AgentJournalRenderItem[]): AgentJournalRenderItem[] {
  if (!items.some((item) => isV1ChatItemKind(item.body.kind))) {
    return items
  }
  return items.map((item) => (isV1ChatItemKind(item.body.kind) ? placeholder(item) : item))
}

function projectPage(page: AgentSessionHistoryPage): AgentSessionHistoryPage {
  const items = projectItems(page.items)
  return items === page.items ? page : { ...page, items }
}

export function projectV1ItemHistory(
  ctx: V1ItemReader,
  result: AgentSessionHistoryResult
): AgentSessionHistoryResult {
  if (readsV1Items(ctx)) {
    return result
  }
  const page = projectPage(result.page)
  return page === result.page ? result : { ...result, page }
}

export function projectV1ItemEvent(
  ctx: V1ItemReader,
  event: AgentSessionSubscribeEvent
): AgentSessionSubscribeEvent {
  if (readsV1Items(ctx)) {
    return event
  }
  if (event.type === 'batch') {
    const items = projectItems(event.batch.items)
    return items === event.batch.items ? event : { ...event, batch: { ...event.batch, items } }
  }
  if (event.type === 'snapshot' || event.type === 'reset') {
    const page = projectPage(event.page)
    return page === event.page ? event : { ...event, page }
  }
  return event
}

/** `agentSession.item`'s reply; null (no such item) passes through. */
export function projectV1Item(
  ctx: V1ItemReader,
  item: AgentJournalRenderItem | null
): AgentJournalRenderItem | null {
  if (item === null || readsV1Items(ctx) || !isV1ChatItemKind(item.body.kind)) {
    return item
  }
  return placeholder(item)
}
