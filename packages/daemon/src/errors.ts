import { RpcErrorCode } from '@quirky/protocol'

/** An error that maps directly to a JSON-RPC error code. */
export class DaemonError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
    this.name = 'DaemonError'
  }
}

export const invalidParams = (message: string) => new DaemonError(RpcErrorCode.InvalidParams, message)
export const notFound = (message: string) => new DaemonError(RpcErrorCode.NotFound, message)
export const conflict = (message: string) => new DaemonError(RpcErrorCode.Conflict, message)
export const internal = (message: string) => new DaemonError(RpcErrorCode.Internal, message)
