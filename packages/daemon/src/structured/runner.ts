import type { AskEnvelope, AskSpec, Session, SessionStatus, StructuredMessage, StructuredRole } from '@quirky/protocol'

/** A message a runner journals; the daemon assigns `seq` and, unless given, `at`. */
export type NewStructuredMessage = {
  sessionId: string
  role: StructuredRole
  text: string
  data?: unknown
  at?: number
}

/** What the daemon gives a runner so it can journal, report status, ask questions and find `claude`. */
export type StructuredContext = {
  /** Stores the message and emits `structured.message`. */
  appendMessage(msg: NewStructuredMessage): StructuredMessage
  /** Updates the session's status and emits `session.changed`; done and waiting also notify. */
  setStatus(sessionId: string, status: SessionStatus): void
  /** Creates an ask and resolves with its final envelope once it is answered or cancelled. */
  createAsk(spec: AskSpec, sessionId: string): Promise<AskEnvelope>
  /** The user's `claude` executable, found through their login shell. */
  resolveClaudePath(): Promise<string>
}

/** Drives background (no PTY) agent sessions. One runner serves every structured session. */
export interface StructuredRunner {
  start(session: Session, prompt: string): Promise<void>
  send(sessionId: string, text: string): Promise<void>
  stop(sessionId: string): Promise<void>
}

export type StructuredRunnerFactory = (context: StructuredContext) => StructuredRunner

const UNAVAILABLE = 'structured sessions are not available in this build'

/** Rejects every call; stands in until a real runner is supplied. */
export class UnavailableStructuredRunner implements StructuredRunner {
  constructor(readonly context: StructuredContext) {}

  async start(): Promise<void> {
    throw new Error(UNAVAILABLE)
  }

  async send(): Promise<void> {
    throw new Error(UNAVAILABLE)
  }

  async stop(): Promise<void> {
    throw new Error(UNAVAILABLE)
  }
}

export const createStubRunner: StructuredRunnerFactory = (context) => new UnavailableStructuredRunner(context)
