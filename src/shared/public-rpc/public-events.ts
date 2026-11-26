import { z } from 'zod'
import { AttributedCallerSchema } from './caller-hint'

export const PUBLIC_TOPICS = ['chat', 'ui', 'notifications', 'workspace', 'activity'] as const
export type PublicTopic = (typeof PUBLIC_TOPICS)[number]

export const CHAT_EVENT_TYPES = [
  'turn.started',
  'turn.finished',
  'turn.failed',
  'turn.needs-input'
] as const
export const UI_EVENT_TYPES = ['focus.changed', 'tab.opened', 'tab.closed', 'view.changed'] as const
export const NOTIFICATION_EVENT_TYPES = ['notification.raised'] as const
export const WORKSPACE_EVENT_TYPES = [
  'worktree.created',
  'worktree.removed',
  'terminal.exited',
  'terminal.idle',
  'settings.changed'
] as const
export const ACTIVITY_EVENT_TYPES = ['activity.recorded'] as const

export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number]
export type UiEventType = (typeof UI_EVENT_TYPES)[number]
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number]
export type WorkspaceEventType = (typeof WORKSPACE_EVENT_TYPES)[number]
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number]

export type PublicEventType =
  | ChatEventType
  | UiEventType
  | NotificationEventType
  | WorkspaceEventType
  | ActivityEventType

export const PUBLIC_EVENT_TYPES_BY_TOPIC = {
  chat: CHAT_EVENT_TYPES,
  ui: UI_EVENT_TYPES,
  notifications: NOTIFICATION_EVENT_TYPES,
  workspace: WORKSPACE_EVENT_TYPES,
  activity: ACTIVITY_EVENT_TYPES
} as const satisfies Record<PublicTopic, readonly string[]>

export const PublicTopicSchema = z.enum(PUBLIC_TOPICS)

/** `data` per type: chat {sessionId, turnId?, requestId?, worktreeId?}; ui {worktreeId?, tabId?, tabType?, view?}; notifications {id, title, worktreeId?}; workspace {worktreeId?, terminalHandle?, keys?}; activity {method, summary, worktreeId?, tabId?, outcome?: 'refused'}. */
export const PublicEventSchema = z.object({
  seq: z.number(),
  at: z.number(),
  topic: PublicTopicSchema,
  type: z.string(),
  caller: AttributedCallerSchema.optional(),
  data: z.record(z.string(), z.unknown())
})

export type PublicEvent = z.infer<typeof PublicEventSchema>

/** Sent when the subscriber's cursor is older than the retained ring: events `from`..`oldest`-1 were dropped. */
export const EventsGapFrameSchema = z.object({
  type: z.literal('events.gap'),
  from: z.number(),
  oldest: z.number()
})
export type EventsGapFrame = z.infer<typeof EventsGapFrameSchema>

export const EventsReadyFrameSchema = z.object({
  type: z.literal('ready'),
  subscriptionId: z.string(),
  cursor: z.number()
})
export type EventsReadyFrame = z.infer<typeof EventsReadyFrameSchema>
