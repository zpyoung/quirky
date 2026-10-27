import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

/**
 * A stand-in for an agent CLI in end-to-end tests. A launcher script in the fake bin dir imports
 * this file; behavior comes from `<launcher>.json` and every event is appended to
 * `<launcher>.log.jsonl`, both next to the launcher. Step `afterMs` delays are relative to the
 * previous step, and `exitAfterMs` counts from process start. Started with exactly `--version` it logs
 * a `version` event instead of `start`, prints the `version` behavior's text (default `0.0.0 (fake)`)
 * and exits at once, so a version probe never looks like a launch. Bytes appended to
 * `<launcher>.outbox` while it runs are written to stdout (content present at start is not replayed).
 */
type Behavior = {
  raw?: boolean
  steps?: { afterMs: number; write: string }[]
  exitAfterMs?: number
  exitCode?: number
  version?: { stdout?: string; exitCode?: number }
}

const LOGGED_ENV = [
  'GOOSE_MODE',
  'CODEX_HOME',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'QUIRKY_SESSION_ID',
  'HERMES_QUIRKY_STARTUP_QUERY',
  'PATH',
  'HOME'
]

const self = process.argv[1]!
const logPath = `${self}.log.jsonl`
const behaviorPath = `${self}.json`
const outboxPath = `${self}.outbox`
const behavior: Behavior = existsSync(behaviorPath) ? JSON.parse(readFileSync(behaviorPath, 'utf8')) : {}

function log(event: Record<string, unknown>): void {
  appendFileSync(logPath, `${JSON.stringify({ ...event, at: Date.now() })}\n`)
}

const env: Record<string, string> = {}
for (const name of LOGGED_ENV) {
  const value = process.env[name]
  if (value !== undefined) env[name] = value
}
if (process.argv.length === 3 && process.argv[2] === '--version') {
  log({ type: 'version', argv: process.argv.slice(2) })
  process.stdout.write(behavior.version?.stdout ?? '0.0.0 (fake)')
  process.exit(behavior.version?.exitCode ?? 0)
}
let outboxOffset = existsSync(outboxPath) ? statSync(outboxPath).size : 0
log({ type: 'start', argv: process.argv.slice(2), env, cwd: process.cwd(), pid: process.pid })

let exited = false
function finish(code: number): never {
  if (!exited) {
    exited = true
    log({ type: 'exit' })
  }
  process.exit(code)
}
process.on('SIGTERM', () => finish(143))
process.on('SIGHUP', () => finish(129))
process.on('SIGINT', () => finish(130))

if (behavior.raw && process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (chunk: Buffer) => log({ type: 'input', b64: Buffer.from(chunk).toString('base64') }))
process.stdin.resume()

const OUTBOX_POLL_MS = 50
setInterval(() => {
  if (!existsSync(outboxPath)) return
  const size = statSync(outboxPath).size
  if (size <= outboxOffset) return
  const chunk = Buffer.alloc(size - outboxOffset)
  const fd = openSync(outboxPath, 'r')
  try {
    readSync(fd, chunk, 0, chunk.length, outboxOffset)
  } finally {
    closeSync(fd)
  }
  outboxOffset = size
  process.stdout.write(chunk)
}, OUTBOX_POLL_MS)

let elapsed = 0
for (const step of behavior.steps ?? []) {
  elapsed += step.afterMs
  setTimeout(() => process.stdout.write(step.write), elapsed)
}
if (behavior.exitAfterMs !== undefined) setTimeout(() => finish(behavior.exitCode ?? 0), behavior.exitAfterMs)
else setInterval(() => {}, 60_000)
