import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Session } from '@quirky/protocol'
import { isDaemonAlive, readRuntime } from '@quirky/protocol/node'
import { startAgentsE2E, type CliResult, type E2E, type FakeBehavior, type FakeEvent, type StartOptions } from '../../../quirky.agents/test/support/e2e'

export type { CliResult, E2E, FakeBehavior, FakeEvent }
export type Start = Extract<FakeEvent, { type: 'start' }>

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const DAEMON_MAIN = join(REPO_ROOT, 'packages/daemon/src/main.ts')
const AGENTS_MANIFEST = join(REPO_ROOT, 'plugins/quirky.agents/quirky-plugin.json')

export const PRESENCE_JOB = 'job:quirky.agent-status/presence'

/** An agents harness that can also restart its daemon on the same homes and run the hook shim as an agent would. */
export type StatusE2E = E2E & {
  /** Stops the daemon gracefully and starts a new one on the same `QUIRKY_HOME` and `HOME`. */
  restartDaemon(): Promise<void>
  /** Writes `content` (an object is written as JSON) under the temporary `HOME`; returns the absolute path. */
  put(relative: string, content: string | object): string
  /** Reads a file under the temporary `HOME`; null when it does not exist. */
  read(relative: string): string | null
  /** Runs `$QUIRKY_HOME/bin/quirky-hook <source>` the way an agent inside `sessionId` would. */
  shim(source: string, sessionId: string, payload: unknown, options?: { pid?: number; event?: string }): Promise<{ code: number; stdout: string }>
}

export async function startStatusE2E(options: StartOptions = {}): Promise<StatusE2E> {
  const base = await startAgentsE2E(options)
  const env: Record<string, string> = {
    QUIRKY_HOME: base.home,
    HOME: base.userHome,
    SHELL: join(dirname(base.home), 'shells', 'sh'),
    PATH: `${base.fakebin}:/usr/bin:/bin`,
    QUIRKY_AGENT_SEARCH_DIRS: options.searchDirs ?? '',
    QUIRKY_PORT: '0',
    QUIRKY_TEST_AGENT_TIME_SCALE: String(options.timeScale ?? 1),
    ...options.extraEnv
  }


  const harness: StatusE2E = {
    ...base,
    async restartDaemon() {
      try {
        const old = readRuntime(base.home)!
        process.kill(old.pid, 'SIGTERM')
        const deadline = Date.now() + 10_000
        while (await isDaemonAlive(old)) {
          if (Date.now() > deadline) throw new Error('the old quirkyd did not stop')
          await Bun.sleep(25)
        }
        const proc = base.processScope.spawn([process.execPath, DAEMON_MAIN], {
          env: { ...env, ...base.processScope.env },
          stdout: 'ignore',
          stderr: 'ignore'
        })
        const restartDeadline = Date.now() + 20_000
        for (;;) {
          if (proc.exitCode !== null) throw new Error(`the restarted quirkyd exited ${proc.exitCode}`)
          const info = readRuntime(base.home)
          if (info && info.pid !== old.pid && (await isDaemonAlive(info))) break
          if (Date.now() > restartDeadline) throw new Error('timed out waiting for the restarted quirkyd')
          await Bun.sleep(25)
        }
      } catch (error) {
        try {
          await base.cleanup()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'status E2E daemon restart and cleanup failed')
        }
        throw error
      }
    },
    put(relative, content) {
      const path = join(base.userHome, relative)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
      return path
    },
    read(relative) {
      const path = join(base.userHome, relative)
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    },
    async shim(source, sessionId, payload, shimOptions = {}) {
      const identity = JSON.parse(readFileSync(join(base.home, 'daemon-identity.json'), 'utf8')) as { hookToken: string }
      const proc = base.processScope.spawn([join(base.home, 'bin', 'quirky-hook'), source], {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: base.userHome,
          QUIRKY_HOME: base.home,
          QUIRKY_SESSION_ID: sessionId,
          QUIRKY_HOOK_TOKEN: identity.hookToken,
          ...(shimOptions.pid === undefined ? {} : { QUIRKY_HOOK_AGENT_PID: String(shimOptions.pid) }),
          ...(shimOptions.event === undefined ? {} : { QUIRKY_HOOK_EVENT: shimOptions.event }),
          ...base.processScope.env
        },
        stdin: new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload)),
        stdout: 'pipe',
        stderr: 'ignore'
      })
      const [stdout, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited])
      return { code, stdout }
    }
  }
  return harness
}

/** Runs a CLI command that must succeed and parses its `--json` output. */
export async function cliJson<T>(e2e: E2E, args: string[]): Promise<T> {
  const result = await e2e.cli([...args, '--json'])
  if (result.code !== 0) throw new Error(`quirky ${args.join(' ')} exited ${result.code}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout) as T
}

/** Creates a session; without `agent` the daemon picks, which is a plain shell when no agent CLI is installed. */
export const newSession = (e2e: E2E, agent?: string) => cliJson<Session>(e2e, ['session', 'new', ...(agent === undefined ? [] : ['--agent', agent])])

export const sessionOf = (e2e: E2E, id: string) => cliJson<Session>(e2e, ['session', 'get', id])

export async function startOf(e2e: E2E, fake: string, sessionId: string): Promise<Start> {
  const events = await e2e.waitForFakeLog(fake, (log) => log.some((event) => event.type === 'start' && event.env.QUIRKY_SESSION_ID === sessionId), 15_000)
  return events.find((event): event is Start => event.type === 'start' && event.env.QUIRKY_SESSION_ID === sessionId)!
}

export async function waitFor<T>(check: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

type AgentDeclaration = { id: string; detect?: string; detectAliases?: string[]; detectRequires?: string[] }

/** The command names that make `agent` read as installed, taken from the agents plugin's own declarations. */
export function detectCommands(agent: string): string[] {
  const manifest = JSON.parse(readFileSync(AGENTS_MANIFEST, 'utf8')) as { contributes: { agent: AgentDeclaration[] } }
  const entry = manifest.contributes.agent.find((declared) => declared.id === agent)
  if (!entry?.detect) throw new Error(`no agent declaration for ${agent}`)
  return [entry.detect, ...(entry.detectRequires ?? [])]
}

/** Makes `agent` detectable by adding a fake for each command its detection needs, then refreshes detection. */
export async function installAgents(e2e: E2E, agents: string[]): Promise<void> {
  for (const agent of agents) for (const command of detectCommands(agent)) if (!existsSync(join(e2e.fakebin, command))) e2e.addFake(command)
  const refreshed = await e2e.cli(['agents', 'refresh'])
  if (refreshed.code !== 0) throw new Error(`quirky agents refresh failed: ${refreshed.stderr || refreshed.stdout}`)
}
