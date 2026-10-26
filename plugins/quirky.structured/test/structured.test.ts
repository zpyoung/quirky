import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RpcErrorCode,
  type ApiDescription,
  type QuirkyClient,
  type QuirkyEvent,
  type RpcError,
  type Session,
  type StructuredMessage
} from '@quirky/protocol'
import { startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { createClaudeRunner, type ClaudeQueryParams } from '../claude-runner'
import type { StructuredContext, StructuredRunner, StructuredRunnerFactory } from '../runner'
import { FakeQuery } from './fakes/fake-query'
import { FakeWorld } from './fakes/world'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const FAKES_DIR = join(PLUGIN_DIR, 'test', 'fakes')
const globals = globalThis as any

class FakeRunner implements StructuredRunner {
  started: { session: Session; prompt: string }[] = []
  sent: { sessionId: string; text: string }[] = []
  stopped: string[] = []
  startError: Error | null = null
  sendError: Error | null = null
  constructor(readonly context: StructuredContext) {}
  async start(session: Session, prompt: string) {
    if (this.startError) throw this.startError
    this.started.push({ session, prompt })
    this.context.appendMessage({ sessionId: session.id, role: 'user', text: prompt })
    this.context.setStatus(session.id, 'working')
  }
  async send(sessionId: string, text: string) {
    if (this.sendError) throw this.sendError
    this.sent.push({ sessionId, text })
    this.context.appendMessage({ sessionId, role: 'user', text, data: { n: 1 } })
  }
  async stop(sessionId: string) {
    this.stopped.push(sessionId)
  }
}

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]
let world: FakeWorld
let runner: FakeRunner

/** A short home under /tmp so unix sockets fit. */
const shortHome = () => mkdtempSync('/tmp/qs-')

function builtinDir(): string {
  const dir = makeTempDir('qs-builtin-')
  symlinkSync(PLUGIN_DIR, join(dir, 'quirky.structured'))
  for (const id of ['quirky.session', 'quirky.worktree', 'quirky.ask']) symlinkSync(join(FAKES_DIR, id), join(dir, id))
  return dir
}

async function boot(options: { factory?: StructuredRunnerFactory; home?: string; world?: FakeWorld } = {}) {
  world = options.world ?? new FakeWorld()
  globals.__structuredFakes = world
  globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ =
    options.factory ?? ((context: StructuredContext) => (runner = new FakeRunner(context)))
  h = await startHarness({ home: options.home ?? shortHome(), builtinPluginsDir: builtinDir() })
  ;({ client, events } = await h.connectWithEvents('cli'))
}

afterEach(async () => {
  await h?.cleanup()
  removeTempDirs()
  delete globals.__structuredFakes
  delete globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
})

const call = (method: string, params: Record<string, unknown> = {}) => client.callAny(method, params) as Promise<any>
const create = (prompt = 'fix the bug') =>
  call('quirky.structured/create', { worktree: 'main', agent: 'claude', prompt }) as Promise<Session>

async function failure(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected the call to reject')
}

const structuredEvents = () =>
  events.filter((e) => e.type === 'quirky.structured/message') as { type: string; data: { message: StructuredMessage } }[]

describe('structured sessions with a runner', () => {
  beforeEach(() => boot())

  test('create registers a structured session and starts the runner in the worktree', async () => {
    const session = await create()
    expect(session).toMatchObject({ kind: 'structured', agent: 'claude', worktreeId: 'wt_1', cwd: '/fake/alpha' })
    expect(world.registerCalls).toEqual([{ worktree: 'wt_1', agent: 'claude', kind: 'structured', title: 'Claude' }])
    await waitFor(() => runner.started.length === 1)
    expect(runner.started[0].prompt).toBe('fix the bug')
    expect(runner.started[0].session).toMatchObject({ id: session.id, cwd: '/fake/alpha' })
    expect(h.pty.requests.some((r) => r.type === 'create')).toBe(false)
    await waitFor(() => world.statusLog.some((entry) => entry.status === 'working'))
    expect(world.statusLog[0]).toEqual({ sessionId: session.id, status: 'working' })
  })

  test('create without a worktree resolves the caller current worktree', async () => {
    await call('quirky.structured/create', { agent: 'claude', prompt: 'go' })
    expect(world.resolveCalls[0]).toMatchObject({ selector: 'current' })
  })

  test('a second session in the same worktree gets a numbered title', async () => {
    await create()
    await create()
    expect(world.registerCalls.map((c) => c.title)).toEqual(['Claude', 'Claude 2'])
  })

  test('messages are stored, emitted and read back after a seq', async () => {
    const session = await create('go')
    await waitFor(() => runner.started.length === 1)
    await call('quirky.structured/send', { session: session.id, text: 'more' })
    expect(runner.sent).toEqual([{ sessionId: session.id, text: 'more' }])

    const all = (await call('quirky.structured/messages', { session: session.id })) as StructuredMessage[]
    expect(all.map((m) => [m.seq, m.role, m.text])).toEqual([
      [1, 'user', 'go'],
      [2, 'user', 'more']
    ])
    expect(all[1].data).toEqual({ n: 1 })
    const after = (await call('quirky.structured/messages', { session: session.id, afterSeq: 1 })) as StructuredMessage[]
    expect(after.map((m) => m.seq)).toEqual([2])
    await waitFor(() => structuredEvents().length === 2)
    expect(structuredEvents().map((e) => e.data.message.seq)).toEqual([1, 2])
  })

  test('done notifies once and closing the session stops the runner and drops its journal', async () => {
    const session = await create('go')
    await waitFor(() => runner.started.length === 1)
    runner.context.setStatus(session.id, 'done')
    runner.context.setStatus(session.id, 'done')
    await waitFor(() => h.notifications.length === 1)
    expect(h.notifications[0]).toEqual({ title: 'main', body: 'Claude finished' })
    await Bun.sleep(50)
    expect(h.notifications).toHaveLength(1)

    await call('quirky.session/close', { session: session.id })
    await waitFor(() => runner.stopped.length === 1)
    expect(runner.stopped).toEqual([session.id])
    expect(world.statusLog.some((entry) => entry.status === 'exited')).toBe(false)
    const db = new Database(join(h.home, 'plugin-data', 'quirky.structured', 'store.db'), { readonly: true })
    try {
      expect(db.query('SELECT COUNT(*) AS n FROM structured_messages').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  test('a runner needing input notifies as waiting', async () => {
    const session = await create('go')
    await waitFor(() => runner.started.length === 1)
    runner.context.setStatus(session.id, 'waiting')
    await waitFor(() => h.notifications.length === 1)
    expect(h.notifications[0]).toEqual({ title: 'main', body: 'Claude needs input' })
  })

  test('runner asks become asks and resolve once answered, across wait timeouts', async () => {
    const session = await create('go')
    await waitFor(() => runner.started.length === 1)
    const pending = runner.context.createAsk(
      { questions: [{ id: 'ok', type: 'confirm', question: 'Run rm?' }] },
      session.id
    )
    const ask = await waitForAsync(async () => ((await call('quirky.ask/list', { pendingOnly: true })) as any[])[0])
    expect(ask).toMatchObject({ sessionId: session.id, worktreeId: 'wt_1' })
    await Bun.sleep(world.askWaitCapMs * 3)
    await call('quirky.ask/answer', { askId: ask.id, answers: { ok: { value: true, source: 'input' } } })
    expect((await pending).status).toBe('answered')
    expect(await runner.context.resolveClaudePath()).toBeString()
  })

  test('closing a session declines its pending asks', async () => {
    const session = await create('go')
    await waitFor(() => runner.started.length === 1)
    const pending = runner.context.createAsk(
      { questions: [{ id: 'ok', type: 'confirm', question: 'Run rm?' }] },
      session.id
    )
    await waitForAsync(async () => ((await call('quirky.ask/list', { pendingOnly: true })) as any[])[0])
    await call('quirky.session/close', { session: session.id })
    expect((await pending).status).toBe('declined')
  })

  test('validates agent, worktree and session kind', async () => {
    expect(await failure(call('quirky.structured/create', { worktree: 'main', agent: 'codex', prompt: 'x' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'structured sessions support only the claude agent'
    })
    expect(await failure(call('quirky.structured/create', { worktree: 'nope', agent: 'claude', prompt: 'x' }))).toMatchObject({
      code: RpcErrorCode.NotFound
    })
    const terminal = world.addTerminalSession()
    expect(await failure(call('quirky.structured/send', { session: terminal.id, text: 'x' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: `session ${terminal.id} is not a structured session`
    })
    expect(await failure(call('quirky.structured/messages', { session: terminal.id }))).toMatchObject({
      code: RpcErrorCode.InvalidParams
    })
    expect(await failure(call('quirky.structured/messages', { session: 's_nope' }))).toMatchObject({
      code: RpcErrorCode.NotFound
    })
  })

  test('send failures from the runner surface as internal errors', async () => {
    const session = await create('go')
    await waitFor(() => runner.started.length === 1)
    runner.sendError = new Error('session is not running')
    expect(await failure(call('quirky.structured/send', { session: session.id, text: 'x' }))).toMatchObject({
      code: RpcErrorCode.Internal,
      message: 'quirky.structured: session is not running'
    })
  })

  test('the catalog lists the methods, the message event and read-only messages', async () => {
    const api = (await client.call('api.describe', {})) as ApiDescription
    const methods = api.methods.filter((m) => m.plugin === 'quirky.structured')
    expect(methods.map((m) => m.name).sort()).toEqual([
      'quirky.structured/create',
      'quirky.structured/messages',
      'quirky.structured/send'
    ])
    expect(methods.find((m) => m.name === 'quirky.structured/messages')?.readOnly).toBe(true)
    expect(api.events.map((e) => e.name)).toContain('quirky.structured/message')
  })
})

describe('a runner that fails to start', () => {
  test('leaves a system message and marks the session exited', async () => {
    await boot({
      factory: (context: StructuredContext) => {
        runner = new FakeRunner(context)
        runner.startError = new Error('no claude')
        return runner
      }
    })
    const session = await create()
    const messages = await waitForAsync(async () => {
      const found = (await call('quirky.structured/messages', { session: session.id })) as StructuredMessage[]
      return found.length > 0 && found
    })
    expect(messages[0]).toMatchObject({ role: 'system', text: 'could not start: no claude' })
    await waitFor(() => world.statusLog.some((entry) => entry.status === 'exited'))
  })
})

describe('the Claude runner inside the plugin', () => {
  test('SC-32: a structured session runs, asks permission, finishes and takes a follow-up', async () => {
    const queries: FakeQuery[] = []
    await boot({
      factory: (context: StructuredContext) =>
        createClaudeRunner(
          { ...context, resolveClaudePath: async () => '/usr/local/bin/claude' },
          {
            query: (params: ClaudeQueryParams) => {
              const query = new FakeQuery(params)
              queries.push(query)
              return query
            }
          }
        )
    })

    const session = await create('fix it')
    expect(await call('quirky.session/list', {})).toEqual([expect.objectContaining({ id: session.id, kind: 'structured' })])
    await waitFor(() => queries.length === 1)
    const query = queries[0]
    expect(query.params.options?.cwd).toBe('/fake/alpha')
    await waitFor(() => query.written.length === 1)

    query.emit({ type: 'system', subtype: 'init', session_id: 'c1', model: 'm' })
    const permission = (query.params.options!.canUseTool as any)('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu'
    })
    const ask = await waitForAsync(async () => ((await call('quirky.ask/list', { pendingOnly: true })) as any[])[0])
    expect(ask.sessionId).toBe(session.id)
    expect(ask.spec.questions[0].options.map((o: any) => o.value)).toEqual(['allow', 'deny', 'always'])
    await call('quirky.ask/answer', { askId: ask.id, answers: { decision: { value: 'allow', source: 'option' } } })
    expect(await permission).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })

    query.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } })
    query.emit({ type: 'result', subtype: 'success', result: 'All good', is_error: false })
    await waitFor(() => world.statusLog.some((entry) => entry.status === 'done'))
    expect(world.statusLog.map((entry) => entry.status)).toEqual(['working', 'waiting', 'working', 'done'])

    await call('quirky.structured/send', { session: session.id, text: 'and tests' })
    await waitFor(() => query.written.length === 2)
    const messages = (await call('quirky.structured/messages', { session: session.id })) as StructuredMessage[]
    expect(messages.map((m) => [m.role, m.text.split('\n')[0]])).toEqual([
      ['user', 'fix it'],
      ['system', 'session started (m)'],
      ['assistant', 'done'],
      ['result', 'All good'],
      ['user', 'and tests']
    ])
    await waitFor(() => structuredEvents().length === messages.length)
    expect(structuredEvents().map((e) => e.data.message.seq)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('deactivating the plugin', () => {
  test('stops a started Claude runner and denies its pending permission prompt', async () => {
    const queries: FakeQuery[] = []
    await boot({
      factory: (context: StructuredContext) =>
        createClaudeRunner(
          { ...context, resolveClaudePath: async () => '/usr/local/bin/claude' },
          {
            query: (params: ClaudeQueryParams) => {
              const query = new FakeQuery(params)
              queries.push(query)
              return query
            }
          }
        )
    })
    await create('fix it')
    await waitFor(() => queries.length === 1)
    const query = queries[0]
    const permission = (query.params.options!.canUseTool as any)('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu'
    })
    await waitForAsync(async () => ((await call('quirky.ask/list', { pendingOnly: true })) as any[])[0])

    await call('plugin.disable', { id: 'quirky.structured' })

    expect(query.closed).toBe(1)
    expect(await permission).toMatchObject({ behavior: 'deny' })
  })

  test('stops the runner for every live session', async () => {
    await boot()
    const first = await create('one')
    const second = await create('two')
    await call('plugin.disable', { id: 'quirky.structured' })
    expect(runner.stopped.sort()).toEqual([first.id, second.id].sort())
  })
})

describe('v1 journal import', () => {
  function writeV1Journal(home: string, rows: [string, number, string, string, string | null, number][]) {
    mkdirSync(home, { recursive: true })
    const db = new Database(join(home, 'quirky.db'))
    db.exec(`CREATE TABLE IF NOT EXISTS structured_messages (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      data TEXT, at INTEGER NOT NULL, PRIMARY KEY (session_id, seq))`)
    for (const row of rows) db.query('INSERT INTO structured_messages VALUES (?, ?, ?, ?, ?, ?)').run(...row)
    db.close()
  }

  test('SC-26: a v1 home keeps its structured journal, and a second start copies nothing again', async () => {
    const home = shortHome()
    writeV1Journal(home, [
      ['s_old', 1, 'user', 'earlier prompt', null, 10],
      ['s_old', 2, 'assistant', 'earlier answer', JSON.stringify({ raw: true }), 20]
    ])
    const first = new FakeWorld()
    first.addStructuredSession('s_old')
    await boot({ home, world: first })
    expect(await call('quirky.structured/messages', { session: 's_old' })).toEqual([
      { sessionId: 's_old', seq: 1, role: 'user', text: 'earlier prompt', at: 10 },
      { sessionId: 's_old', seq: 2, role: 'assistant', text: 'earlier answer', data: { raw: true }, at: 20 }
    ])

    const v1 = new Database(join(home, 'quirky.db'))
    v1.query("INSERT INTO structured_messages VALUES ('s_old', 3, 'user', 'added later', NULL, 30)").run()
    v1.close()
    for (const c of h.clients) c.close()
    await h.daemon.stop()
    h.pty.stop()

    const second = new FakeWorld()
    second.addStructuredSession('s_old')
    await boot({ home, world: second })
    const messages = (await call('quirky.structured/messages', { session: 's_old' })) as StructuredMessage[]
    expect(messages.map((m) => m.seq)).toEqual([1, 2])
  })
})
