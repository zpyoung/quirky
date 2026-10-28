import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Runs CLI commands as a real launched provider or structured tool process. */
export function startWorkerControl(onSettledReport?: () => void) {
  const home = process.env.QUIRKY_HOME
  const session = process.env.QUIRKY_SESSION_ID
  const cli = process.env.WORKER_TEST_CLI
  if (!home || !session || !cli) throw new Error('worker fixture requires its private launch environment')
  const root = join(home, 'worker-fixture')
  mkdirSync(root, { recursive: true })
  const requests = join(root, `${session}.requests.jsonl`)
  const events = join(root, `${session}.events.jsonl`)
  const children = new Set<Bun.Subprocess>()
  const log = (event: Record<string, unknown>) => appendFileSync(events, JSON.stringify(event) + '\n')
  log({ type: 'started', sessionId: session, pid: process.pid })
  let consumed = 0
  let running = false
  const timer = setInterval(async () => {
    if (running || !existsSync(requests)) return
    const lines = readFileSync(requests, 'utf8').split('\n').filter(Boolean)
    if (consumed >= lines.length) return
    running = true
    try {
      for (; consumed < lines.length; consumed++) {
        const request = JSON.parse(lines[consumed]!) as { id: string; args: string[] }
        if (!/^[a-zA-Z0-9-]+$/.test(request.id) || !Array.isArray(request.args)) throw new Error('invalid fixture request')
        const child = Bun.spawn([process.execPath, cli, ...request.args], { env: process.env, cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
        children.add(child)
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        children.delete(child)
        const reply = join(root, `${request.id}.reply.json`)
        const temporary = `${reply}.${process.pid}.tmp`
        writeFileSync(temporary, JSON.stringify({ stdout, stderr, code }))
        renameSync(temporary, reply)
        if (request.args.includes('worker_done')) onSettledReport?.()
      }
    } catch (error) {
      log({ type: 'fixture_error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      running = false
    }
  }, 20)
  const stop = () => {
    clearInterval(timer)
    for (const child of children) child.kill('SIGTERM')
  }
  return { log, stop }
}
