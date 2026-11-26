import { LedgerError } from '../../../shared/ledger'

export type AgentSessionViewErrorCode = 'invalid-spec' | 'not-found' | 'closed' | 'session-refused'

/**
 * A refusal of an `agentSession.view.*` call. It extends `LedgerError` because that is the one
 * error the RPC dispatcher forwards with its own code and details instead of `runtime_error`.
 */
export class AgentSessionViewError extends LedgerError {
  constructor(code: AgentSessionViewErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details)
    this.name = 'AgentSessionViewError'
  }
}
