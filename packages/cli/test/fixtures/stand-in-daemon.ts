import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '@quirky/protocol'
import { runtimeFilePath, socketPath, writePrivateJson, type RuntimeInfo } from '@quirky/protocol/node'

type SocketState = { decoder: TextDecoder; pending: string }
type Request = { id: number; method: string; params: Record<string, unknown> }

const home = process.env.QUIRKY_HOME
if (!home) throw new Error('QUIRKY_HOME is required')

const mode = process.argv[2] ?? 'exit-on-term'
const callsPath = join(home, 'calls.json')
const signalsPath = join(home, 'signals.json')
const socket = socketPath(home, 'quirkyd.sock')
writeFileSync(callsPath, '[]', { mode: 0o600 })
writeFileSync(signalsPath, '[]', { mode: 0o600 })
rmSync(socket, { force: true })

function record(path: string, value: unknown): void {
  const values = JSON.parse(readFileSync(path, 'utf8')) as unknown[]
  values.push(value)
  writeFileSync(path, JSON.stringify(values), { mode: 0o600 })
}

const health = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== '/health') return new Response('not found', { status: 404 })
    return Response.json({ ok: true, pid: process.pid, daemonVersion: '0.0.0-stand-in' })
  }
})

const listener = Bun.listen<SocketState>({
  unix: socket,
  socket: {
    open(client) {
      client.data = { decoder: new TextDecoder(), pending: '' }
    },
    data(client, chunk) {
      const state = client.data
      state.pending += state.decoder.decode(chunk, { stream: true })
      let newline = state.pending.indexOf('\n')
      while (newline !== -1) {
        const line = state.pending.slice(0, newline)
        state.pending = state.pending.slice(newline + 1)
        if (line.trim()) handle(client, JSON.parse(line) as Request)
        newline = state.pending.indexOf('\n')
      }
    },
    close() {},
    error() {}
  }
})
chmodSync(socket, 0o600)

const info: RuntimeInfo = {
  pid: process.pid,
  port: health.port as number,
  token: 'stand-in-token',
  hookToken: 'stand-in-hook-token',
  daemonVersion: '0.0.0-stand-in',
  protocolVersion: PROTOCOL_VERSION,
  startedAt: Date.now(),
  socket
}
writePrivateJson(runtimeFilePath(home), info)

let closed = false
function closeServers(): void {
  if (closed) return
  closed = true
  listener.stop(true)
  health.stop(true)
  rmSync(socket, { force: true })
}

function respond(client: Bun.Socket<SocketState>, id: number, result: unknown): void {
  client.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function handle(client: Bun.Socket<SocketState>, request: Request): void {
  record(callsPath, { method: request.method, params: request.params })
  if (request.method === 'client.hello') {
    if (mode !== 'silent-hello') {
      respond(client, request.id, { protocolVersion: PROTOCOL_VERSION, daemonVersion: '0.0.0-stand-in' })
    }
    return
  }

  if (request.method === 'daemon.stop') {
    if (mode === 'silent-stop') return
    respond(client, request.id, { ok: true })
    if (mode === 'exit-on-stop') {
      setTimeout(() => {
        closeServers()
        process.exit(0)
      }, 30)
    }
    return
  }

  respond(client, request.id, { ok: true })
}

process.on('SIGTERM', () => {
  record(signalsPath, 'SIGTERM')
  if (mode === 'ignore-term') return
  closeServers()
  if (mode !== 'quiet-term') process.exit(0)
})

if (mode === 'exit-on-control') {
  const interval = setInterval(() => {
    if (!existsSync(join(home, 'exit-now'))) return
    clearInterval(interval)
    closeServers()
    process.exit(0)
  }, 10)
}
