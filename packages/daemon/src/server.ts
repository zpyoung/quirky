import { timingSafeEqual } from 'node:crypto'
import {
  HOOK_PATH_PREFIX,
  HOOK_TOKEN_HEADER,
  RPC_PATH,
  RpcErrorCode,
  type RpcFailure,
  type RpcSuccess
} from '@quirky/protocol'
import { HEALTH_PATH } from '@quirky/protocol/node'
import { DaemonError } from './errors'
import type { Handlers } from './methods'
import type { Core } from './service'
import { serveStatic } from './static'
import type { ClientConn } from './types'

type SocketData = { conn: ClientConn }

export type ServerOptions = {
  core: Core
  handlers: Handlers
  port: number
  rpcToken: string
  daemonVersion: string
  uiDir: string
  log: (message: string) => void
}

function tokensMatch(expected: string, actual: string | null): boolean {
  if (actual === null) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(actual)
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

/** The single loopback HTTP server: health, the RPC WebSocket, agent hooks and the static UI. */
export function startServer(options: ServerOptions) {
  const { core, handlers } = options
  let nextConnId = 1

  async function handleHook(request: Request, url: URL): Promise<Response> {
    if (!tokensMatch(core.hookToken, request.headers.get(HOOK_TOKEN_HEADER))) {
      return json({ error: 'unauthorized' }, 401)
    }
    const agent = url.pathname.slice(HOOK_PATH_PREFIX.length)
    const sessionId = url.searchParams.get('session')
    if (!agent || !sessionId) return json({ error: 'agent and session are required' }, 400)
    let payload: unknown = null
    const body = await request.text()
    if (body.trim() !== '') {
      try {
        payload = JSON.parse(body)
      } catch {
        return json({ error: 'body must be JSON' }, 400)
      }
    }
    const known = await core.handleHook(agent, sessionId, payload)
    return known ? json({ ok: true }) : json({ error: 'unknown session' }, 404)
  }

  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: options.port,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === HEALTH_PATH) {
        return json({ ok: true, pid: process.pid, daemonVersion: options.daemonVersion })
      }
      if (url.pathname === RPC_PATH) {
        if (!tokensMatch(options.rpcToken, url.searchParams.get('token'))) {
          return json({ error: 'unauthorized' }, 401)
        }
        const conn: ClientConn = {
          id: nextConnId++,
          role: null,
          subscribed: false,
          closed: false,
          streams: new Map(),
          nextStreamId: 1,
          sendText: () => {},
          sendBinary: () => {}
        }
        if (server.upgrade(request, { data: { conn } })) return undefined
        return json({ error: 'expected a websocket upgrade' }, 426)
      }
      if (url.pathname.startsWith(HOOK_PATH_PREFIX)) {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
        return handleHook(request, url)
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        return serveStatic(options.uiDir, url.pathname, request.method)
      }
      return json({ error: 'method not allowed' }, 405)
    },
    websocket: {
      open(ws) {
        const { conn } = ws.data
        conn.sendText = (text) => ws.send(text)
        conn.sendBinary = (bytes) => ws.sendBinary(bytes)
        core.addClient(conn)
      },
      message(ws, message) {
        if (typeof message !== 'string') return
        void handleMessage(ws.data.conn, message)
      },
      close(ws) {
        core.removeClient(ws.data.conn)
      }
    }
  })

  async function handleMessage(conn: ClientConn, text: string): Promise<void> {
    const reply = (message: RpcSuccess | RpcFailure) => {
      if (!conn.closed) conn.sendText(JSON.stringify(message))
    }
    const fail = (id: number | null, code: number, message: string) =>
      reply({ jsonrpc: '2.0', id, error: { code, message } })

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
    const handler = Object.hasOwn(handlers, method) ? (handlers as Record<string, any>)[method] : undefined
    if (!handler) return fail(id, RpcErrorCode.MethodNotFound, `unknown method: ${method}`)
    const params = request.params ?? {}
    if (typeof params !== 'object' || Array.isArray(params)) {
      return fail(id, RpcErrorCode.InvalidParams, 'params must be an object')
    }
    try {
      reply({ jsonrpc: '2.0', id, result: await handler(params, conn) })
    } catch (error) {
      if (error instanceof DaemonError) return fail(id, error.code, error.message)
      options.log(`rpc ${method} failed: ${(error as Error)?.stack ?? error}`)
      fail(id, RpcErrorCode.Internal, (error as Error)?.message ?? 'internal error')
    }
  }

  return server
}
