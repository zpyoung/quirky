export type DockAttachment = {
  id: string
  name: string
  path: string
  mime: string
  image: boolean
}

export type DockQuestion = {
  id: string
  kind: 'question' | 'permission'
  title: string
  questions: { prompt: string; choices: { label: string; value: string }[]; multiple: boolean }[]
  collapsed: boolean
  dismissed: boolean
}

export type DockOptions = {
  model: string | null
  effort: string | null
  permission: string | null
  choices: { model: string[]; effort: string[]; permission: string[] }
  context: { used: number; limit: number } | null
  notice: string | null
}

export type DockState = {
  pane: string
  session: string
  tab: string
  revision: number
  enabled: boolean
  supported: boolean
  agent: string | null
  docked: boolean
  userUndocked: boolean
  gutterRows: number
  mounted: boolean
  passthrough: boolean
  draft: string
  attachments: DockAttachment[]
  disabledReason: string | null
  activeSend: { id: string; phase: string } | null
  queuedSends: { id: string; phase: string }[]
  question: DockQuestion | null
  options: DockOptions
  notice: string | null
  driverOwner?: string | null
}

export type PickerItem = {
  id: string
  label: string
  insert: string
  kind: 'command' | 'skill' | 'file'
  detail?: string
}

export type SendResult = {
  id: string
  outcome: 'observed-cleared' | 'unobservable' | 'may-not-have-sent' | 'refused' | 'cancelled'
  accepted: boolean
  reason?: string
}

/** Persisted recovery-only snapshot. It is never executable after daemon startup. */
export type DockRecovery = {
  id: string
  sequence: number
  text: string
  attachments: string[]
  mayHaveWritten: boolean
  createdAt: number
}

/** Canonical durable state; connection reports, driver leases and runnable queue entries are transient. */
export type DockRecord = {
  pane: string
  session: string
  tab: string
  revision: number
  docked: boolean
  userUndocked: boolean
  autoOpenEvaluated: boolean
  gutterRows: number
  draft: string
  /** Attachment metadata remains until it is neither selected nor referenced by recovery. */
  attachments: DockAttachment[]
  draftAttachments: string[]
  ownedAttachmentIds: string[]
  agent: string | null
  providerPromptCount: number
  history: string[]
  recovery: DockRecovery[]
  recentSendIds: string[]
  nextSequence: number
  notice: string | null
  updatedAt: number
}

export const DEFAULT_GUTTER_ROWS = 5
export const MIN_GUTTER_ROWS = 3
export const MAX_GUTTER_ROWS = 15
export const MAX_HISTORY_ENTRIES = 200
export const MAX_HISTORY_CHARS = 200_000
export const MAX_RECOVERABLE_CHARS = 200_000
export const MAX_ATTACHMENTS = 20
export const MAX_PERSISTED_PANES = 128
export const MAX_PANES_PER_TAB = 64
