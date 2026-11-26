// Journal item kinds the native chat port added. Each keeps one item per identity and revises it
// in place: `plan` per `version`, `turn-changes` per `turnId`, `visual` per `viewId`, `test-result`
// per `callId`. An older build keeps an unknown kind as-is and draws nobody's row for it, so none
// of these needs a journal row-version bump.

import { z } from 'zod'
import { AGENT_CHAT_PERMISSION_MODES } from './agent-chat-permission-mode'
import type { AgentChatPermissionMode } from './agent-chat-permission-mode'
import type { AgentJournalBoundedPayload } from './agent-session-journal-types'

export const V1_CHAT_ITEM_KINDS = [
  'plan',
  'turn-changes',
  'mode',
  'fork',
  'visual',
  'test-result'
] as const
export type V1ChatItemKind = (typeof V1_CHAT_ITEM_KINDS)[number]

export function isV1ChatItemKind(kind: string): kind is V1ChatItemKind {
  return V1_CHAT_ITEM_KINDS.some((each) => each === kind)
}

/** A plan the agent proposed in plan mode. `version` counts from 1 per session and never repeats. */
export type AgentJournalPlanItem = {
  kind: 'plan'
  version: number
  status: 'waiting' | 'revised' | 'approved' | 'not-answered'
  text: string
  filePath?: string
  approvalItemId?: string
  reason?: 'feedback' | 'stopped' | 'mode-switch' | 'restarted'
  empty?: boolean
  unchanged?: boolean
}

export type TurnChangesFile = {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  added?: number
  removed?: number
  oldPath?: string
}

/** What one turn changed. Written only when at least one file changed; `fromTree` and `toTree`
 *  are present exactly when `source` is `git-tree`. */
export type AgentJournalTurnChangesItem = {
  kind: 'turn-changes'
  turnId: string
  source: 'git-tree' | 'edit-tools'
  fromTree?: string
  toTree?: string
  files: TurnChangesFile[]
}

export type AgentJournalChatMode = AgentChatPermissionMode | 'plan'

export type AgentJournalModeItem = {
  kind: 'mode'
  mode: AgentJournalChatMode
  previous?: AgentJournalChatMode
}

export type AgentJournalForkItem = {
  kind: 'fork'
  fromSessionId: string
  fromItemId?: string
  fromTitle?: string
}

/** A view the agent opened. `spec` is bounded; a client that needs it whole reads
 *  `agentSession.item` when `shortened` is set. */
export type AgentJournalVisualItem = {
  kind: 'visual'
  viewId: string
  version: number
  title?: string
  placement: 'inline' | 'pane'
  spec: AgentJournalBoundedPayload
  closed?: boolean
}

/** `tail` is at most 8 lines and 800 characters. */
export type AgentJournalTestResultItem = {
  kind: 'test-result'
  callId: string
  command: string
  state: 'running' | 'passed' | 'failed'
  passed?: number
  failed?: number
  skipped?: number
  tail?: string
}

export type AgentJournalV1ChatItem =
  | AgentJournalPlanItem
  | AgentJournalTurnChangesItem
  | AgentJournalModeItem
  | AgentJournalForkItem
  | AgentJournalVisualItem
  | AgentJournalTestResultItem

const BoundedPayload = z.object({
  head: z.string(),
  byteLength: z.number(),
  digest: z.string(),
  truncated: z.boolean()
})

const ChatMode = z.enum([...AGENT_CHAT_PERMISSION_MODES, 'plan'])

const TurnChangesFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  added: z.number().int().nonnegative().optional(),
  removed: z.number().int().nonnegative().optional(),
  oldPath: z.string().optional()
})

export const V1_CHAT_ITEM_ARMS = [
  z.object({
    kind: z.literal('plan'),
    version: z.number().int().positive(),
    status: z.enum(['waiting', 'revised', 'approved', 'not-answered']),
    text: z.string(),
    filePath: z.string().optional(),
    approvalItemId: z.string().optional(),
    reason: z.enum(['feedback', 'stopped', 'mode-switch', 'restarted']).optional(),
    empty: z.boolean().optional(),
    unchanged: z.boolean().optional()
  }),
  z.object({
    kind: z.literal('turn-changes'),
    turnId: z.string(),
    source: z.enum(['git-tree', 'edit-tools']),
    fromTree: z.string().optional(),
    toTree: z.string().optional(),
    files: z.array(TurnChangesFileSchema)
  }),
  z.object({ kind: z.literal('mode'), mode: ChatMode, previous: ChatMode.optional() }),
  z.object({
    kind: z.literal('fork'),
    fromSessionId: z.string(),
    fromItemId: z.string().optional(),
    fromTitle: z.string().optional()
  }),
  z.object({
    kind: z.literal('visual'),
    viewId: z.string(),
    version: z.number().int().positive(),
    title: z.string().optional(),
    placement: z.enum(['inline', 'pane']),
    spec: BoundedPayload,
    closed: z.boolean().optional()
  }),
  z.object({
    kind: z.literal('test-result'),
    callId: z.string(),
    command: z.string(),
    state: z.enum(['running', 'passed', 'failed']),
    passed: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    skipped: z.number().int().nonnegative().optional(),
    tail: z.string().optional()
  })
] as const
