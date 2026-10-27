import { join } from 'node:path'
import { DEFAULT_THEME, PROTOCOL_VERSION, type UiLayout, type UiModel } from '@quirky/protocol'

const DIST = join(import.meta.dir, '..', 'dist')
const TOKEN = 'mock-token'

const layout: UiLayout = { view: null, panel: null, sidebar: true, focus: null }
const model: UiModel = {
  sidebarSections: [],
  panels: [],
  views: [],
  overlays: [],
  commands: [],
  keybindings: [],
  settings: [],
  themes: [DEFAULT_THEME],
  theme: { chosen: 'default', active: 'default' },
  modules: {}
}

function handle(method: string): unknown {
  switch (method) {
    case 'client.hello':
      return { protocolVersion: PROTOCOL_VERSION, daemonVersion: 'mock' }
    case 'events.subscribe':
    case 'ui.window.focused':
    case 'ui.report':
      return { ok: true }
    case 'ui.state':
      return { windows: [], layout, slots: [] }
    case 'ui.contributions':
      return model
    case 'setting.list':
      return []
    default:
      throw new Error(`mock daemon: unhandled ${method}`)
  }
}

/** Serves `dist/` and a daemon with an empty UI model at `/rpc?token=mock-token`; returns the base URL. */
export function startMockDaemon(port = 0): { url: string; stop: () => void } {
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === '/health') return Response.json({ ok: true })
      if (url.pathname === '/rpc') {
        if (url.searchParams.get('token') !== TOKEN) return new Response('unauthorized', { status: 401 })
        return server.upgrade(request) ? undefined : new Response('upgrade failed', { status: 400 })
      }
      const file = Bun.file(join(DIST, url.pathname === '/' ? 'index.html' : url.pathname))
      return (await file.exists()) ? new Response(file) : new Response(Bun.file(join(DIST, 'index.html')))
    },
    websocket: {
      message(socket, message) {
        const request = JSON.parse(String(message))
        try {
          const result = handle(request.method)
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
        } catch (error) {
          socket.send(
            JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: String(error) } })
          )
        }
      }
    }
  })
  return { url: `http://127.0.0.1:${server.port}/#token=${TOKEN}`, stop: () => server.stop(true) }
}

if (import.meta.main) {
  const { url } = startMockDaemon(Number(process.env.PORT ?? 0))
  console.log(url)
}
