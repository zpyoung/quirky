import type { NextStep, StableErrorCode } from '../../../shared/public-rpc/error-contract'

/**
 * A failure on the public CLI/API surface. The wire error keeps the stable `code` and carries
 * `reason`, `next` and any `data` beside it, so an agent can branch on the code and act on the steps.
 */
export class PublicRpcError extends Error {
  readonly code: StableErrorCode
  readonly reason: string
  readonly next: NextStep[]
  readonly data: Record<string, unknown> | undefined

  constructor(
    code: StableErrorCode,
    reason: string,
    next: NextStep[] = [],
    data?: Record<string, unknown>,
    message: string = reason
  ) {
    super(message)
    this.name = 'PublicRpcError'
    this.code = code
    this.reason = reason
    this.next = next
    this.data = data
  }
}
