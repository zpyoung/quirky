import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { PROTOCOL_VERSION } from '@quirky/protocol'
import { runtimeFilePath, socketPath, writePrivateJson, type RuntimeInfo } from '@quirky/protocol/node'

type SocketState = { pending: string }
type Request = { id: number; method: string; params: Record<string, unknown> }

const home = process.env.QUIRKY_HOME
if (!home) throw new Error('QUIRKY_HOME is required')
mkdirSync(home, { recursive: true, mode: 0o700 })

const mode = process.env.SERVE_DAEMON_MODE ?? 'ready'
const startsPath = join(home, 'serve-daemon-starts.log')
const signalsPath = join(home, 'serve-daemon-signals.log')
const socket = socketPath(home, 'quirkyd.sock')
const requestedPort = process.env.QUIRKY_PORT
appendFileSync(
  startsPath,
  `pid=${process.pid} argv=${JSON.stringify(process.argv.slice(1))} QUIRKY_PORT=${requestedPort ?? 'absent'}\n`,
  { mode: 0o600 }
)
writeFileSync(
  join(home, 'serve-daemon-env.json'),
  JSON.stringify({
    CLAUDECODE: process.env.CLAUDECODE,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  }),
  { mode: 0o600 }
)

if (mode === 'exit-1') {
  process.stderr.write('serve-daemon: exit-1 requested\n')
  process.exit(1)
}

const healthPid = mode === 'health-wrong-pid' ? process.pid + 1 : process.pid

async function waitForSibling(): Promise<void> {
  const sibling = spawn(process.execPath, [process.argv[1]], {
    cwd: home,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SERVE_DAEMON_MODE: 'ready' }
  })
  sibling.unref()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const runtime = JSON.parse(readFileSync(runtimeFilePath(home), 'utf8')) as RuntimeInfo
      const response = await fetch(`http://127.0.0.1:${runtime.port}/health`, { signal: AbortSignal.timeout(100) })
      const health = (await response.json()) as { pid?: number }
      if (response.ok && health.pid === sibling.pid) return
    } catch {}
    await Bun.sleep(10)
  }
  throw new Error('yield sibling did not become healthy')
}

if (mode === 'yield') {
  await waitForSibling()
  process.exit(0)
}

const desiredPort = mode === 'wrong-port' ? 0 : Number(requestedPort)
const listeningPort = Number.isSafeInteger(desiredPort) && desiredPort > 0 ? desiredPort : 0
const health = Bun.serve({
  hostname: '127.0.0.1',
  port: listeningPort,
  fetch(request) {
    if (new URL(request.url).pathname !== '/health') return new Response('not found', { status: 404 })
    return Response.json({ ok: true, pid: healthPid, daemonVersion: '0.0.0-serve-stand-in' })
  }
})
writeFileSync(join(home, 'serve-daemon-bound-port'), String(health.port), { mode: 0o600 })

rmSync(socket, { force: true })
const listener = Bun.listen<SocketState>({
  unix: socket,
  socket: {
    open(client) {
      client.data = { pending: '' }
    },
    data(client, chunk) {
      const state = client.data
      state.pending += chunk.toString()
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

let runtime: RuntimeInfo | undefined
function writeRuntime(): void {
  const info = {
    pid: process.pid,
    port: mode === 'runtime-bad-port' ? 'abc' : health.port as number,
    token: 'serve-stand-in-token',
    hookToken: 'serve-stand-in-hook-token',
    daemonVersion: '0.0.0-serve-stand-in',
    protocolVersion: PROTOCOL_VERSION,
    startedAt: Date.now(),
    socket
  } as RuntimeInfo
  runtime = info
  if (mode === 'runtime-garbage') writeFileSync(runtimeFilePath(home), '{not json', { mode: 0o600 })
  else if (mode === 'runtime-other-pid') writePrivateJson(runtimeFilePath(home), { ...info, pid: process.ppid })
  else writePrivateJson(runtimeFilePath(home), info)
}

function statusResult() {
  return {
    daemonVersion: '0.0.0-serve-stand-in',
    pid: mode === 'status-wrong-pid' ? process.pid + 1 : process.pid,
    startedAt: runtime?.startedAt ?? Date.now(),
    home: mode === 'status-wrong-home' ? '/elsewhere' : home,
    ptyHost: { pid: null, alive: false },
    clients: [],
    safeMode: process.argv.includes('--disable-plugins'),
    socket
  }
}

function respond(client: Bun.Socket<SocketState>, id: number, result: unknown): void {
  client.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function handle(client: Bun.Socket<SocketState>, request: Request): void {
  if (request.method === 'client.hello') {
    respond(client, request.id, { protocolVersion: PROTOCOL_VERSION, daemonVersion: '0.0.0-serve-stand-in' })
  } else if (request.method === 'status.get') {
    respond(client, request.id, statusResult())
  } else {
    client.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } })}\n`)
  }
}

let closing = false
function stop(code: number): void {
  if (closing) return
  closing = true
  clearInterval(exitWatcher)
  clearInterval(homeWatcher)
  listener.stop(true)
  health.stop(true)
  rmSync(socket, { force: true })
  try {
    const current = JSON.parse(readFileSync(runtimeFilePath(home), 'utf8')) as { pid?: number }
    if (current.pid === process.pid) rmSync(runtimeFilePath(home), { force: true })
  } catch {}
  process.exit(code)
}

process.on('SIGTERM', () => {
  appendFileSync(signalsPath, 'SIGTERM\n', { mode: 0o600 })
  if (mode !== 'ignore-term') stop(0)
})
writeFileSync(join(home, 'serve-daemon-signal-handler'), String(process.pid), { mode: 0o600 })

const exitWatcher = setInterval(() => {
  if (mode !== 'exit-after-ready') return
  const path = join(home, 'serve-daemon-exit')
  if (!existsSync(path)) return
  const code = Number(readFileSync(path, 'utf8'))
  stop(Number.isInteger(code) ? code : 1)
}, 10)
const homeWatcher = setInterval(() => {
  if (!existsSync(home)) stop(0)
}, 50)

if (mode === 'slow-ready') setTimeout(writeRuntime, 2_000)
else writeRuntime()
