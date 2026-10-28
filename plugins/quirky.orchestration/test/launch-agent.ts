import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliProcess, CliResult } from './fixture'

if (process.argv.slice(2).includes('--version') || process.argv.slice(2).includes('-v')) {
  process.stdout.write('Claude Code 2.1.80 (isolated orchestration provider fixture)\n')
  process.exit(0)
}

const home = process.env.QUIRKY_HOME
const session = process.env.QUIRKY_SESSION_ID
const cli = process.env.WORKER_TEST_CLI
if (!home || !session || !cli || !process.env.QUIRKY_SESSION_TOKEN) {
  throw new Error('launch agent requires its kernel-issued session environment')
}
const cliPath = cli

const root = join(home, 'orchestration-terminal')
mkdirSync(root, { recursive: true })
const requests = join(root, `${session}.requests.jsonl`)
appendFileSync(join(root, `${session}.events.jsonl`), JSON.stringify({ type: 'started', sessionId: session, pid: process.pid }) + '\n')
writeFileSync(join(root, `${session}.ready`), 'ready')
const children = new Set<CliProcess>()
let consumed = 0
let running = false

async function drainRequests(cli: string): Promise<void> {
  if (running || !existsSync(requests)) return
  const lines = readFileSync(requests, 'utf8').split('\n').filter(Boolean)
  if (consumed >= lines.length) return
  running = true
  try {
    for (; consumed < lines.length; consumed += 1) {
      const request = JSON.parse(lines[consumed]!) as { id: string; args: string[] }
      if (!/^[a-zA-Z0-9-]+$/.test(request.id) || !Array.isArray(request.args)) {
        throw new Error('invalid launch-agent CLI request')
      }
      const child = Bun.spawn([process.execPath, cliPath, ...request.args], {
        env: process.env,
        stdin: 'ignore',
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe'
      })
      children.add(child)
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
      ])
      children.delete(child)
      const reply = join(root, `${request.id}.reply.json`)
      const staging = `${reply}.pending`
      writeFileSync(staging, JSON.stringify({ code, stdout, stderr }))
      renameSync(staging, reply)
      appendFileSync(join(root, `${session}.events.jsonl`), JSON.stringify({ type: 'cli', id: request.id, code }) + '\n')
    }
  } catch (error) {
    appendFileSync(join(root, `${session}.events.jsonl`), JSON.stringify({
      type: 'fixture_error',
      message: error instanceof Error ? error.message : String(error)
    }) + '\n')
  } finally {
    running = false
  }
}

// The launched provider polls its per-session JSONL bridge so each real CLI child inherits that launch environment.
const poll = setInterval(() => void drainRequests(cli), 20)
async function stop(): Promise<void> {
  clearInterval(poll)
  const active = [...children]
  for (const child of active) {
    try {
      child.kill('SIGTERM')
    } catch {}
  }
  await Promise.all(active.map((child) => child.exited.catch(() => undefined)))
}

process.once('SIGTERM', () => void stop().finally(() => process.exit(0)))
process.once('SIGHUP', () => void stop().finally(() => process.exit(0)))
