import { HOOK_PATH_PREFIX, HOOK_TOKEN_HEADER, RPC_PATH, type QuirkyEvent } from '@quirky/protocol'
import { HEALTH_PATH } from '@quirky/protocol/node'
import { servePluginFile } from './plugin-files'
import { FILE_RESOURCE_ROUTE, type FileResourceRegistry } from './file-resources'
import { nextConnId, type RpcHandler, tokensMatch } from './rpc-handler'
import type { Core } from './service'
import { serveStatic } from './static'
import type { ClientConn } from './types'
import { WebSocketOutput } from './websocket-output'

type SocketData = { conn: ClientConn; output?: WebSocketOutput; cleaned?: boolean }

type HookReceived = Extract<QuirkyEvent, { type: 'hook.received' }>

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
  /** Serves activation-scoped file capabilities. */
  fileResources: FileResourceRegistry
  log: (message: string) => void
  /** Receives each authenticated hook; defaults to core.deliverToPlugins. */
  deliverHook?: (event: HookReceived, bodyBytes: number) => void
  /** Module URLs to preload from index.html; omitted means none. */
  modulePreloads?: () => readonly string[]
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

const HOOK_EVENT_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const HTML_ATTRIBUTE_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;'
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&"'<>]/g, (character) => HTML_ATTRIBUTE_ESCAPES[character]!)
}
const HOOK_PSTART = /^[\x20-\x7e]{1,64}$/

/** The agent process identity a hook shim reports in the query; malformed values are left out, never rejected. */
function agentIdentity(url: URL): { agentPid?: number; agentStart?: string; event?: string } {
  const pid = url.searchParams.get('pid')
  const start = url.searchParams.get('pstart')
  const event = url.searchParams.get('event')
  const agentPid = pid !== null && /^\d{1,10}$/.test(pid) ? Number(pid) : 0
  return {
    ...(agentPid > 0 ? { agentPid } : {}),
    ...(start !== null && HOOK_PSTART.test(start) ? { agentStart: start } : {}),
    ...(event !== null && HOOK_EVENT_NAME.test(event) ? { event } : {})
  }
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
    const bodyBytes = await request.arrayBuffer()
    const body = new TextDecoder().decode(bodyBytes)
    if (body.trim() !== '') {
      try {
        payload = JSON.parse(body)
      } catch {
        return json({ error: 'body must be JSON' }, 400)
      }
    }
    const event: HookReceived = { type: 'hook.received', agent, sessionId, payload, ...agentIdentity(url) }
    try {
      if (options.deliverHook) options.deliverHook(event, bodyBytes.byteLength)
      else core.deliverToPlugins(event)
    } catch (error) {
      options.log(`hook.received delivery failed: ${(error as Error)?.stack ?? error}`)
    }
    return json({ ok: true })
  }

  function transformIndex(html: string): string {
    const importMap = /<script\b(?=[^>]*\s+type\s*=\s*(["'])importmap\1)[^>]*>/i.test(html)
    const bodyEnd = /<\/body\s*>/i.exec(html)
    if (!importMap || bodyEnd === null || options.modulePreloads === undefined) return html
    try {
      const modules = options.modulePreloads()
      if (modules.length === 0) return html
      const links = modules
        .map((url) => `<link rel="modulepreload" href="${escapeHtmlAttribute(url)}">`)
        .join('\n')
      return `${html.slice(0, bodyEnd.index)}${links}${html.slice(bodyEnd.index)}`
    } catch {
      return html
    }
  }
  function removeSocketClient(data: SocketData): void {
    if (data.cleaned) return
    data.cleaned = true
    data.output?.dispose()
    core.removeClient(data.conn)
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
      if (url.pathname.startsWith(FILE_RESOURCE_ROUTE)) {
        return options.fileResources.serve(request, url.pathname)
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (url.pathname.startsWith('/plugins/')) {
          return servePluginFile(options.pluginFile, url.pathname, request.method)
        }
        return serveStatic(
          options.uiDir,
          url.pathname,
          request.method,
          options.modulePreloads === undefined ? undefined : { transformIndex }
        )
      }
      return json({ error: 'method not allowed' }, 405)
    },
    websocket: {
      backpressureLimit: 16 * 1024 * 1024,
      closeOnBackpressureLimit: false,
      perMessageDeflate: false,
      open(ws) {
        const data = ws.data
        const { conn } = data
        const output = new WebSocketOutput(ws, () => {
          try {
            ws.close(1013, 'WebSocket output stalled')
          } finally {
            removeSocketClient(data)
          }
        })
        data.output = output
        conn.sendText = (text) => output.sendText(text)
        conn.sendBinary = (bytes) => output.sendBinary(bytes)
        conn.closeStreamOutput = (streamId) => output.closeStream(streamId)
        core.addClient(conn)
      },
      message(ws, message) {
        if (typeof message !== 'string') return
        const { conn } = ws.data
        queueMicrotask(() => {
          if (!conn.closed) void handle(conn, message)
        })
      },
      drain(ws) {
        const data = ws.data
        queueMicrotask(() => {
          if (!data.conn.closed) data.output?.drain()
        })
      },
      close(ws) {
        removeSocketClient(ws.data)
      }
    }
  })

  return server
}
