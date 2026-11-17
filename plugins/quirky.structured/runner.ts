import type {
  AgentCommand,
  ProcessSpawner,
  AskEnvelope,
  AskSpec,
  ChatItem,
  Session,
  SessionProviderSession,
  SessionStatus,
  StructuredMessage,
  StructuredRole
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
   */
  createAsk(spec: AskSpec, sessionId: string, options?: { nativeQuestion?: boolean; onAsk?: (askId: string) => void }): Promise<AskEnvelope>
  /** Cancels a pending ask the runner no longer needs, so its card becomes a dismissed record. */
  cancelAsk(askId: string): Promise<void>
  /** Stores a native provider session ID before the first turn is started. */
  setProviderSession(sessionId: string, providerSession: SessionProviderSession): Promise<void>
  /** Reports the slash commands and skills the agent offers; each call replaces the session's list. */
  reportCommands?(sessionId: string, commands: AgentCommand[]): void
  /** The user's `claude` executable, found through their login shell. */
  resolveClaudePath(): Promise<string>
  /** The user's `codex` executable, found through their login shell. */
  resolveCodexPath(): Promise<string>
  /** The user's `pi` or `omp` executable, found through their login shell. */
  resolvePiPath(variant: 'pi' | 'omp'): Promise<string>
}

/** The per-session launch inputs: agent picks plus the resolved provider environment patch. */
export type StructuredLaunchOptions = { model?: string; effort?: string; env?: Record<string, string | null> }

/** Start-only provider identity; launch options remain provider-native model/effort strings. */
export type StructuredStartOptions = StructuredLaunchOptions & { providerSession?: SessionProviderSession }

/** Extras of one message: absolute image paths the agent should see, and the queue entry the message came from. */
export type StructuredSendOptions = { images?: string[]; queuedId?: string }

/** The composer picks a running session can take; plan mode wins over the permission mode while on. */
export type StructuredSettings = { model?: string; effort?: string; permissionMode?: string; planMode?: boolean }

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
  interrupt(sessionId: string): Promise<void>
  stop(sessionId: string): Promise<void>
}

export type StructuredRunnerFactory = (context: StructuredContext) => StructuredRunner
