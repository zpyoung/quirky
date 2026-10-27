import { appendFileSync, existsSync, readFileSync } from 'node:fs'

/**
 * A stand-in for an agent CLI in end-to-end tests. A launcher script in the fake bin dir imports
 * this file; behavior comes from `<launcher>.json` and every event is appended to
 * `<launcher>.log.jsonl`, both next to the launcher. Step `afterMs` delays are relative to the
 * previous step, and `exitAfterMs` counts from process start. Started with exactly `--version` and a
 * `version` behavior, it prints that text and exits at once.
 */
type Behavior = {
  raw?: boolean
  steps?: { afterMs: number; write: string }[]
  exitAfterMs?: number
  exitCode?: number
  version?: { stdout: string; exitCode?: number }
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
const behavior: Behavior = existsSync(behaviorPath) ? JSON.parse(readFileSync(behaviorPath, 'utf8')) : {}

function log(event: Record<string, unknown>): void {
  appendFileSync(logPath, `${JSON.stringify({ ...event, at: Date.now() })}\n`)
}

const env: Record<string, string> = {}
for (const name of LOGGED_ENV) {
  const value = process.env[name]
  if (value !== undefined) env[name] = value
}
log({ type: 'start', argv: process.argv.slice(2), env, cwd: process.cwd(), pid: process.pid })

let exited = false
function finish(code: number): never {
  if (!exited) {
    exited = true
    log({ type: 'exit' })
  }
  process.exit(code)
}
if (behavior.version && process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write(behavior.version.stdout)
  finish(behavior.version.exitCode ?? 0)
}
process.on('SIGTERM', () => finish(143))
process.on('SIGHUP', () => finish(129))
process.on('SIGINT', () => finish(130))

if (behavior.raw && process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (chunk: Buffer) => log({ type: 'input', b64: Buffer.from(chunk).toString('base64') }))
process.stdin.resume()

let elapsed = 0
for (const step of behavior.steps ?? []) {
  elapsed += step.afterMs
  setTimeout(() => process.stdout.write(step.write), elapsed)
}
if (behavior.exitAfterMs !== undefined) setTimeout(() => finish(behavior.exitCode ?? 0), behavior.exitAfterMs)
else setInterval(() => {}, 60_000)
