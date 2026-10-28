import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { QuirkyClient, type CliContext, type Session, type Worktree } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { startDaemon, type DaemonHandle } from '../../../packages/daemon/src/daemon'
import { formatRecord, formatTable } from '../../../packages/cli/src/output'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'

const PLUGINS_ROOT = join(import.meta.dir, '..', '..')
const FAKES_ROOT = join(import.meta.dir, 'fakes')

export type PluginSet = {
  /** Real plugins of this repository, by ID. */
  real: string[]
  /** Fake plugins under `plugins/quirky.session/test/fakes`, by ID. */
  fakes: string[]
}

export const SESSION_PLUGINS: PluginSet = {
  real: ['quirky.session'],
  fakes: ['quirky.worktree', 'quirky.agents', 'quirky.agent-status', 'quirky.structured']
}

/** A built-in plugins directory that links the named plugins, so the daemon sees them as built-ins. */
export function makeBuiltinDir(home: string, set: PluginSet, name = 'builtin'): string {
  const dir = join(home, name)
  mkdirSync(dir, { recursive: true })
  const link = (source: string, id: string) => {
    rmSync(join(dir, id), { force: true })
    symlinkSync(join(source, id), join(dir, id))
  }
  for (const id of set.real) link(PLUGINS_ROOT, id)
  for (const id of set.fakes) link(FAKES_ROOT, id)
  return dir
}

/** Starts a daemon with the fake PTY host whose only built-ins are those of `set`. */
export async function startPluginHarness(
  set: PluginSet,
  options: { home?: string } & Parameters<typeof startHarness>[0] = {}
): Promise<Harness> {
  const home = options.home ?? makeTempHome()
  return startHarness({ ...options, home, builtinPluginsDir: makeBuiltinDir(home, set) })
}

export function call(client: QuirkyClient, method: string, params?: Record<string, unknown>): Promise<any>
export function call<T>(client: QuirkyClient, method: string, params?: Record<string, unknown>): Promise<T>
export function call(client: QuirkyClient, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return client.callAny(method, params)
}

export const createSession = (client: QuirkyClient, params: Record<string, unknown>) =>
  call<Session>(client, 'quirky.session/create', params)

export async function code(promise: Promise<unknown>): Promise<number | null> {
  try {
    await promise
    return null
  } catch (error) {
    return (error as { code: number }).code
  }
}

export type { Worktree }

/**
 * Stops the harness's daemon and starts another on the same home and fake PTY host, as a daemon
 * restart does while the PTY host keeps its sessions.
 */
export async function restartDaemon(
  h: Harness,
  options: { builtinPluginsDir?: string } = {}
): Promise<{ client: QuirkyClient; daemon: DaemonHandle; stop(): Promise<void> }> {
  await h.daemon.stop()
  const daemon = await startDaemon({
    home: h.home,
    port: 0,
    shell: '/bin/zsh',
    notifier: () => {},
    cliEntry: '/opt/quirky/cli/main.ts',
    uiDir: join(h.home, 'no-ui'),
    builtinPluginsDir: options.builtinPluginsDir ?? join(h.home, 'builtin')
  })
  const client = await QuirkyClient.connect(rpcUrl(daemon.runtime), { role: 'cli' })
  return {
    client,
    daemon,
    async stop() {
      client.close()
      await daemon.stop()
    }
  }
}

/** Puts a live session into the fake PTY host, as a host that outlived the previous daemon would hold it. */
export function seedPtySession(h: Harness, sessionId: string, output = ''): void {
  const buffer = [...new TextEncoder().encode(output)]
  h.pty.sessions.set(sessionId, {
    info: {
      sessionId,
      state: 'running',
      pid: 4999,
      alive: true,
      exitCode: null,
      exitSignal: null,
      exitCause: null,
      cols: 80,
      rows: 24,
      argv: ['/bin/zsh', '-l'],
      cwd: '/fake/alpha',
      title: null,
      shellState: 'unsupported',
      createdAt: 1,
      offset: buffer.length
    },
    env: {},
    buffer,
    subscribers: new Set()
  })
}

/** The columns of the v1 `sessions` table. */
const V1_SESSIONS = `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT NOT NULL, worktree_id TEXT NOT NULL, cwd TEXT NOT NULL,
  title TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
  exit_code INTEGER, repo_id TEXT)`

export type V1Session = {
  id: string
  worktreeId?: string
  cwd?: string
  title?: string
  status?: string
  repoId?: string | null
  agent?: string
  kind?: string
}

/** Adds sessions to the v1 tables in `<home>/quirky.db`, the file the previous version left. */
export function writeV1Sessions(home: string, sessions: V1Session[]): void {
  const db = new Database(join(home, 'quirky.db'), { create: true })
  try {
    db.exec(V1_SESSIONS)
    sessions.forEach((session, index) => {
      db.query('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)').run(
        session.id,
        session.kind ?? 'terminal',
        session.agent ?? 'shell',
        session.worktreeId ?? 'wt_main',
        session.cwd ?? '/fake/alpha',
        session.title ?? 'Shell',
        session.status ?? 'running',
        index + 1,
        index + 1,
        session.repoId === undefined ? 'repo_alpha' : session.repoId
      )
    })
  } finally {
    db.close()
  }
}

/** The rows of the `sessions` table of a plugin's own store. */
export function storedSessions(home: string, pluginId = 'quirky.session'): { id: string; repo_id: string | null }[] {
  const db = new Database(join(home, 'plugin-data', pluginId, 'store.db'), { readonly: true })
  try {
    return db.query('SELECT id, repo_id FROM sessions ORDER BY id').all() as { id: string; repo_id: string | null }[]
  } finally {
    db.close()
  }
}

/**
 * A `CliContext` over a connected client that collects printed lines, with the CLI's own table and
 * record formatters. `usage` and `fail` errors carry `kind` for assertions.
 */
export function testCliContext(
  client: QuirkyClient,
  options: { env?: Record<string, string>; cwd?: string; json?: boolean } = {}
): { ctx: CliContext; lines: string[] } {
  const lines: string[] = []
  const json = options.json ?? false
  const ctx: CliContext = {
    requestBase: crypto.randomUUID(),
    call: (method, params = {}) => client.callAny(method, params),
    out: {
      json,
      result: (value, text) => lines.push(json ? JSON.stringify(value) : text()),
      line: (text) => lines.push(text),
      jsonLine: (value) => lines.push(JSON.stringify(value))
    },
    format: { table: formatTable, record: (pairs) => formatRecord(pairs) },
    env: options.env ?? {},
    cwd: options.cwd ?? '/',
    readFile: async () => '',
    sleep: async () => {},
    now: () => Date.now(),
    usage: (message) => Object.assign(new Error(message), { kind: 'usage' }),
    fail: (message) => Object.assign(new Error(message), { kind: 'fail' }),
    reconnect: async () => {}
  }
  return { ctx, lines }
}
