import { RpcErrorCode } from '@quirky/protocol'

/** An error that maps directly to a JSON-RPC error code. */
export class DaemonError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'DaemonError'
  }
}

export const invalidParams = (message: string) => new DaemonError(RpcErrorCode.InvalidParams, message)
export const notFound = (message: string) => new DaemonError(RpcErrorCode.NotFound, message)
export const conflict = (message: string) => new DaemonError(RpcErrorCode.Conflict, message)
export const internal = (message: string) => new DaemonError(RpcErrorCode.Internal, message)

/** The destructive call needs an answered confirm ask; `data` names the ask and what it confirms. */
export const confirmationRequired = (data: { askId: string; action: string }) =>
  new DaemonError(RpcErrorCode.ConfirmationRequired, `confirmation required: ${data.action}`, data)
