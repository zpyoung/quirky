import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { QuirkyClient, base64ToBytes, type QuirkyEvent, type Session } from '@quirky/protocol'
import { isDaemonAlive, readRuntime, rpcUrl } from '@quirky/protocol/node'
import { runCli, spawnCli, type CliResult } from '../../../packages/cli/test/fixtures/fake-daemon'

const DAEMON_ENTRY = resolve(import.meta.dir, '../../../packages/daemon/src/main.ts')
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g

/** Terminal bytes as the text a person would read: escape sequences removed, CRLF folded to LF. */
export function plain(bytes: Uint8Array | string): string {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)
  return text.replace(ANSI, '').replaceAll('\r\n', '\n').replaceAll('\r', '')
}

/**
 * Polls `probe` until it returns something other than `undefined`, `false` or `null`.
 * Fails with `what` and the last probe error when the deadline passes.
 */
export async function waitFor<T>(what: string, probe: () => T | Promise<T>, timeoutMs = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    try {
      const value = await probe()
      if (value !== undefined && value !== false && value !== null) return value as NonNullable<T>
    } catch (error) {
      lastError = error
    }
    if (Date.now() > deadline) {
      const reason = lastError instanceof Error ? `: ${lastError.message}` : ''
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${reason}`)
    }
    await Bun.sleep(100)
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type ProcessRow = { pid: number; ppid: number; command: string }

function processTable(): ProcessRow[] {
  // a busy machine's full command lines overflow the 1 MiB default buffer
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }))
}

/** The command line of `pid`, or `undefined` when it is gone. */
export function commandOf(pid: number): string | undefined {
  return processTable().find((row) => row.pid === pid)?.command
}

/** The processes below `pid`, at any depth. */
export function descendantsOf(pid: number): ProcessRow[] {
  return descendantsIn(processTable(), pid)
}

function descendantsIn(table: ProcessRow[], pid: number): ProcessRow[] {
  const found: ProcessRow[] = []
  const queue = [pid]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const row of table) {
      if (row.ppid === parent) {
        found.push(row)
        queue.push(row.pid)
      }
    }
  }
  return found
}

export type E2eOptions = {
  /** The login shell the daemon hands to sessions; default `/bin/zsh`. */
  shell?: string
  /** Contents of `$HOME/.zshrc`, which the zsh wrapper sources before its own integration. */
  zshrc?: string
}

export type Attached = {
  result: {
    streamId: number
    replay: string
    offset: number
    historyCursor: string | null
    cols: number
    rows: number
    restored: boolean
    shellState: string
    live: boolean
  }
  /** The replay as plain text. */
  replayText: string
  /** Plain text of everything the stream has carried so far. */
  streamText(): string
  detach(): Promise<void>
}

const live = new Set<E2eHarness>()
let exitHooksInstalled = false

function killLiveHarnessesNow(): void {
  for (const harness of [...live]) {
    try {
      harness.killNow()
    } catch {
      // best effort while the process is going down
    }
  }
}

/** Once per process, so a killed or crashed `bun test` still takes its daemons, hosts and shells with it. */
function installExitHooks(): void {
  if (exitHooksInstalled) return
  exitHooksInstalled = true
  process.on('exit', killLiveHarnessesNow)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const onSignal = () => {
      killLiveHarnessesNow()
      process.off(signal, onSignal)
      process.kill(process.pid, signal)
    }
    process.on(signal, onSignal)
  }
}

/** Stops everything every harness of this process started and removes its directories. */
export async function cleanupAll(): Promise<void> {
  const results = await Promise.allSettled([...live].map((harness) => harness.cleanup()))
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failed) throw failed.reason
}

/**
 * A real `quirkyd` with its real `quirky-pty` host and built-in plugins, a real git repo
 * registered with `quirky repo add`, and the real CLI. Every process it starts is killed by `cleanup`.
 */
export class E2eHarness {
  readonly events: QuirkyEvent[] = []
  private daemon: ReturnType<typeof Bun.spawn> | undefined
  private client: QuirkyClient | undefined
  private readonly tracked = new Map<number, string>()
  private sentinel = 0
  private cleaning: Promise<void> | undefined

  private constructor(
    readonly home: string,
    readonly repo: string,
    readonly shell: string,
    private readonly scratch: string
  ) {}

  /** Creates the temp home and repo, starts the daemon and registers the repo. */
  static async start(options: E2eOptions = {}): Promise<E2eHarness> {
    const home = mkdtempSync('/tmp/qe-')
    const scratch = mkdtempSync('/tmp/qr-')
    const repo = join(realpathSync(scratch), 'api')
    mkdirSync(repo)
    const harness = new E2eHarness(home, repo, options.shell ?? '/bin/zsh', scratch)
    live.add(harness)
    installExitHooks()
    try {
      if (options.zshrc !== undefined) writeFileSync(join(home, '.zshrc'), options.zshrc)
      harness.initRepo()
      await harness.startDaemon()
      await harness.ok(['repo', 'add', repo])
    } catch (error) {
      await harness.cleanup()
      throw error
    }
    return harness
  }

  private initRepo(): void {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=e2e@quirky.test', '-c', 'user.name=e2e', ...args], { cwd: this.repo, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(this.repo, 'README.md'), 'e2e\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
  }

  private daemonEnv(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '',
      HOME: this.home,
      QUIRKY_HOME: this.home,
      SHELL: this.shell,
      QUIRKY_PORT: '0',
      QUIRKY_TEST_ENTER_DELAY_MS: '20'
    }
  }

  /** Starts `quirkyd` and waits until it answers; the PTY host is the one it spawns itself. */
  async startDaemon(): Promise<void> {
    const before = readRuntime(this.home)?.pid
    const proc = Bun.spawn([process.execPath, DAEMON_ENTRY], {
      env: this.daemonEnv(),
      stdout: Bun.file(join(this.scratch, 'daemon.log')),
      stderr: Bun.file(join(this.scratch, 'daemon.log'))
    })
    this.daemon = proc
    this.tracked.set(proc.pid, commandOf(proc.pid) ?? '')
    await waitFor('quirkyd to start', async () => {
      const info = readRuntime(this.home)
      return info && info.pid === proc.pid && info.pid !== before && (await isDaemonAlive(info)) ? info : undefined
    }).catch((error: Error) => {
      throw new Error(`${error.message}; daemon log: ${this.daemonLog().slice(-600)}`)
    })
  }

  private daemonLog(): string {
    try {
      return readFileSync(join(this.scratch, 'daemon.log'), 'utf8')
    } catch {
      return ''
    }
  }

  get daemonPid(): number {
    return this.daemon!.pid
  }

  /** Stops `quirkyd` with `signal`; its PTY host and sessions are left running. */
  async stopDaemon(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const proc = this.daemon
    if (!proc) return
    this.client?.close()
    this.client = undefined
    this.noteProcesses()
    proc.kill(signal)
    await Promise.race([proc.exited, Bun.sleep(10_000)])
    if (isAlive(proc.pid) && signal !== 'SIGKILL') {
      proc.kill('SIGKILL')
      await proc.exited
    }
    this.daemon = undefined
  }

  /** The pid of the running PTY host, from `<home>/pty.pid`. */
  hostPid(): number {
    return Number(readFileSync(join(this.home, 'pty.pid'), 'utf8').trim())
  }

  /** Kills the PTY host with SIGKILL and returns its pid. */
  killHost(): number {
    this.noteProcesses()
    const pid = this.hostPid()
    process.kill(pid, 'SIGKILL')
    return pid
  }

  /** Remembers the daemon, the host and everything below them so cleanup can kill sessions the host no longer owns. */
  noteProcesses(): void {
    let table: ProcessRow[]
    try {
      table = processTable()
    } catch {
      return
    }
    const roots: ProcessRow[] = []
    const daemon = this.daemon && table.find((row) => row.pid === this.daemon!.pid)
    if (daemon) roots.push(daemon)
    try {
      // a stale pty.pid may name a recycled pid, so only a process running the host entry counts
      const host = table.find((row) => row.pid === this.hostPid() && row.command.includes('pty-host/'))
      if (host) roots.push(host)
    } catch {
      // no host running yet
    }
    for (const root of roots) {
      this.tracked.set(root.pid, root.command)
      for (const row of descendantsIn(table, root.pid)) this.tracked.set(row.pid, row.command)
    }
  }

  /** Has cleanup kill `pid` too, for a process that may outlive the host that started it. */
  track(pid: number): void {
    this.tracked.set(pid, commandOf(pid) ?? '')
  }

  cli(args: string[], options: { cwd?: string } = {}): Promise<CliResult> {
    return runCli(args, {
      home: this.home,
      cwd: options.cwd ?? this.repo,
      env: { SHELL: this.shell, QUIRKY_TEST_ENTER_DELAY_MS: '20' }
    })
  }

  spawnCli(args: string[]) {
    return spawnCli(args, { home: this.home, cwd: this.repo, env: { SHELL: this.shell, QUIRKY_TEST_ENTER_DELAY_MS: '20' } })
  }

  /** Runs a CLI command that must succeed and returns its stdout. */
  async ok(args: string[]): Promise<string> {
    const result = await this.cli(args)
    if (result.code !== 0) throw new Error(`quirky ${args.join(' ')} exited ${result.code}: ${result.stderr}`)
    return result.stdout
  }

  /** Runs a CLI command with `--json` and parses what it printed. */
  async json<T>(args: string[]): Promise<T> {
    return JSON.parse(await this.ok([...args, '--json'])) as T
  }

  /** A connected, event-subscribed WebSocket client; reconnects after the daemon restarted. */
  async connect(): Promise<QuirkyClient> {
    if (this.client && !this.client.isClosed) return this.client
    const info = readRuntime(this.home)
    if (!info) throw new Error('quirkyd is not running')
    const client = await QuirkyClient.connect(rpcUrl(info), { role: 'cli', name: 'e2e', subscribe: true })
    client.onEvent((event) => this.events.push(event))
    this.client = client
    return client
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await (await this.connect()).callAny(method, params)) as T
  }

  /** Creates a session through the CLI (`session new`) and returns its record. */
  async newSession(agent = 'shell'): Promise<Session> {
    const session = await this.json<Session>(['session', 'new', '--agent', agent, '--worktree', 'main'])
    this.noteProcesses()
    return session
  }

  async sessionRecord(id: string): Promise<Session> {
    return this.call<Session>('quirky.session/get', { session: id })
  }

  async sessionRecords(): Promise<Session[]> {
    return this.json<Session[]>(['session', 'list'])
  }

  /** Waits until the session's record satisfies `check`. */
  waitForSession(id: string, what: string, check: (session: Session) => boolean, timeoutMs = 30_000): Promise<Session> {
    return waitFor(
      `session ${id} ${what}`,
      async () => {
        const session = await this.sessionRecord(id)
        return check(session) ? session : undefined
      },
      timeoutMs
    )
  }

  /** The host's row for one running session (`quirky terminal sessions`). */
  async hostRow(id: string) {
    const { sessions } = await this.json<{ sessions: HostRow[] }>(['terminal', 'sessions'])
    return sessions.find((row) => row.sessionId === id)
  }

  /** The pid of the session's shell, once the host lists it. */
  async shellPid(id: string): Promise<number> {
    const row = await waitFor(`host row of ${id}`, () => this.hostRow(id))
    return row.pid
  }

  /** The visible screen and the last `lines` lines above it, as plain lines. */
  async screen(id: string, lines = 300): Promise<string[]> {
    const { lines: rows } = await this.call<{ lines: string[] }>('quirky.terminal/read', { session: id, lines })
    return rows.map((row) => plain(row).trimEnd())
  }

  waitForLine(id: string, line: string | RegExp, timeoutMs = 30_000): Promise<string[]> {
    return waitFor(
      `a screen line ${line} in ${id}`,
      async () => {
        const rows = await this.screen(id)
        return rows.some((row) => (typeof line === 'string' ? row === line : line.test(row))) ? rows : undefined
      },
      timeoutMs
    )
  }

  /** Types `text` and Enter into the session. */
  async type(id: string, text: string): Promise<void> {
    await this.call('quirky.terminal/send', { session: id, text, enter: true })
  }

  /**
   * Runs `command` in the shell and waits for the prompt that follows it. The sentinel is
   * computed by the shell, so the echoed command line never contains what is waited for.
   */
  async run(id: string, command: string): Promise<string[]> {
    const mark = 1000 + ++this.sentinel
    await this.type(id, `${command}; printf '@@%s@@\\n' $((${mark - 1}+1))`)
    return this.waitForLine(id, `@@${mark}@@`)
  }

  /** Attaches a client to the session like a pane would. */
  async attach(id: string, size: { cols: number; rows: number; historyLines?: number } = { cols: 80, rows: 24 }): Promise<Attached> {
    const client = await this.connect()
    const result = (await client.callAny('quirky.terminal/attach', { session: id, ...size })) as Attached['result']
    const chunks: Uint8Array[] = []
    client.onTerminalOutput(result.streamId, (bytes) => chunks.push(bytes.slice()))
    return {
      result,
      replayText: plain(base64ToBytes(result.replay)),
      streamText: () => plain(Buffer.concat(chunks)),
      detach: async () => {
        await client.callAny('quirky.terminal/detach', { streamId: result.streamId }).catch(() => {})
      }
    }
  }

  /** Writes `bin/<name>` in the quirky home, which login-shell commands find first on PATH. */
  writeBinScript(name: string, body: string): void {
    const bin = join(this.home, 'bin')
    mkdirSync(bin, { recursive: true })
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }

  /**
   * Kills the daemon, the host and every session process, then removes the temp directories.
   * Every step runs even when an earlier one throws; the first error is rethrown at the end.
   */
  cleanup(): Promise<void> {
    this.cleaning ??= this.runCleanup()
    return this.cleaning
  }

  private async runCleanup(): Promise<void> {
    const errors: unknown[] = []
    const step = async (run: () => void | Promise<void>) => {
      try {
        await run()
      } catch (error) {
        errors.push(error)
      }
    }
    try {
      await step(() => this.noteProcesses())
      await step(() => {
        try {
          this.client?.close()
        } finally {
          this.client = undefined
        }
      })
      await step(() => this.killDaemon())
      await step(() => this.noteProcesses())
      await step(() => this.killTracked())
      await step(() => rmSync(this.home, { recursive: true, force: true }))
      await step(() => rmSync(this.scratch, { recursive: true, force: true }))
    } finally {
      live.delete(this)
    }
    if (errors.length > 0) throw errors[0]
  }

  private async killDaemon(): Promise<void> {
    const proc = this.daemon
    if (!proc) return
    try {
      proc.kill('SIGTERM')
      await Promise.race([proc.exited, Bun.sleep(5000)])
    } finally {
      try {
        if (isAlive(proc.pid)) proc.kill('SIGKILL')
      } finally {
        this.daemon = undefined
      }
    }
  }

  /** The tracked pids that still run the command seen earlier, plus everything below them. */
  private livePids(): number[] {
    let table: ProcessRow[]
    try {
      table = processTable()
    } catch {
      return [...this.tracked.keys()]
    }
    // a recycled pid must not be killed: only a process still running the command seen earlier counts
    const current = new Map(table.map((row) => [row.pid, row.command]))
    const mine = [...this.tracked].filter(([pid, command]) => current.get(pid) === command).map(([pid]) => pid)
    const all = new Set(mine)
    for (const pid of mine) for (const row of descendantsIn(table, pid)) all.add(row.pid)
    return [...all]
  }

  private async killTracked(): Promise<void> {
    const pids = this.livePids()
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      for (const pid of pids) {
        try {
          process.kill(pid, signal)
        } catch {
          // already gone
        }
      }
      if (signal === 'SIGTERM') await Bun.sleep(300)
    }
  }

  /** Synchronous last resort for process exit and signals: SIGKILL everything tracked and remove the directories. */
  killNow(): void {
    this.noteProcesses()
    for (const pid of this.livePids()) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    rmSync(this.home, { recursive: true, force: true })
    rmSync(this.scratch, { recursive: true, force: true })
  }
}

export type HostRow = {
  sessionId: string
  state: string
  shellState: string
  pid: number
  cwd: string
  workspace: string
  worktreeId: string | null
}
