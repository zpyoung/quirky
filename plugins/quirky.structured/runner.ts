import type { AskEnvelope, AskSpec, Session, SessionStatus, StructuredMessage, StructuredRole } from '@quirky/protocol'

/** A message a runner journals; the plugin assigns `seq` and, unless given, `at`. */
export type NewStructuredMessage = {
  sessionId: string
  role: StructuredRole
  text: string
  data?: unknown
  at?: number
}

/** What the plugin gives a runner so it can journal, report status, ask questions and find `claude`. */
export type StructuredContext = {
  /** Stores the message and emits `quirky.structured/message`. */
  appendMessage(msg: NewStructuredMessage): StructuredMessage
  /** Reports the session's status to `quirky.session`; done and waiting also notify. */
  setStatus(sessionId: string, status: SessionStatus): void
  /** Creates an ask and resolves with its final envelope once it is answered or cancelled. */
  createAsk(spec: AskSpec, sessionId: string): Promise<AskEnvelope>
  /** The user's `claude` executable, found through their login shell. */
  resolveClaudePath(): Promise<string>
}

/** The structured launch keys a pick resolves to; values that are not strings are ignored. */
export type StructuredLaunchOptions = { model?: string; effort?: string }

/** Drives background (no PTY) agent sessions. One runner serves every structured session. */
export interface StructuredRunner {
  start(session: Session, prompt: string, options?: StructuredLaunchOptions): Promise<void>
  send(sessionId: string, text: string): Promise<void>
  stop(sessionId: string): Promise<void>
}

export type StructuredRunnerFactory = (context: StructuredContext) => StructuredRunner
