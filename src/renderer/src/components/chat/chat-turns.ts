import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../../shared/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../../shared/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../../shared/agent-session-turn-record'
import { agentTurnVerdict } from '../../../../shared/agent-turn-outcome'
import { namedSubagents } from '../../../../shared/native-chat-subagent-items'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'

/** How many agents a turn's Agents card lists before it folds them into one counts line. */
export const FOLD_AT = 4

export type RenderItemOf<K extends AgentJournalItemBody['kind']> = AgentJournalRenderItem & {
  body: Extract<AgentJournalItemBody, { kind: K }>
}

export type ChatTurnEnd = {
  state: 'done' | 'stopped' | 'failed' | 'interrupted'
  durationMs?: number
}

export type ChatBlock =
  | { type: 'prose'; itemId: string; text: string; streaming: boolean }
  | { type: 'activity'; calls: RenderItemOf<'tool-call'>[] }
  | { type: 'file-change'; item: RenderItemOf<'diff'> }
  | { type: 'test-result'; item: RenderItemOf<'test-result'> }
  | { type: 'ask'; item: RenderItemOf<'approval'> | RenderItemOf<'question'> }
  | { type: 'changes'; item: RenderItemOf<'turn-changes'> }
  | { type: 'plan'; item: RenderItemOf<'plan'> }
  | { type: 'visual'; item: RenderItemOf<'visual'> }
  | { type: 'agents'; agentIds: string[] }
  | { type: 'mode'; item: RenderItemOf<'mode'> }
  | { type: 'fork'; item: RenderItemOf<'fork'> }
  | { type: 'status'; item: RenderItemOf<'status'> | RenderItemOf<'message'> }
  | { type: 'error'; item: RenderItemOf<'status'> }

export type ChatTurn = {
  key: string
  at: number
  user: AgentJournalRenderItem | null
  blocks: ChatBlock[]
  end: ChatTurnEnd | null
}

function isKind<K extends AgentJournalItemBody['kind']>(
  item: AgentJournalRenderItem,
  kind: K
): item is RenderItemOf<K> {
  return item.body.kind === kind
}

type Draft = {
  turn: ChatTurn
  agents: Extract<ChatBlock, { type: 'agents' }> | null
}

/** Whether `next` is a later write of the same identity as `held`: by revision, then by the
 *  identity's own counter, then by journal order. */
function supersedes(
  next: AgentJournalRenderItem,
  held: AgentJournalRenderItem,
  counter: (item: AgentJournalRenderItem) => number
): boolean {
  if (next.revision !== held.revision) {
    return next.revision > held.revision
  }
  if (counter(next) !== counter(held)) {
    return counter(next) > counter(held)
  }
  return next.sequence >= held.sequence
}

const noCounter = (): number => 0
const versionOf = (item: AgentJournalRenderItem): number =>
  item.body.kind === 'plan' || item.body.kind === 'visual' ? item.body.version : 0

function endOf(record: AgentJournalTurnLifecycle): ChatTurnEnd | null {
  if (record.state === 'running') {
    return null
  }
  const verdict = agentTurnVerdict({ state: record.state, outcome: record.outcome ?? null })
  const start = record.startedAt ?? record.requestedAt
  const durationMs =
    record.durationMs ??
    (record.completedAt !== undefined && start !== undefined
      ? Math.max(0, record.completedAt - start)
      : undefined)
  const state: ChatTurnEnd['state'] =
    verdict === 'interruption' || verdict === 'unconfirmed'
      ? 'interrupted'
      : verdict === 'failure'
        ? 'failed'
        : verdict === 'cancellation' || verdict === 'superseded'
          ? 'stopped'
          : 'done'
  return { state, ...(durationMs === undefined ? {} : { durationMs }) }
}

function pushAgents(draft: Draft): Extract<ChatBlock, { type: 'agents' }> {
  const block: Extract<ChatBlock, { type: 'agents' }> = { type: 'agents', agentIds: [] }
  draft.turn.blocks.push(block)
  return block
}

function planApprovalIds(items: readonly AgentJournalRenderItem[]): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.body.kind === 'plan' && item.body.approvalItemId !== undefined) {
      ids.add(item.body.approvalItemId)
    }
  }
  return ids
}

/** Text of a message's blocks, joined, or the empty string when it has none. */
function textOf(blocks: readonly NativeChatBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n\n')
}

/**
 * The journal as turns. A user message opens a turn, and rows before the first one go in a turn
 * with no user. Everything else lands in the open turn in journal order, with one block per
 * identity: tool calls by `callId`, test results by `callId`, plans by version, visuals by view,
 * and changes by turn, each holding its newest revision where it first appeared. Rows a subagent
 * produced stay out except the roster blocks that name subagents, which gather into one
 * `agents` block per turn; background tasks have their own panel.
 */
export function projectChatTurns(
  items: readonly AgentJournalRenderItem[],
  _options: { sessionAgent: string }
): ChatTurn[] {
  const drafts: Draft[] = []
  const hiddenApprovals = planApprovalIds(items)
  const draftByUserItem = new Map<string, Draft>()
  const turnRecords: { record: AgentJournalTurnLifecycle; fallback: Draft | undefined }[] = []
  const calls = new Map<
    string,
    { item: RenderItemOf<'tool-call'>; list: RenderItemOf<'tool-call'>[] }
  >()
  const identities = new Map<
    string,
    { item: AgentJournalRenderItem; apply: (next: AgentJournalRenderItem) => void }
  >()

  const open = (first: AgentJournalRenderItem, user: AgentJournalRenderItem | null): Draft => {
    const draft: Draft = {
      turn: {
        key: user ? `turn-${user.itemId}` : `lead-${first.itemId}`,
        at: first.observedAt,
        user,
        blocks: [],
        end: null
      },
      agents: null
    }
    drafts.push(draft)
    if (user) {
      draftByUserItem.set(user.itemId, draft)
    }
    return draft
  }
  const current = (first: AgentJournalRenderItem): Draft => drafts.at(-1) ?? open(first, null)

  // a later write of a held identity replaces the item where its first write drew
  const revise = (
    identity: string,
    counter: (item: AgentJournalRenderItem) => number,
    item: AgentJournalRenderItem
  ): boolean => {
    const held = identities.get(identity)
    if (!held) {
      return false
    }
    if (supersedes(item, held.item, counter)) {
      held.apply(item)
      held.item = item
    }
    return true
  }
  const track = <K extends AgentJournalItemBody['kind']>(
    kind: K,
    identity: string,
    item: RenderItemOf<K>,
    block: { item: RenderItemOf<K> }
  ): void => {
    identities.set(identity, {
      item,
      apply: (next) => {
        if (isKind(next, kind)) {
          block.item = next
        }
      }
    })
  }

  for (const item of items) {
    const { body } = item
    const root = isRootAgentJournalItem(item)

    if (isKind(item, 'message') && item.body.role === 'user') {
      if (root) {
        open(item, item)
      }
      continue
    }
    const record = readAgentJournalTurn(body)
    if (record) {
      if (root) {
        turnRecords.push({ record, fallback: drafts.at(-1) })
      }
      continue
    }

    if (isKind(item, 'message')) {
      const draft = current(item)
      for (const block of item.body.blocks) {
        if (block.type === 'subagent' || block.type === 'subagent-group') {
          draft.agents ??= pushAgents(draft)
          for (const entry of namedSubagents(block)) {
            if (!draft.agents.agentIds.includes(entry.id)) {
              draft.agents.agentIds.push(entry.id)
            }
          }
        }
      }
      if (!root) {
        continue
      }
      if (item.body.role === 'assistant') {
        const text = textOf(item.body.blocks)
        const streaming = item.body.state === 'running'
        if (text.trim() !== '' || streaming) {
          draft.turn.blocks.push({ type: 'prose', itemId: item.itemId, text, streaming })
        }
      } else if (item.body.role === 'system' && textOf(item.body.blocks).trim() !== '') {
        draft.turn.blocks.push({ type: 'status', item })
      }
      continue
    }

    if (isKind(item, 'approval') || isKind(item, 'question')) {
      if (!hiddenApprovals.has(item.itemId)) {
        current(item).turn.blocks.push({ type: 'ask', item })
      }
      continue
    }
    if (!root) {
      continue
    }

    if (isKind(item, 'tool-call')) {
      const key = item.body.callId
      const held = key === undefined ? undefined : calls.get(key)
      if (held) {
        if (supersedes(item, held.item, noCounter)) {
          held.list[held.list.indexOf(held.item)] = item
          held.item = item
        }
        continue
      }
      const turn = current(item).turn
      const last = turn.blocks.at(-1)
      const block: Extract<ChatBlock, { type: 'activity' }> =
        last?.type === 'activity' ? last : { type: 'activity', calls: [] }
      if (block !== last) {
        turn.blocks.push(block)
      }
      block.calls.push(item)
      if (key !== undefined) {
        calls.set(key, { item, list: block.calls })
      }
    } else if (isKind(item, 'diff')) {
      current(item).turn.blocks.push({ type: 'file-change', item })
    } else if (isKind(item, 'test-result')) {
      const identity = `test:${item.body.callId}`
      if (!revise(identity, noCounter, item)) {
        const block = { type: 'test-result' as const, item }
        current(item).turn.blocks.push(block)
        track('test-result', identity, item, block)
      }
    } else if (isKind(item, 'turn-changes')) {
      const identity = `changes:${item.body.turnId}`
      if (!revise(identity, noCounter, item)) {
        const block = { type: 'changes' as const, item }
        current(item).turn.blocks.push(block)
        track('turn-changes', identity, item, block)
      }
    } else if (isKind(item, 'plan')) {
      const identity = `plan:${item.body.version}`
      if (!revise(identity, versionOf, item)) {
        const block = { type: 'plan' as const, item }
        current(item).turn.blocks.push(block)
        track('plan', identity, item, block)
      }
    } else if (isKind(item, 'visual')) {
      const identity = `visual:${item.body.viewId}`
      if (!revise(identity, versionOf, item)) {
        const block = { type: 'visual' as const, item }
        current(item).turn.blocks.push(block)
        track('visual', identity, item, block)
      }
    } else if (isKind(item, 'mode')) {
      current(item).turn.blocks.push({ type: 'mode', item })
    } else if (isKind(item, 'fork')) {
      current(item).turn.blocks.push({ type: 'fork', item })
    } else if (isKind(item, 'status')) {
      current(item).turn.blocks.push(
        item.body.failure ? { type: 'error', item } : { type: 'status', item }
      )
    }
  }

  for (const { record, fallback } of turnRecords) {
    const draft =
      (record.userItemId ? draftByUserItem.get(record.userItemId) : undefined) ?? fallback
    if (draft) {
      draft.turn.end = endOf(record)
    }
  }
  return drafts.map(({ turn }) => ({ ...turn, blocks: foldMarkers(turn.blocks) }))
}

/** Adjacent activity blocks (a hidden row between two runs of calls) read as one folded run. */
export function foldMarkers(blocks: ChatBlock[]): ChatBlock[] {
  const folded: ChatBlock[] = []
  for (const block of blocks) {
    const last = folded.at(-1)
    if (block.type === 'activity' && last?.type === 'activity') {
      folded[folded.length - 1] = { type: 'activity', calls: [...last.calls, ...block.calls] }
    } else {
      folded.push(block)
    }
  }
  return folded
}
