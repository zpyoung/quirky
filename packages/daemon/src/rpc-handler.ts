import { timingSafeEqual } from 'node:crypto'
import { RpcErrorCode, type RpcFailure, type RpcSuccess } from '@quirky/protocol'
import { DaemonError } from './errors'
import type { DispatchSource } from './plugins/dispatch'
import type { ClientConn } from './types'

/** What the handler needs from the dispatcher; `options.requestId` is the caller's idempotency key. */
export type RpcDispatch = {
  dispatch(
    method: string,
    params: Record<string, unknown>,
    from: DispatchSource,
    options?: { requestId?: string }
  ): Promise<unknown>
}

/** Resolves `'close'` when the transport must drop the connection after the reply it just sent. */
export type RpcHandler = (conn: ClientConn, text: string) => Promise<'close' | void>

export type RpcHandlerOptions = {
  dispatcher: RpcDispatch
  /** Required in `client.hello` on `socket` connections; WebSocket clients present it in the URL. */
  rpcToken: string
  log: (message: string) => void
}

const MAX_REQUEST_ID_LENGTH = 128

let lastConnId = 0

/** Connection ids are unique across both transports. */
export function nextConnId(): number {
  return ++lastConnId
}

export function tokensMatch(expected: string, actual: string | null): boolean {
  if (actual === null) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Builds the transport-agnostic JSON-RPC message handler shared by the WebSocket and the unix
 * socket. Each call parses one request, enforces the `client.hello`-first rule, and replies on
 * `conn`. On a socket connection a first message that is not an authenticated `client.hello`
 * is answered Unauthorized and the connection is closed.
 */
export function createRpcHandler(options: RpcHandlerOptions): RpcHandler {
  return async (conn, text) => {
    const unauthenticatedSocket = () => conn.transport === 'socket' && conn.role === null
    const outcome = () => (unauthenticatedSocket() ? ('close' as const) : undefined)

    const reply = (message: RpcSuccess | RpcFailure) => {
      if (!conn.closed) conn.sendText(JSON.stringify(message))
    }
    const fail = (id: number | null, code: number, message: string, data?: unknown) => {
      reply({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } })
      return outcome()
    }

    let request: any
    try {
      request = JSON.parse(text)
    } catch {
      return fail(null, RpcErrorCode.ParseError, 'invalid JSON')
    }
    if (
      !request ||
      request.jsonrpc !== '2.0' ||
      typeof request.method !== 'string' ||
      typeof request.id !== 'number'
    ) {
      return fail(
        typeof request?.id === 'number' ? request.id : null,
        RpcErrorCode.InvalidRequest,
        'expected a JSON-RPC 2.0 request with a numeric id'
      )
    }
    const { id, method } = request
    if (conn.role === null && method !== 'client.hello') {
      return fail(id, RpcErrorCode.Unauthorized, 'client.hello must be the first call')
    }
    const params = request.params ?? {}
    if (typeof params !== 'object' || Array.isArray(params)) {
      return fail(id, RpcErrorCode.InvalidParams, 'params must be an object')
    }
    const requestId = request.requestId
    if (
      requestId !== undefined &&
      (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > MAX_REQUEST_ID_LENGTH)
    ) {
      return fail(id, RpcErrorCode.InvalidRequest, `requestId must be a string of 1-${MAX_REQUEST_ID_LENGTH} characters`)
    }
    if (conn.transport === 'socket') {
      if (method === 'client.hello') {
        const token = (params as Record<string, unknown>).token
        if (!tokensMatch(options.rpcToken, typeof token === 'string' ? token : null)) {
          reply({ jsonrpc: '2.0', id, error: { code: RpcErrorCode.Unauthorized, message: 'invalid token' } })
          return 'close'
        }
      }
    }
    try {
      const result = await options.dispatcher.dispatch(
        method,
        params,
        { conn },
        requestId === undefined ? undefined : { requestId }
      )
      reply({ jsonrpc: '2.0', id, result })
    } catch (error) {
      if (error instanceof DaemonError) return fail(id, error.code, error.message, error.data)
      options.log(`rpc ${method} failed: ${(error as Error)?.stack ?? error}`)
      return fail(id, RpcErrorCode.Internal, (error as Error)?.message ?? 'internal error')
    }
    return outcome()
  }
}
