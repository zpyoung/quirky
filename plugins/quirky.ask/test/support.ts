import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { QuirkyClient, type AskSpec, type ClientRole, type CliContext, type PluginStore, type QuirkyEvent } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { askQueueMigration } from '../store-migrations'
import { v1AsksMigration } from '../v1-import'

export const PLUGIN_DIR = resolve(import.meta.dir, '..')

export const PANEL = 'panel:quirky.ask/questions'

export const spec: AskSpec = {
  title: 'Deploy?',
  questions: [
    { id: 'env', type: 'select', question: 'Which environment?', options: [{ value: 'prod', label: 'Prod' }, { value: 'dev', label: 'Dev' }] },
    { id: 'why', type: 'text', question: 'Why?' }
  ]
}

export const confirmSpec: AskSpec = { questions: [{ id: 'go', type: 'confirm', question: 'Go?' }] }

const harnesses = new Set<Harness>()
const tempDirs: string[] = []

/** Stops every harness started through this module and removes its temp directories; call from `afterEach`. */
export async function cleanupAll(): Promise<void> {
  for (const harness of [...harnesses]) await harness.cleanup()
  harnesses.clear()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** A built-in plugins directory holding a symlink to quirky.ask alone. */
export function askOnlyPluginsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qa-bi-'))
  symlinkSync(PLUGIN_DIR, join(dir, 'quirky.ask'))
  tempDirs.push(dir)
  return dir
}

/** Starts a daemon on `home` (a fresh temp home by default) whose only built-in is quirky.ask. */
export async function startAsk(home: string = makeTempHome('qa-'), builtinPluginsDir = askOnlyPluginsDir()): Promise<Harness> {
  const harness = await startHarness({ home, builtinPluginsDir })
  harnesses.add(harness)
  return harness
}

/** Stops a harness's daemon and PTY host but keeps its home, so a second `startAsk` can reuse it. */
export async function stopKeepingHome(harness: Harness): Promise<void> {
  harnesses.delete(harness)
  tempDirs.push(harness.home)
  for (const client of harness.clients) client.close()
  await harness.daemon.stop()
  harness.pty.stop()
}

/** Connects a client with an identity, as the CLI does from `QUIRKY_SESSION_ID` and `QUIRKY_WORKTREE_ID`. */
export async function connectAs(
  harness: Harness,
  hello: { role?: ClientRole; name?: string; sessionId?: string; worktreeId?: string } = {}
): Promise<QuirkyClient> {
  const client = await QuirkyClient.connect(rpcUrl(harness.runtime), { role: 'cli', ...hello })
  harness.clients.push(client)
  return client
}

/** The error a call rejects with, or null when it resolves. */
export async function errorOf(promise: Promise<unknown>): Promise<{ code: number; message: string } | null> {
  try {
    await promise
    return null
  } catch (error) {
    return error as { code: number; message: string }
  }
}

export type TestCli = {
  ctx: CliContext
  /** Lines the command printed, JSON-parsed. */
  lines: unknown[]
  reconnects: number
}

/**
 * A `CliContext` over a harness client. `connect` supplies the client again after a reconnect;
 * `now` and `sleep` default to the real clock and a 10 ms pause.
 */
export function testCli(
  connect: () => Promise<QuirkyClient>,
  initial: QuirkyClient,
  options: { env?: Record<string, string>; cwd?: string; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
): TestCli {
  let client = initial
  const cli: TestCli = { ctx: null as never, lines: [], reconnects: 0 }
  cli.ctx = {
    requestBase: crypto.randomUUID(),
    call: (method, params = {}) => client.callAny(method, params),
    out: {
      json: false,
      result: (_value, text) => void cli.lines.push(text()),
      line: (text) => void cli.lines.push(text),
      jsonLine: (value) => void cli.lines.push(value)
    },
    format: { table: () => '', record: () => '' },
    env: options.env ?? {},
    cwd: options.cwd ?? process.cwd(),
    readFile: (path) => readFile(path, 'utf8'),
    sleep: options.sleep ?? (() => Bun.sleep(10)),
    now: options.now ?? Date.now,
    usage: (message) => Object.assign(new Error(message), { exit: 2 }),
    fail: (message) => Object.assign(new Error(message), { exit: 1 }),
    async reconnect() {
      cli.reconnects++
      client = await connect()
    }
  }
  return cli
}

/** A subscribed client standing in for the window; records events. */
export async function openWindow(harness: Harness, name = 'window'): Promise<{ client: QuirkyClient; events: QuirkyEvent[] }> {
  const client = await harness.connect('ui', name)
  const events: QuirkyEvent[] = []
  client.onEvent((event) => events.push(event))
  await client.call('events.subscribe', {})
  return { client, events }
}

/** A `PluginStore` over an in-memory database with no tables, enough to run a migration function. */
export function memoryStore(): PluginStore & { db: Database } {
  const db = new Database(':memory:')
  return {
    db,
    version: 0,
    run: (sql, ...params) => {
      const result = db.query(sql).run(...(params as never[]))
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get: (sql, ...params) => (db.query(sql).get(...(params as never[])) as never) ?? null,
    all: (sql, ...params) => db.query(sql).all(...(params as never[])) as never,
    exec: (sql) => db.exec(sql),
    transaction: (work) => db.transaction(work)()
  }
}

/** An in-memory store carrying both of the plugin's migrations, as `main.ts` opens it. */
export function migratedStore(home: string = makeTempHome('qa-')): PluginStore {
  const store = memoryStore()
  v1AsksMigration(home)(store)
  askQueueMigration(store)
  return store
}

/** The deploy spec from the logic spec's examples. */
export const deploy: AskSpec = {
  title: 'Deploy',
  questions: [
    {
      id: 'env',
      type: 'select',
      question: 'Which environment?',
      required: true,
      options: [
        { value: 'prod', label: 'Prod' },
        { value: 'dev', label: 'Dev' }
      ],
      default: 'dev'
    },
    { id: 'replicas', type: 'number', question: 'How many replicas?', integer: true, min: 1, max: 10 },
    { id: 'ship', type: 'date', question: 'Ship date?', header: 'Ship' },
    { id: 'go', type: 'confirm', question: 'Go ahead?', default: true }
  ]
}
