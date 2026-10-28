import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Session } from '@quirky/protocol'
import { startAgentsE2E, type E2E, type CliResult } from '../../../quirky.agents/test/support/e2e'
import { createCodexAppServerFixture, type CodexAppServerFixture } from '../../../quirky.structured/test/fakes/codex-app-server'

const ROOT = resolve(import.meta.dir, '../../../..')
const CLI = join(ROOT, 'packages/cli/src/main.ts')
const AGENT = join(import.meta.dir, 'acceptance-agent.ts')

export interface WorkerAcceptance {
  fixture: E2E
  coordinator: Session
  native: CodexAppServerFixture
  cli(session: string, args: string[], timeout?: number): Promise<CliResult>
  callAs<T>(session: string, verb: string, flags?: string[]): Promise<T>
  session(id: string): Promise<Session>
  ptyAlive(id: string): Promise<boolean>
  events(id: string): Array<Record<string, unknown>>
  cleanup(): Promise<void>
}

export async function eventually<T>(read: () => T | Promise<T>, accepts: (value: T) => boolean, description: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (accepts(value)) return value
    if (Date.now() >= deadline) throw new Error(`timed out: ${description}; last=${JSON.stringify(value)}`)
    await Bun.sleep(25)
  }
}

/** The CLI is executed by the real launched coordinator/worker, not an impersonated hello. */
export async function startWorkerAcceptance(options: { heldPrefix?: string } = {}): Promise<WorkerAcceptance> {
  const fixture = await startAgentsE2E({ extraEnv: { WORKER_TEST_CLI: CLI }, timeScale: 0.1 })
  try {
    fixture.addFake('claude')
    const launcher = join(fixture.fakebin, 'claude')
    writeFileSync(launcher, `#!${process.execPath}
if (process.argv.includes('--version') || process.argv.includes('-v')) { console.log('Claude Code 2.1.80'); process.exit(0) }
process.stdout.write('\\x1b[?2004h')
await import(${JSON.stringify(AGENT)})
`)
    chmodSync(launcher, 0o755)
    const native = createCodexAppServerFixture(join(fixture.userHome, 'native-codex'), options)
    const codex = join(fixture.fakebin, 'codex')
    writeFileSync(codex, `#!${process.execPath}
import { startWorkerControl } from ${JSON.stringify(join(import.meta.dir, 'acceptance-control.ts'))}
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0) }
const control = startWorkerControl()
process.on('SIGTERM', () => { control.stop(); process.exit(0) })
process.on('SIGHUP', () => { control.stop(); process.exit(0) })
await import(${JSON.stringify(native.executable)})
`)
    chmodSync(codex, 0o755)
    await fixture.call('quirky.agents/refresh', {})
    await fixture.call('quirky.agents/setEnabled', { agent: 'codex', enabled: true })
    const coordinator = await fixture.call('quirky.session/create', { worktree: `path:${fixture.repo}`, agent: 'claude', title: 'Fixture coordinator' }) as Session
    await eventually(() => existsSync(join(fixture.home, 'worker-fixture', `${coordinator.id}.events.jsonl`)), Boolean, 'coordinator process to start')
    const cli = async (session: string, args: string[], timeout = 30_000): Promise<CliResult> => {
      const id = crypto.randomUUID()
      const dir = join(fixture.home, 'worker-fixture')
      appendFileSync(join(dir, `${session}.requests.jsonl`), JSON.stringify({ id, args: [...args, '--json'] }) + '\n')
      const reply = join(dir, `${id}.reply.json`)
      return eventually(
        () => existsSync(reply) ? JSON.parse(readFileSync(reply, 'utf8')) as CliResult : null,
        (value) => value !== null,
        `launched ${session} CLI ${args.join(' ')}`,
        timeout
      ).then((value) => value!)
    }
    return {
      fixture,
      coordinator,
      native,
      cli,
      async callAs<T>(session: string, verb: string, flags: string[] = []): Promise<T> {
        const result = await cli(session, ['orchestration', verb, ...flags])
        if (result.code !== 0) throw new Error(`orchestration ${verb} exit ${result.code}: ${result.stderr || result.stdout}`)
        try { return JSON.parse(result.stdout) as T } catch { throw new Error(`orchestration ${verb} did not return JSON: ${result.stdout}`) }
      },
      async session(id: string): Promise<Session> {
        return fixture.call('quirky.session/get', { session: id }) as Promise<Session>
      },
      async ptyAlive(id: string): Promise<boolean> {
        const inventory = await fixture.call('quirky.terminal/sessions', {}) as { sessions: Array<{ sessionId: string; alive: boolean }> }
        return inventory.sessions.some((session) => session.sessionId === id && session.alive)
      },
      events(id: string): Array<Record<string, unknown>> {
        const path = join(fixture.home, 'worker-fixture', `${id}.events.jsonl`)
        return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : []
      },
      cleanup: fixture.cleanup,
    }
  } catch (error) {
    await fixture.cleanup()
    throw error
  }
}
