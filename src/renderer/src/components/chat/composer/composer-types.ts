import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { AgentType } from '../../../../../shared/agent-status-types'
import type { StructuredAgentSessionAttachment } from '../../../../../shared/structured-agent-session-send-mutation'
import type {
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../../../shared/native-chat-session-options'
import type { StructuredAgentSessionQueuedMessagesController } from '@/components/native-chat/use-structured-agent-session-queued-messages'
import type { NativeChatStructuredAttachmentSession } from '@/components/native-chat/native-chat-attachment-upload'
import type { NativeChatResolvedTarget } from '@/components/native-chat/native-chat-composer-target'
import type { ComposerCommand } from './composer-commands'

export type ComposerMode = 'chat' | 'terminal'

/** What `onSubmit` answers: `false` keeps the draft, anything else means the message was taken. */
export type ComposerSubmitResult = void | boolean | 'queued'

export type ComposerSubmit = (
  text: string,
  attachments: StructuredAgentSessionAttachment[]
) => ComposerSubmitResult | Promise<ComposerSubmitResult>

/** The session controller's queue (`useStructuredAgentSession().queuedMessages`). */
export type ComposerQueue = StructuredAgentSessionQueuedMessagesController

/** The session controller's option surface with its setter (`optionSurface`, `setStructuredOption`). */
export type ComposerSettings = {
  surface: SessionOptionsSurface
  setOption: (id: string, value: SessionOptionValue) => Promise<boolean>
}

/** Where a queue reorder is sent; without it the queue offers no drag handle. */
export type ComposerQueueMove = {
  target: RuntimeClientTarget
  sessionId: string
  /** The runtime fence the queue was read under. */
  fence: number | null
}

/**
 * What the paste, drop and `@` file search hooks need to know about the pane the composer sits in.
 * Without it the composer takes no attachments and offers no file mentions.
 */
export type ComposerWorkspace = {
  paneKey: string
  terminalTabId: string
  agent: AgentType
  /** The worktree `@` searches; defaults to the terminal tab's. */
  worktreeId?: string
  /** The PTY this pane owns, when it has one. */
  targetPtyId?: string | null
  /** A structured chat: where its uploads are stored. */
  structuredSession?: NativeChatStructuredAttachmentSession
  /** A terminal dock: the PTY an attachment must be deliverable to. */
  resolveTarget?: () => NativeChatResolvedTarget | null
}

export type ComposerProps = {
  mode: ComposerMode
  /** Receives the message; the composer clears its draft unless this returns `false`. */
  onSubmit: ComposerSubmit
  /** Chat only. */
  queue?: ComposerQueue
  /** Chat only. */
  settings?: ComposerSettings
  /** Owner of the unsent draft and its attachments. */
  draftScopeKey: string
  disabled?: boolean
  /** False hides image chips; absent counts as true until the agent says otherwise. */
  acceptsImages?: boolean
  /** The `/` list; host commands appear only when `onRunCommand` is given. */
  commands?: readonly ComposerCommand[]
  onRunCommand?: (command: ComposerCommand) => void
  /** Chat only: the session has a plan mode. */
  planModeAvailable?: boolean
  autoFocus?: boolean
  /** Chat only: the agent is working a turn, so Enter queues and Esc stops. */
  working?: boolean
  canStop?: boolean
  onStop?: () => void
  /** Terminal only: sends are held, and `quarantineReason` says why. */
  quarantined?: boolean
  quarantineReason?: string
  queueMove?: ComposerQueueMove
  workspace?: ComposerWorkspace
  sendKey?: 'enter' | 'mod-enter'
  agentLabel?: string
}

export type ComposerHandle = {
  focus(): void
}
