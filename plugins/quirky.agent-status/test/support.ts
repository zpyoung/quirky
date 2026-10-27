import { Database } from 'bun:sqlite'
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOOK_TOKEN_HEADER, type PtyFact, type QuirkyClient, type QuirkyEvent, type Session } from '@quirky/protocol'
import { makeTempHome, startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import type { AgentRow } from '../src/types'

const PLUGIN_DIR = join(import.meta.dir, '..')
const FAKES_DIR = join(import.meta.dir, 'fakes')

export const claudeSession: Session = {
  id: 's1',
  kind: 'terminal',
  agent: 'claude',
  worktreeId: 'wt1',
  cwd: '/fake/alpha/main',
  title: 'Claude',
  status: 'running',
  createdAt: 1,
  lastActivityAt: 1,
  exitCode: null,
  exitSignal: null,
  exitCause: null,
  restorable: false
}

export type SettledData = {
  sessionId: string
  worktreeId: string
  agent: string
  state: 'done' | 'waiting' | 'blocked'
  outcome: 'success' | 'cancellation' | 'failure' | null
  interrupted: boolean
  prompt: string | null
  toolName: string | null
  toolInput: string | null
  lastAssistantMessage: string | null
  at: number
}

export type StoredView = AgentRow & { display: string; label: string }
export type HookOptions = { session?: string; pid?: number; pstart?: string; event?: string }

/** A directory of built-ins holding the real plugin and fakes of everything it talks to. */
export function builtinDir(): string {
  const dir = makeTempDir('qas-')
  symlinkSync(PLUGIN_DIR, join(dir, 'quirky.agent-status'))
  for (const fake of ['quirky.session', 'quirky.worktree', 'quirky.agents']) symlinkSync(join(FAKES_DIR, fake), join(dir, fake))
  return dir
}

/** `ps -o lstart=` for a process, the way the plugin reads it. */
export function startOf(pid: number): string {
  const ps = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, TZ: 'UTC0', LC_ALL: 'C' } })
  return ps.stdout.toString().trim()
}

/** A running daemon with the real agent-status plugin over fake session, worktree and agents plugins. */
export class Rig {
  events: QuirkyEvent[] = []

  private constructor(
    public h: Harness,
    public client: QuirkyClient
  ) {}

  static async start(options: { home?: string; sessions?: Partial<Session>[] } = {}): Promise<Rig> {
    const h = await startHarness({ home: options.home ?? makeTempHome('qas-h-'), builtinPluginsDir: builtinDir() })
    const { client, events } = await h.connectWithEvents('cli')
    const rig = new Rig(h, client)
    rig.events = events
    for (const session of options.sessions ?? [{}]) await rig.seed(session)
    return rig
  }

  /** Stops the daemon without deleting its home and starts a new one on it. */
  async restart(options: { sessions?: Partial<Session>[] } = {}): Promise<Rig> {
    const { home } = this.h
    for (const client of this.h.clients) client.close()
    await this.h.daemon.stop()
    this.h.pty.stop()
    return Rig.start({ home, sessions: options.sessions ?? [] })
  }

  /** Stops the daemon, keeping the home, so a test can edit the plugin's store. */
  async stop(): Promise<void> {
    for (const client of this.h.clients) client.close()
    await this.h.daemon.stop()
    this.h.pty.stop()
  }

  storeFile(): string {
    return join(this.h.home, 'plugin-data', 'quirky.agent-status', 'store.db')
  }

  seed = (session: Partial<Session>) => this.client.callAny('quirky.session/seed', { ...claudeSession, ...session })

  cleanup = () => this.h.cleanup()

  post(agent: string, payload: unknown, options: HookOptions = {}): Promise<Response> {
    const query = new URLSearchParams({ session: options.session ?? 's1' })
    if (options.pid !== undefined) query.set('pid', String(options.pid))
    if (options.pstart !== undefined) query.set('pstart', options.pstart)
    if (options.event !== undefined) query.set('event', options.event)
    return fetch(`http://127.0.0.1:${this.h.runtime.port}/hook/${agent}?${query}`, {
      method: 'POST',
      headers: { [HOOK_TOKEN_HEADER]: this.h.runtime.hookToken },
      body: JSON.stringify(payload)
    })
  }

  private changedCount(session: string): number {
    return this.events.filter((e) => e.type === 'quirky.agent-status/changed' && (e as { data: { sessionId: string } }).data.sessionId === session).length
  }

  /**
   * Posts a hook and waits for the plugin to handle it: a change announces itself with `changed`, so
   * an event that changes nothing costs the whole grace period.
   */
  async hook(agent: string, payload: unknown, options: HookOptions = {}): Promise<void> {
    const session = options.session ?? 's1'
    const before = this.changedCount(session)
    const response = await this.post(agent, payload, options)
    if (response.status !== 200) throw new Error(`hook answered ${response.status}`)
    const deadline = Date.now() + 60
    while (this.changedCount(session) === before && Date.now() < deadline) await Bun.sleep(5)
    await Bun.sleep(5)
  }

  /** Lets the plugin's queue drain after hooks that are expected to change nothing. */
  settle = () => Bun.sleep(40)

  /** Types into a session through the daemon's PTY write path, so `onInput` listeners hear it. */
  write = (data: string, session = 's1') => this.client.callAny('quirky.session/write', { session, data })

  /** Injects a PTY fact as the PTY host would report it, then lets the plugin's queue drain. */
  async fact(fact: PtyFact, session = 's1'): Promise<void> {
    this.h.pty.fact(session, fact)
    await Bun.sleep(40)
  }

  /** Reports one OSC 7501 body for a session. */
  osc = (body: string, session = 's1') => this.fact({ kind: 'program-status', body }, session)

  title = (title: string, session = 's1') => this.fact({ kind: 'title', title }, session)

  async row(session = 's1'): Promise<StoredView | null> {
    return (await this.client.callAny('quirky.agent-status/get', { session })) as StoredView | null
  }

  async rowAt(at: number, session = 's1'): Promise<StoredView | null> {
    return (await this.client.callAny('quirky.agent-status/get', { session, at })) as StoredView | null
  }

  async state(session = 's1'): Promise<string | null> {
    return (await this.row(session))?.state ?? null
  }

  async session(session = 's1'): Promise<Session> {
    return (await this.client.callAny('quirky.session/get', { session })) as Session
  }

  statusCalls = async () =>
    (await this.client.callAny('quirky.session/calls', {})) as { session: string; status: string; agentStatus?: unknown }[]

  providerCalls = async () =>
    (await this.client.callAny('quirky.session/providerCalls', {})) as { session: string; id: string; transcriptPath?: string }[]

  list = async (params: Record<string, unknown> = {}) => (await this.client.callAny('quirky.agent-status/list', params)) as Record<string, unknown>[]

  /** The `notify` events sent so far; the plugin sends none. */
  notifies = () => this.events.filter((e) => e.type === 'notify')

  /** The data of every `settled` event so far, oldest first. */
  settles = () => this.events.filter((e) => e.type === 'quirky.agent-status/settled').map((e) => (e as { data: SettledData }).data)

  waitForSettles(count: number) {
    return waitFor(() => this.settles().length >= count)
  }

  /** Points the fake `quirky.agents` at an executable that prints `output` for `--version`. */
  async fakeClaude(output: string, exitCode = 0): Promise<void> {
    const script = join(makeTempDir('qas-claude-'), 'claude')
    writeFileSync(script, `#!/bin/sh\necho '${output}'\nexit ${exitCode}\n`)
    chmodSync(script, 0o755)
    await this.client.callAny('quirky.agents/setCommand', { command: script })
  }

  /** Runs the launch hooks as the real session plugin would for a new session of this agent. */
  async launchArgs(agent: string): Promise<string[]> {
    const created = (await this.client.callAny('quirky.session/create', { worktree: 'wt1', agent })) as { args: string[] }
    return created.args
  }
}

/** Edits rows in a stopped plugin's store; `edit` gets each parsed row and may return a replacement and an age. */
export function editStore(
  file: string,
  edit: (row: AgentRow) => { row: AgentRow; updatedAt: number } | null
): void {
  const db = new Database(file)
  for (const found of db.query('SELECT session_id, row FROM rows').all() as { session_id: string; row: string }[]) {
    const changed = edit(JSON.parse(found.row) as AgentRow)
    if (changed) db.query('UPDATE rows SET row = ?, updated_at = ? WHERE session_id = ?').run(JSON.stringify(changed.row), changed.updatedAt, found.session_id)
  }
  db.close()
}

export function insertRow(file: string, row: AgentRow, updatedAt: number): void {
  const db = new Database(file)
  db.query('INSERT INTO rows (session_id, row, updated_at) VALUES (?, ?, ?)').run(row.sessionId, JSON.stringify(row), updatedAt)
  db.close()
}

export { waitFor, waitForAsync, makeTempHome }
