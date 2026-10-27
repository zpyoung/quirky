import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { QuirkyClient, type QuirkyEvent, type Session, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { isDaemonAlive, readRuntime, rpcUrl } from '@quirky/protocol/node'
import { startAgentsE2E, type CliResult, type E2E, type FakeBehavior, type FakeEvent } from '../../../quirky.agents/test/support/e2e'

export type { CliResult, FakeBehavior, FakeEvent }

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const DAEMON_MAIN = join(REPO_ROOT, 'packages/daemon/src/main.ts')
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts')

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
export const paste = (text: string): string => `${PASTE_START}${text}${PASTE_END}`

/** A fake agent that turns bracketed paste on after `delayMs`, as an agent that is ready to take a pasted prompt does. */
export const readyAfter = (delayMs: number): FakeBehavior => ({
  raw: true,
  steps: [
    { afterMs: delayMs, write: '\u001b[?2004h' },
    { afterMs: 10, write: '> \r\n' }
  ]
})

/** A fake agent that never signals ready. */
export const silent: FakeBehavior = { raw: true }

export type WorldOptions = {
  fakes?: Record<string, FakeBehavior | true>
  /** Multiplies the agents' delivery timers; 1 by default. */
  timeScale?: number
  /** Milliseconds between a paste and its Enter in `quirky.terminal/send`. */
  enterDelayMs?: number
}

/**
 * A real `quirkyd` with every built-in plugin and a real PTY host, fake agent CLIs, and project
 * `api` (branch main, files `math.ts` and `util.ts`) with the worktree `feat` on branch `zoe/feat`.
 * Everything lives in temporary directories; nothing outside them is read or written.
 */
export type World = {
  e2e: E2E
  feat: Worktree
  /** The calls of the current client, whichever daemon run it is connected to. */
  call(method: string, params?: Record<string, unknown>): Promise<any>
  /** Calls `quirky.git/<method>` on feat unless `params.worktree` says otherwise. */
  api(method: string, params?: Record<string, unknown>): Promise<any>
  /** Runs the real CLI with feat as its working directory. */
  cli(args: string[], options?: { cwd?: string }): Promise<CliResult>
  /** Starts the real CLI and returns the running process with its output collected. */
  spawnCli(args: string[]): { done: Promise<CliResult>; kill(): void }
  /** Starts a terminal session of `agent` in feat, with no prompt. */
  startSession(agent: string, extra?: Record<string, unknown>): Promise<Session>
  /** Sets what the agent-status plugin would: the coarse status and the summary state. */
  setAgentState(session: string, state: 'working' | 'waiting' | 'blocked' | 'done'): Promise<void>
  /** Every `quirky.git/notesChanged` event received so far, over the current client. */
  notesChanged(): QuirkyEvent[]
  /** Raw rows of the plugin's `notes` table, read from its store file. */
  storedNotes(): { id: string; worktree_id: string; path: string }[]
  /** Stops the daemon gracefully and starts another on the same homes. */
  restartDaemon(): Promise<void>
  cleanup(): Promise<void>
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.name=qg', '-c', 'user.email=qg@example.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }
  )
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
}

export async function startWorld(options: WorldOptions = {}): Promise<World> {
  const extraEnv: Record<string, string> = options.enterDelayMs === undefined ? {} : { QUIRKY_TEST_ENTER_DELAY_MS: String(options.enterDelayMs) }
  const e2e = await startAgentsE2E({ fakes: options.fakes ?? {}, timeScale: options.timeScale ?? 1, extraEnv })
  let restarted: ReturnType<typeof Bun.spawn> | undefined
  let client = e2e.client
  let events: QuirkyEvent[] = []
  const processes = new Set<ReturnType<typeof Bun.spawn>>()

  const watch = async () => {
    events = []
    const current = client
    current.onEvent((event) => {
      if (current === client) events.push(event)
    })
    await current.call('events.subscribe', {})
  }
  await watch()

  const call: World['call'] = (method, params = {}) => client.callAny(method, params)

  for (const [name, text] of [['math.ts', Array.from({ length: 40 }, (_, i) => `const m${i + 1} = ${i + 1}`).join('\n') + '\n'], ['util.ts', 'export const a = 1\nexport const b = 2\nexport const c = 3\nexport const d = 4\n']] as const) {
    mkdirSync(dirname(join(e2e.repo, name)), { recursive: true })
    writeFileSync(join(e2e.repo, name), text)
  }
  git(e2e.repo, 'add', '.')
  git(e2e.repo, 'commit', '-q', '-m', 'add sources')
  const root = join(dirname(e2e.home), 'worktrees')
  await call('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const repo = (await call('quirky.repo/list')).find((entry: { path: string }) => entry.path === e2e.repo)
  const made = (await call('quirky.worktree/create', { repo: repo.id, name: 'feat', branchName: 'zoe/feat', base: 'main', setup: 'skip' })) as WorktreeCreateResult
  const feat = made.worktree

  const cliEnv = () => ({ PATH: `${e2e.fakebin}:/usr/bin:/bin`, HOME: e2e.userHome, QUIRKY_HOME: e2e.home })
  const startCli = (args: string[], cwd: string) => {
    const proc = Bun.spawn([process.execPath, CLI_MAIN, ...args], { cwd, env: cliEnv(), stdout: 'pipe', stderr: 'pipe' })
    processes.add(proc)
    const done = Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]).then(
      ([stdout, stderr, code]) => {
        processes.delete(proc)
        return { code, stdout, stderr }
      }
    )
    return { done, kill: () => proc.kill('SIGKILL') }
  }

  return {
    e2e,
    feat,
    call,
    api: (method, params = {}) => call(`quirky.git/${method}`, { worktree: feat.id, ...params }),
    cli: (args, opts = {}) => startCli(args, opts.cwd ?? feat.path).done,
    spawnCli: (args) => startCli(args, feat.path),
    startSession: (agent, extra = {}) => call('quirky.session/create', { worktree: feat.id, agent, ...extra }) as Promise<Session>,
    async setAgentState(session, state) {
      const at = Date.now()
      const coarse = state === 'working' ? 'working' : state === 'done' ? 'done' : 'waiting'
      await call('quirky.session/setStatus', {
        session,
        status: coarse,
        agentStatus: { state, display: state, label: state, detail: '', progress: null, stateStartedAt: at, evidenceAt: at, restoredUnconfirmed: false }
      })
    },
    notesChanged: () => events.filter((event) => event.type === 'quirky.git/notesChanged'),
    storedNotes() {
      const db = new Database(join(e2e.home, 'plugin-data', 'quirky.git', 'store.db'), { readonly: true })
      try {
        return db.query('SELECT id, worktree_id, path FROM notes ORDER BY id').all() as { id: string; worktree_id: string; path: string }[]
      } finally {
        db.close()
      }
    },
    async restartDaemon() {
      const old = readRuntime(e2e.home)!
      client.close()
      process.kill(old.pid, 'SIGTERM')
      const deadline = Date.now() + 10_000
      while (await isDaemonAlive(old)) {
        if (Date.now() > deadline) throw new Error('the old quirkyd did not stop')
        await Bun.sleep(25)
      }
      const env = {
        ...cliEnv(),
        SHELL: join(dirname(e2e.home), 'shells', 'sh'),
        QUIRKY_AGENT_SEARCH_DIRS: '',
        QUIRKY_PORT: '0',
        QUIRKY_TEST_AGENT_TIME_SCALE: String(options.timeScale ?? 1),
        ...extraEnv
      }
      restarted = Bun.spawn([process.execPath, DAEMON_MAIN], { env, stdout: 'ignore', stderr: 'ignore' })
      let runtime = readRuntime(e2e.home)
      while (!runtime || runtime.pid === old.pid || !(await isDaemonAlive(runtime))) {
        if (Date.now() > deadline + 20_000) throw new Error('the restarted quirkyd did not start')
        await Bun.sleep(25)
        runtime = readRuntime(e2e.home)
      }
      client = await QuirkyClient.connect(rpcUrl(runtime), { role: 'cli', name: 'notes-world' })
      await watch()
    },
    async cleanup() {
      for (const proc of processes) proc.kill('SIGKILL')
      client.close()
      if (restarted && restarted.exitCode === null) {
        restarted.kill('SIGTERM')
        await Promise.race([restarted.exited, Bun.sleep(5000)])
        if (restarted.exitCode === null) restarted.kill('SIGKILL')
      }
      await e2e.cleanup()
    }
  }
}
