import type {
  AgentCommand,
  ProcessSpawner,
  AskEnvelope,
  AskSpec,
  ChatItem,
  PlanItem,
  Session,
  SessionProviderSession,
  SessionStatus,
  StructuredMessage,
  StructuredRole,
  UsageReport,
  UsageTotals
} from '@quirky/protocol'

/** A message a runner journals; the plugin assigns `seq` and, unless given, `at`. */
export type NewStructuredMessage = {
  sessionId: string
  role: StructuredRole
  text: string
  data?: unknown
  /** The typed chat item every runner sets; the journal keeps it beside `text` and `data`. */
  item?: ChatItem
  at?: number
}

/** What the plugin gives a runner to journal, report status, ask questions, persist provider identity and resolve executables. */
export type StructuredContext = {
  process: ProcessSpawner
  /** Stores the message and emits `quirky.structured/message`. */
  appendMessage(msg: NewStructuredMessage): StructuredMessage
  /** Reports the session's status to `quirky.session`; done and waiting also settle the session. */
  setStatus(sessionId: string, status: SessionStatus): void
  /**
   * Registers an ask and resolves with its answer, journaling an `ask` item as soon as the ask exists.
   * Native questions use the kernel-issued live lease; ordinary tool approvals retain their existing card path.
   * A `silent` ask journals no `ask` item, for callers that journal their own item carrying the ask ID.
   */
  createAsk(
    spec: AskSpec,
    sessionId: string,
    options?: { nativeQuestion?: boolean; silent?: boolean; onAsk?: (askId: string) => void }
  ): Promise<AskEnvelope>
  /** Cancels a pending ask the runner no longer needs, so its card becomes a dismissed record. */
  cancelAsk(askId: string): Promise<void>
  /** Stores a native provider session ID before the first turn is started. */
  setProviderSession(sessionId: string, providerSession: SessionProviderSession): Promise<void>
  /** Reports the slash commands and skills the agent offers; each call replaces the session's list. */
  reportCommands?(sessionId: string, commands: AgentCommand[]): void
  /**
   * Reports what a session spent since its previous report (deltas, never cumulative) and, for agents
   * with a prompt cache, one call's cache activity. The plugin owns the stored summary; runners never write it.
   */
  reportUsage?(sessionId: string, report: UsageReport): void
  /** The user's `claude` executable, found through their login shell. */
  resolveClaudePath(): Promise<string>
  /** The user's `codex` executable, found through their login shell. */
  resolveCodexPath(): Promise<string>
  /** The user's `pi` or `omp` executable, found through their login shell. */
  resolvePiPath(variant: 'pi' | 'omp'): Promise<string>
}

/** `deny-all` runs a session with no tools: every tool or approval request is refused without an ask. */
export type ToolPolicy = 'default' | 'deny-all'

/** The context footprint a runner records as `data.contextUsage` on the `result` message that ends a turn. */
export type TurnUsage = { contextTokens: number; contextWindow: number | null }

/** The per-session launch inputs: agent picks plus the resolved provider environment patch. */
export type StructuredLaunchOptions = { model?: string; effort?: string; env?: Record<string, string | null> }

/**
 * Start-only inputs: provider identity (launch options remain provider-native model/effort strings),
 * the permission mode to start in, and the plan state a resumed session continues from.
 */
export type StructuredStartOptions = StructuredLaunchOptions & {
  providerSession?: SessionProviderSession
  permissionMode?: string
  toolPolicy?: ToolPolicy
  /** Highest plan version already journaled, so numbering continues across a resume. */
  planVersion?: number
  /** Text of the newest plan version, so an unchanged re-presentation is recognised after a resume. */
  lastPlanText?: string
  /** The newest plan version as journaled for the resumed session, so the next version can mark it revised. */
  lastPlan?: PlanItem
  /**
   * What the resumed Claude conversation's last journaled result already counted, so the first result
   * after a resume reports only this session's own spend.
   */
  usageBaseline?: Omit<UsageTotals, 'total'>
}

/** Extras of one message: absolute image paths the agent should see, and the queue entry the message came from. */
export type StructuredSendOptions = { images?: string[]; queuedId?: string }

/** The composer picks a running session can take; plan mode is one of the permission modes. */
export type StructuredSettings = { model?: string; effort?: string; permissionMode?: string }

/** Drives background (no PTY) agent sessions. One runner serves every structured session. */
export interface StructuredRunner {
  start(session: Session, prompt?: string, options?: StructuredStartOptions): Promise<void>
  send(sessionId: string, text: string, options?: StructuredSendOptions): Promise<void>
  /**
   * Ends only the current turn: the process and session stay alive and take the next `send`.
   * Falls back to `stop` when the agent does not honour the interrupt, so the turn always ends.
   * A session with no open turn is left alone.
   */
  /**
   * Applies the picks to the running session, for the next turn or at once where the agent allows it,
   * and returns the settings now in force. Absent on runners whose picks are fixed at start.
   */
  configure?(sessionId: string, settings: StructuredSettings): Promise<StructuredSettings>
  /** The models the running agent offers, as ids `configure` accepts. Absent on runners with a fixed catalog. */
  models?(sessionId: string): Promise<{ id: string; label: string }[]>
  /** Whether Auto is offered for the running session's current model. Absent on runners without permission modes. */
  autoAvailable?(sessionId: string): boolean
  /** Whether a plan is waiting for the user's answer. Absent on runners without plan mode. */
  planWaiting?(sessionId: string): boolean
  /**
   * Answers the waiting plan as "keep planning" with `text` and returns true; returns false, touching
   * nothing, when no plan waits or the session is unknown, so the caller sends the text normally.
   */
  planFeedback?(sessionId: string, text: string): boolean
  interrupt(sessionId: string): Promise<void>
  stop(sessionId: string): Promise<void>
  /**
   * Creates a new provider conversation holding the source's history, without starting a turn and without
   * touching the source or its live process. Throws a message fit for the user when the agent refuses.
   * Absent on runners whose agent cannot fork natively.
   */
  fork?(source: StructuredForkSource): Promise<SessionProviderSession>
}

/** What a runner needs to fork one conversation: its provider identity, folder and launch picks. */
export type StructuredForkSource = {
  providerSession: SessionProviderSession
  cwd: string
  launchOptions: StructuredLaunchOptions
}

export type StructuredRunnerFactory = (context: StructuredContext) => StructuredRunner
