import {
  HOOK_PATH_PREFIX,
  HOOK_TOKEN_HEADER,
  RPC_PATH,
  type QuirkyEvent
} from '@quirky/protocol'
import { HEALTH_PATH } from '@quirky/protocol/node'
import { servePluginFile } from './plugin-files'
import { nextConnId, type RpcHandler, tokensMatch } from './rpc-handler'
import type { Core } from './service'
import { serveStatic } from './static'
import type { ClientConn } from './types'

type SocketData = { conn: ClientConn }

export type ServerOptions = {
  core: Core
  /** Handles one JSON-RPC message from a WebSocket connection. */
  handle: RpcHandler
  port: number
  /** Authenticates the `/rpc` upgrade (`?token=`). */
  rpcToken: string
  daemonVersion: string
  uiDir: string
  /** Maps a plugin ID to the directory its `/plugins/<id>/` files come from, or null for none. */
  pluginFile: (pluginId: string) => { dir: string } | null
  log: (message: string) => void
  /** Receives each authenticated hook as a `hook.received` event; delivered to plugins, never to clients. */
  deliverHook?: (event: QuirkyEvent) => void
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

/** The single loopback HTTP server: health, the RPC WebSocket, agent hooks and the static UI. */
export function startServer(options: ServerOptions) {
  const { core, handle } = options

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
    try {
      options.deliverHook?.({ type: 'hook.received', agent, sessionId, payload })
    } catch (error) {
      options.log(`hook.received delivery failed: ${(error as Error)?.stack ?? error}`)
    }
    await core.handleHook(agent, sessionId, payload)
    return json({ ok: true })
  }

  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: options.port,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === HEALTH_PATH) {
        return json({ ok: true, pid: process.pid, daemonVersion: options.daemonVersion })
      }
      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
      if (url.pathname === RPC_PATH) {
        if (!tokensMatch(options.rpcToken, url.searchParams.get('token'))) {
          return json({ error: 'unauthorized' }, 401)
        }
        const conn: ClientConn = {
          id: nextConnId(),
          role: null,
          subscribed: false,
          closed: false,
          transport: 'websocket',
          streams: new Map(),
          streamClosers: new Map(),
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
        if (url.pathname.startsWith('/plugins/')) {
          return servePluginFile(options.pluginFile, url.pathname, request.method)
        }
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
        void handle(ws.data.conn, message)
      },
      close(ws) {
        core.removeClient(ws.data.conn)
      }
    }
  })

  return server
}
