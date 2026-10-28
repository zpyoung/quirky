import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RpcErrorCode,
  type QuirkyClient,
  type QuirkyEvent,
  type RpcError,
  type Session,
  type StructuredMessage
} from '@quirky/protocol'
import { startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { createClaudeRunner, type ClaudeQueryParams } from '../claude-runner'
import { createCodexRunner } from '../codex-runner'
import type { StructuredContext, StructuredLaunchOptions, StructuredStartOptions, StructuredRunner, StructuredRunnerFactory } from '../runner'
import { createCodexAppServerFixture, isolatedProviderEnvironment } from './fakes/codex-app-server'
import { FakeQuery } from './fakes/fake-query'
import { FakeWorld } from './fakes/world'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const FAKES_DIR = join(PLUGIN_DIR, 'test', 'fakes')
const globals = globalThis as any

class FakeRunner implements StructuredRunner {
  started: { session: Session; prompt: string | undefined; options?: unknown }[] = []
  sent: { sessionId: string; text: string }[] = []
  stopped: string[] = []
  startError: Error | null = null
  sendError: Error | null = null
  constructor(readonly context: StructuredContext) {}
  async start(session: Session, prompt?: string, options?: StructuredStartOptions) {
    if (this.startError) throw this.startError
    this.started.push({ session, prompt, options })
    if (prompt !== undefined) this.context.appendMessage({ sessionId: session.id, role: 'user', text: prompt })
    this.context.setStatus(session.id, prompt === undefined ? 'running' : 'working')
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

function builtinDir(accountPreparation = false): string {
  const dir = makeTempDir('qs-builtin-')
  symlinkSync(PLUGIN_DIR, join(dir, 'quirky.structured'))
  for (const id of ['quirky.session', 'quirky.worktree', 'quirky.ask', 'quirky.agents']) symlinkSync(join(FAKES_DIR, id), join(dir, id))
  if (accountPreparation) symlinkSync(join(FAKES_DIR, 'quirky.accounts'), join(dir, 'quirky.accounts'))
  return dir
}

async function boot(options: { factory?: StructuredRunnerFactory | null; home?: string; world?: FakeWorld; accountPreparation?: boolean } = {}) {
  world = options.world ?? new FakeWorld()
  globals.__structuredFakes = world
  globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ =
    options.factory === null ? undefined : options.factory ?? ((context: StructuredContext) => (runner = new FakeRunner(context)))
  h = await startHarness({
    home: options.home ?? shortHome(),
    builtinPluginsDir: builtinDir(options.accountPreparation === true)
  })
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
type StructuredAgent = 'claude' | 'codex'
type StructuredCreateOverrides = {
  model?: string
  options?: Record<string, string | boolean>
}
const createAgent = (agent: StructuredAgent, prompt = 'fix the bug', overrides: StructuredCreateOverrides = {}) =>
  call('quirky.structured/create', { worktree: 'main', agent, prompt, ...overrides }) as Promise<Session>


async function failure(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected the call to reject')
}

type Settled = {
  sessionId: string
  worktreeId: string
  agent: string
  state: 'done' | 'waiting'
  lastAssistantMessage: string | null
  at: number
}
const settledEvents = () => events.filter((e) => e.type === 'quirky.structured/settled').map((e) => (e as { data: Settled }).data)

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
    expect(world.planCalls).toEqual([])
    expect(world.accountPrepareCalls).toEqual([])
    await waitFor(() => world.statusLog.some((entry) => entry.status === 'working'))
    expect(world.statusLog[0]).toEqual({ sessionId: session.id, status: 'working' })
  })


  test('a structured tool child authenticates with its launch lease', async () => {
    const session = await create()
    await waitFor(() => runner.started.length === 1)
    const launchEnv = (runner.started[0]?.options as StructuredLaunchOptions | undefined)?.env
    if (
      !launchEnv ||
      typeof launchEnv.QUIRKY_HOME !== 'string' ||
      typeof launchEnv.QUIRKY_SESSION_ID !== 'string' ||
      typeof launchEnv.QUIRKY_SESSION_TOKEN !== 'string'
    ) {
      throw new Error('structured runner did not receive its kernel session environment')
    }
    const script = String.raw`
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
const runtime = JSON.parse(readFileSync(join(process.env.QUIRKY_HOME, 'runtime.json'), 'utf8'))
const client = await QuirkyClient.connect(rpcUrl(runtime), {
  role: 'cli',
  sessionId: process.env.QUIRKY_SESSION_ID,
  sessionToken: process.env.QUIRKY_SESSION_TOKEN
})
try {
  const authority = await client.callAny('quirky.session/callerAuthority', {})
  process.stdout.write(JSON.stringify(authority) ?? 'null')
} finally {
  client.close()
}
`
    const child = Bun.spawn([process.execPath, '-e', script], {
      cwd: join(PLUGIN_DIR, '../..'),
      env: {
        HOME: h.home,
        PATH: typeof launchEnv.PATH === 'string' ? launchEnv.PATH : (process.env.PATH ?? ''),
        QUIRKY_HOME: launchEnv.QUIRKY_HOME,
        QUIRKY_SESSION_ID: launchEnv.QUIRKY_SESSION_ID,
        QUIRKY_SESSION_TOKEN: launchEnv.QUIRKY_SESSION_TOKEN
      },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ])
      if (exitCode !== 0) throw new Error(stderr)
      const authority = JSON.parse(stdout) as Record<string, unknown>
      const runtimeEpoch = authority.runtimeEpoch
      const processIncarnation = authority.processIncarnation
      if (
        authority.sessionId !== session.id ||
        authority.live !== true ||
        typeof runtimeEpoch !== 'string' ||
        runtimeEpoch.length === 0 ||
        typeof processIncarnation !== 'string' ||
        processIncarnation.length === 0
      ) {
        throw new Error('structured child did not receive valid runtime authority')
      }
      expect(JSON.stringify(authority)).not.toContain(launchEnv.QUIRKY_SESSION_TOKEN)
    } finally {
      if (child.exitCode === null) child.kill()
    }
  })

  test('reserves a live structured lease without sending a deferred initial turn', async () => {
    const session = (await call('quirky.structured/create', {
      worktree: 'main',
      agent: 'claude',
      title: 'Worker',
      deferStart: true
    })) as Session
    await waitFor(() => runner.started.length === 1)

    expect(session.title).toBe('Worker')
    expect(runner.started[0]?.prompt).toBeUndefined()
    expect(runner.sent).toEqual([])
  })

  test('revokes structured identity on stop and runner exit', async () => {
    const stopped = await create('stop me')
    await waitFor(() => runner.started.length === 1)
    const beforeStop = await call('quirky.session/identity', { session: stopped.id })
    expect(beforeStop).toMatchObject({ sessionId: stopped.id, live: true })
    await call('quirky.structured/stop', { session: stopped.id })
    await expect(call('quirky.session/identity', { session: stopped.id })).rejects.toMatchObject({
      code: RpcErrorCode.NotFound
    })

    const exited = await create('exit me')
    await waitFor(() => runner.started.length === 2)
    const beforeExit = await call('quirky.session/identity', { session: exited.id })
    expect(beforeExit).toMatchObject({ sessionId: exited.id, live: true })
    runner.context.setStatus(exited.id, 'exited')
    await expect(call('quirky.session/identity', { session: exited.id })).rejects.toMatchObject({
      code: RpcErrorCode.NotFound
    })
  })

  test('account prep receives plan provenance and explicit home wins in the runner environment', async () => {
    const worldWithCustomHome = new FakeWorld()
    worldWithCustomHome.agentPlanEnv = { CLAUDE_CONFIG_DIR: '/custom/claude' }
    worldWithCustomHome.accountPreparationResult = {
      env: { CLAUDE_CONFIG_DIR: '/managed/claude' },
      shellInit: null,
      account: null
    }
    await boot({ world: worldWithCustomHome, accountPreparation: true })

    const session = await create()
    await waitFor(() => runner.started.length === 1)

    expect(world.planCalls).toHaveLength(1)
    expect(world.accountPrepareCalls[0]).toMatchObject({
      agent: 'claude',
      sessionId: session.id,
      worktreeId: 'wt_1',
      cwd: '/fake/alpha',
      homeOverrides: { claude: { value: '/custom/claude', source: 'explicit' } }
    })
    const options = runner.started[0]?.options as StructuredLaunchOptions | undefined
    expect(options?.env?.CLAUDE_CONFIG_DIR).toBe('/custom/claude')
  })

  test('a selected account prep failure removes the session before the runner starts', async () => {
    const worldWithUnavailableHome = new FakeWorld()
    worldWithUnavailableHome.accountPreparationFailure = 'selected Claude home is unavailable'
    await boot({ world: worldWithUnavailableHome, accountPreparation: true })

    const error = await failure(create())

    expect(error.message).toContain('selected Claude home is unavailable')
    expect(world.sessions.size).toBe(0)
    expect(world.accountPrepareCalls).toHaveLength(1)
    expect(runner.started).toEqual([])
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

  test('replays an operation-id structured send once and rejects a changed payload', async () => {
    const session = await create('go')
    await waitFor(() => runner.started.length === 1)
    const params = { session: session.id, text: 'more', operationId: 'structured-op-1' }

    await call('quirky.structured/send', params)
    await call('quirky.structured/send', params)

    expect(runner.sent).toEqual([{ sessionId: session.id, text: 'more' }])
    await expect(call('quirky.structured/send', { ...params, text: 'different' })).rejects.toMatchObject({
      code: RpcErrorCode.Conflict
    })
  })

  test('done settles once and closing the session stops the runner and drops its journal', async () => {
    const session = await create('go')
    await waitFor(() => runner.started.length === 1)
    runner.context.appendMessage({ sessionId: session.id, role: 'assistant', text: 'first take' })
    runner.context.appendMessage({ sessionId: session.id, role: 'assistant', text: 'All done' })
    runner.context.appendMessage({ sessionId: session.id, role: 'result', text: 'ok' })
    runner.context.setStatus(session.id, 'done')
    runner.context.setStatus(session.id, 'done')
    await waitFor(() => settledEvents().length === 1)
    expect(settledEvents()[0]).toEqual({
      sessionId: session.id,
      worktreeId: 'wt_1',
      agent: 'claude',
      state: 'done',
      lastAssistantMessage: 'All done',
      at: expect.any(Number)
    })
    await Bun.sleep(50)
    expect(settledEvents()).toHaveLength(1)
    expect(events.filter((e) => e.type === 'notify')).toEqual([])
    expect(h.notifications).toEqual([])

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

  test('a runner needing input settles as waiting, with no message when it has said nothing', async () => {
    const session = await create('go')
    await waitFor(() => runner.started.length === 1)
    runner.context.setStatus(session.id, 'waiting')
    await waitFor(() => settledEvents().length === 1)
    expect(settledEvents()[0]).toMatchObject({ sessionId: session.id, state: 'waiting', agent: 'claude', lastAssistantMessage: null })
    expect(events.filter((e) => e.type === 'notify')).toEqual([])
  })

  test('other statuses settle nothing, and each session keeps its own last message', async () => {
    const first = await create('go')
    const second = await create('go')
    await waitFor(() => runner.started.length === 2)
    runner.context.appendMessage({ sessionId: first.id, role: 'assistant', text: 'one' })
    runner.context.appendMessage({ sessionId: second.id, role: 'assistant', text: 'two' })
    runner.context.setStatus(first.id, 'working')
    runner.context.setStatus(first.id, 'done')
    runner.context.setStatus(second.id, 'done')
    await waitFor(() => settledEvents().length === 2)
    expect(settledEvents().map((e) => [e.sessionId, e.lastAssistantMessage])).toEqual([
      [first.id, 'one'],
      [second.id, 'two']
    ])
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



  test('SC-24: extra arguments are refused and nothing is registered', async () => {
    expect(
      await failure(call('quirky.structured/create', { worktree: 'main', agent: 'claude', prompt: 'x', extraArgs: '--verbose' }))
    ).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: "Extra arguments can't be applied to a structured session."
    })
    expect(world.registerCalls).toEqual([])
    expect(world.resolveLaunchCalls).toEqual([])
  })

  test('SC-24: a refused pick propagates and nothing is registered', async () => {
    world.resolveLaunchOverride = (_params, context) => {
      throw context.error('invalid-params', 'Agent claude does not support launch-time model selection.')
    }
    expect(
      await failure(call('quirky.structured/create', { worktree: 'main', agent: 'claude', prompt: 'x', model: 'opus' }))
    ).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'Agent claude does not support launch-time model selection.'
    })
    expect(world.registerCalls).toEqual([])
    expect(runner.started).toEqual([])
  })

  test('validates agent, worktree and session kind', async () => {
    expect(await failure(call('quirky.structured/create', { worktree: 'main', agent: 'pi', prompt: 'x' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
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

  test('structured resume refuses unsupported forks and provider identity overrides', async () => {
    const session = await create('go')
    await waitFor(() => runner.started.length === 1)
    expect(await failure(call('quirky.structured/resume', { session: session.id, fork: true }))).toMatchObject({
      code: RpcErrorCode.InvalidParams
    })
    expect(await failure(call('quirky.structured/resume', { session: session.id, providerSession: 'override' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams
    })
    expect(world.registerCalls).toHaveLength(1)
    expect(h.pty.requests.some((request) => request.type === 'create')).toBe(false)
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
    await waitForAsync(async () => {
      const stored = (await call('quirky.session/get', { session: session.id })) as Session
      return stored.providerSession?.id === 'c1' ? stored : undefined
    })
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
    await waitForAsync(() =>
      settledEvents().find((event) => event.sessionId === session.id && event.state === 'done')
    )
    expect(settledEvents().filter((event) => event.sessionId === session.id).map((event) => event.state)).toEqual([
      'waiting',
      'done'
    ])

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

  test('persists Claude identity after native init and resumes that session idle', async () => {
    const home = shortHome()
    const queries: FakeQuery[] = []
    await boot({
      home,
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

    world.worktree.path = home

    const original = (await call('quirky.structured/create', {
      worktree: 'main',
      agent: 'claude',
      deferStart: true
    })) as Session
    await waitFor(
      () =>
        queries.length === 1 &&
        world.statusLog.some((entry) => entry.sessionId === original.id && entry.status === 'running')
    )
    const idleRecord = (await call('quirky.session/get', { session: original.id })) as Session
    if (idleRecord.providerSession !== null && idleRecord.providerSession !== undefined) {
      throw new Error('Claude provider identity was recorded before native initialization')
    }

    const initialQuery = queries[0]
    expect(initialQuery.written).toEqual([])
    await call('quirky.structured/send', { session: original.id, text: 'first turn' })
    await waitFor(() => initialQuery.written.length === 1)
    const nativeSessionId = 'sdk-confirmed-idle-session'
    initialQuery.emit({ type: 'system', subtype: 'init', session_id: nativeSessionId, model: 'm' })
    const originalRecord = await waitForAsync(async () => {
      const stored = (await call('quirky.session/get', { session: original.id })) as Session
      return stored.providerSession?.id === nativeSessionId ? stored : undefined
    })
    expect(originalRecord.providerSession).toEqual({ id: nativeSessionId, transcriptPath: null })
    initialQuery.emit({ type: 'result', subtype: 'success', result: 'first complete', is_error: false })
    await waitFor(() => world.statusLog.some((entry) => entry.sessionId === original.id && entry.status === 'done'))
    await call('quirky.structured/stop', { session: original.id })

    const resumed = (await call('quirky.structured/resume', { session: original.id })) as Session
    await waitFor(
      () =>
        queries.length === 2 &&
        world.statusLog.some((entry) => entry.sessionId === resumed.id && entry.status === 'running')
    )
    const resumedRecord = (await call('quirky.session/get', { session: resumed.id })) as Session
    expect(resumedRecord.providerSession).toEqual({ id: nativeSessionId, transcriptPath: null })
    expect(resumedRecord.resumedFrom).toBe(original.id)

    const resumedQuery = queries[1]
    expect(resumedQuery.written).toEqual([])
    await call('quirky.structured/send', { session: resumed.id, text: 'resumed turn' })
    await waitFor(() => resumedQuery.written.length === 1)
    expect(resumedQuery.written[0]).toMatchObject({
      session_id: nativeSessionId,
      message: { role: 'user', content: 'resumed turn' }
    })
    resumedQuery.emit({ type: 'result', subtype: 'success', result: 'resumed complete', is_error: false })
    await waitFor(() => world.statusLog.some((entry) => entry.sessionId === resumed.id && entry.status === 'done'))
    await call('quirky.structured/stop', { session: resumed.id })
  })

})

describe('the Codex runner inside the plugin', () => {
  test('runs app-server through the daemon API, persists native state, asks approval and continues an idle thread', async () => {
    const home = shortHome()
    const fixture = createCodexAppServerFixture(home)
    await boot({
      home,
      factory: (context) =>
        createCodexRunner(
          { ...context, resolveCodexPath: async () => fixture.executable },
          { env: isolatedProviderEnvironment(home) }
        )
    })
    world.worktree.path = home
    const snapshot = {
      agent: 'codex',
      options: { model: { value: 'gpt-5.5', source: 'explicit' }, effort: { value: 'high', source: 'explicit' } },
      summary: 'Codex · GPT-5.5 · Effort: high'
    }
    world.resolveLaunchOverride = () => ({
      added: [],
      args: '',
      structured: { model: 'gpt-5.5', effort: 'high' },
      shadowed: [],
      launchSettings: snapshot
    })

    const session = await createAgent('codex', '[approve] summarize', { model: 'gpt-5.5', options: { effort: 'high' } })
    expect(session).toMatchObject({ kind: 'structured', agent: 'codex', cwd: home })
    expect(h.pty.requests.some((request) => request.type === 'create')).toBe(false)
    const ask = await waitForAsync(async () => ((await call('quirky.ask/list', { pendingOnly: true })) as { id: string }[])[0])
    await call('quirky.ask/answer', { askId: ask.id, answers: { decision: { value: 'allow', source: 'option' } } })
    const settled = await waitFor(() =>
      settledEvents().find((event) => event.sessionId === session.id && event.state === 'done')
    )
    expect(settled).toMatchObject({
      agent: 'codex',
      state: 'done',
      lastAssistantMessage: 'Codex: [approve] summarize'
    })

    const stored = (await call('quirky.session/get', { session: session.id })) as Session
    expect(stored).toMatchObject({
      providerSession: { id: 'scripted-thread', transcriptPath: null },
      launchSettings: snapshot
    })
    expect(fixture.requests().find((request) => request.method === 'turn/start')?.params).toEqual({
      threadId: 'scripted-thread',
      input: [{ type: 'text', text: '[approve] summarize' }],
      model: 'gpt-5.5',
      effort: 'high'
    })
    expect(fixture.requests().find((request) => request.id === 'approval-1')).toEqual({
      id: 'approval-1',
      result: { decision: 'accept' }
    })

    await call('quirky.structured/send', { session: session.id, text: 'continue' })
    await waitForAsync(async () => {
      const messages = (await call('quirky.structured/messages', { session: session.id })) as StructuredMessage[]
      return messages.some((message) => message.role === 'assistant' && message.text === 'Codex: continue')
    })
    const journal = (await call('quirky.structured/messages', { session: session.id })) as StructuredMessage[]
    expect(journal.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual([
      'Codex: [approve] summarize',
      'Codex: continue'
    ])
    expect(journal.some((message) => message.role === 'tool' && message.text.includes('printf approved') && message.text.includes('approved'))).toBe(true)

    await call('quirky.structured/stop', { session: session.id })
    expect((await call('quirky.session/get', { session: session.id })).status).toBe('exited')
    expect(await call('quirky.structured/messages', { session: session.id })).toHaveLength(journal.length)
  })

  test('keeps a deferred Codex thread idle until a lease-bound send', async () => {
    const home = shortHome()
    const fixture = createCodexAppServerFixture(home)
    await boot({
      home,
      factory: (context) =>
        createCodexRunner(
          { ...context, resolveCodexPath: async () => fixture.executable },
          { env: isolatedProviderEnvironment(home) }
        )
    })
    world.worktree.path = home

    const session = (await call('quirky.structured/create', {
      worktree: 'main',
      agent: 'codex',
      title: 'Idle worker',
      deferStart: true
    })) as Session
    await waitFor(() => world.statusLog.some((entry) => entry.sessionId === session.id && entry.status === 'running'))

    const identityResult = await call('quirky.session/identity', { session: session.id })
    if (!identityResult || typeof identityResult !== 'object' || Array.isArray(identityResult)) {
      throw new Error('structured session did not return a runtime identity')
    }
    const identity = identityResult as Record<string, unknown>
    const processIncarnation = identity.processIncarnation
    const runtimeEpoch = identity.runtimeEpoch
    if (
      identity.sessionId !== session.id ||
      identity.live !== true ||
      typeof processIncarnation !== 'string' ||
      processIncarnation.length === 0 ||
      typeof runtimeEpoch !== 'string' ||
      runtimeEpoch.length === 0
    ) {
      throw new Error('structured session did not return a live lease identity')
    }
    expect(fixture.requests().filter((request) => request.method).map((request) => request.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start'
    ])
    expect(await call('quirky.structured/messages', { session: session.id })).toEqual([])

    expect(
      await call('quirky.structured/send', {
        session: session.id,
        text: 'stale delivery',
        expectedIncarnation: `${processIncarnation}-stale`
      })
    ).toEqual({ ok: false, reason: 'recipient_changed' })
    expect(fixture.requests().filter((request) => request.method === 'turn/start')).toHaveLength(0)

    expect(
      await call('quirky.structured/send', {
        session: session.id,
        text: 'first lease-bound turn',
        expectedIncarnation: processIncarnation
      })
    ).toEqual({ ok: true })
    await waitFor(() => world.statusLog.some((entry) => entry.sessionId === session.id && entry.status === 'done'))
    expect(fixture.requests().filter((request) => request.method === 'turn/start')).toHaveLength(1)
    expect(
      ((await call('quirky.structured/messages', { session: session.id })) as StructuredMessage[])
        .filter((message) => message.role === 'user')
        .map((message) => message.text)
    ).toEqual(['first lease-bound turn'])

    expect(
      await call('quirky.structured/stop', {
        session: session.id,
        expectedIncarnation: processIncarnation
      })
    ).toEqual({
      ok: true,
      closed: true,
      sessionId: session.id,
      processIncarnation
    })

    await expect(call('quirky.session/identity', { session: session.id })).rejects.toMatchObject({
      code: RpcErrorCode.NotFound
    })
  })


  test('reports malformed JSON and rejected turn-start RPCs as exited, never done', async () => {
    const home = shortHome()
    const fixture = createCodexAppServerFixture(home)
    await boot({
      home,
      factory: (context) =>
        createCodexRunner(
          { ...context, resolveCodexPath: async () => fixture.executable },
          { env: isolatedProviderEnvironment(home) }
        )
    })
    world.worktree.path = home
    for (const [prompt, diagnostic] of [
      ['[malformed]', 'malformed JSON'],
      ['[rpc-error]', 'scripted turn request error']
    ]) {
      const session = await createAgent('codex', prompt)
      await waitForAsync(async () => {
        const stored = (await call('quirky.session/get', { session: session.id })) as Session
        return stored.status === 'exited' ? stored : undefined
      })
      const messages = (await call('quirky.structured/messages', { session: session.id })) as StructuredMessage[]
      expect(messages.some((message) => message.role === 'system' && message.text.includes(diagnostic)), JSON.stringify(messages)).toBe(true)
      expect(settledEvents().some((event) => event.sessionId === session.id && event.state === 'done')).toBe(false)
    }
    expect(h.pty.requests.some((request) => request.type === 'create')).toBe(false)
  })

  test('sends the selected Codex home to the native app-server on create and resume', async () => {
    const home = makeTempDir('qs-codex-account-')
    const managedHome = join(home, 'managed-codex')
    const resumeTranscriptPath = join(managedHome, 'sessions', '2026', '10', '27', 'rollout-scripted-thread.jsonl')
    const fixture = createCodexAppServerFixture(home)
    const worldWithManagedCodex = new FakeWorld()
    worldWithManagedCodex.worktree.path = home
    worldWithManagedCodex.accountPreparationResult = {
      env: { CODEX_HOME: managedHome },
      shellInit: null,
      account: {
        provider: 'codex',
        id: '00000000-0000-4000-8000-000000000001',
        label: 'Managed Codex',
        source: 'managed'
      },
      resumeTranscriptPath
    }
    await boot({
      home,
      world: worldWithManagedCodex,
      accountPreparation: true,
      factory: (context) =>
        createCodexRunner(
          { ...context, resolveCodexPath: async () => fixture.executable },
          { env: isolatedProviderEnvironment(home) }
        )
    })

    const original = await createAgent('codex', 'continue this conversation')
    await waitForAsync(() =>
      settledEvents().find((event) => event.sessionId === original.id && event.state === 'done')
    )
    expect(fixture.environments()).toEqual([{ CODEX_HOME: managedHome }])
    expect((await call('quirky.session/get', { session: original.id })).providerSession).toMatchObject({
      id: 'scripted-thread',
      transcriptPath: null
    })
    await call('quirky.structured/stop', { session: original.id })

    const resumed = (await call('quirky.structured/resume', { session: original.id })) as Session
    const resumedRecord = await waitForAsync(async () => {
      const stored = (await call('quirky.session/get', { session: resumed.id })) as Session
      return fixture.environments().length === 2 && stored.providerSession?.transcriptPath === resumeTranscriptPath
        ? stored
        : undefined
    })

    expect(resumedRecord).toMatchObject({
      agent: 'codex',
      resumedFrom: original.id,
      providerSession: { id: 'scripted-thread', transcriptPath: resumeTranscriptPath }
    })
    expect(worldWithManagedCodex.accountPrepareCalls[1]).toMatchObject({
      agent: 'codex',
      sessionId: resumed.id,
      resume: {
        sourceSessionId: original.id,
        providerSession: { id: 'scripted-thread', transcriptPath: null }
      }
    })
    expect(fixture.requests().find((request) => request.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'scripted-thread',
      cwd: home
    })
    expect(fixture.environments()).toEqual([{ CODEX_HOME: managedHome }, { CODEX_HOME: managedHome }])
    await call('quirky.structured/stop', { session: resumed.id })
  })

  test('does not spawn Codex app-server when account preparation fails', async () => {
    const home = makeTempDir('qs-codex-account-failure-')
    const fixture = createCodexAppServerFixture(home)
    const worldWithUnavailableHome = new FakeWorld()
    worldWithUnavailableHome.worktree.path = home
    worldWithUnavailableHome.accountPreparationFailure = 'selected Codex home is unavailable'
    await boot({
      home,
      world: worldWithUnavailableHome,
      accountPreparation: true,
      factory: (context) =>
        createCodexRunner(
          { ...context, resolveCodexPath: async () => fixture.executable },
          { env: isolatedProviderEnvironment(home) }
        )
    })

    const error = await failure(createAgent('codex', 'must not start'))

    expect(error.message).toContain('selected Codex home is unavailable')
    expect(worldWithUnavailableHome.sessions.size).toBe(0)
    expect(fixture.environments()).toEqual([])
    expect(fixture.requests()).toEqual([])
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

describe('structured journal store upgrades', () => {
  test('preserves an existing v1 journal while appending the receipt migration', async () => {
    const home = shortHome()
    const storePath = join(home, 'plugin-data', 'quirky.structured', 'store.db')
    mkdirSync(dirname(storePath), { recursive: true })
    const existing = new Database(storePath)
    existing.exec(`CREATE TABLE structured_messages (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      data TEXT, at INTEGER NOT NULL, PRIMARY KEY (session_id, seq))`)
    existing
      .query('INSERT INTO structured_messages VALUES (?, ?, ?, ?, ?, ?)')
      .run('s_existing', 1, 'assistant', 'saved before upgrade', JSON.stringify({ origin: 'v1' }), 42)
    existing.exec('PRAGMA user_version = 1')
    existing.close()

    const existingSession = new FakeWorld()
    existingSession.addStructuredSession('s_existing')
    await boot({ home, world: existingSession })

    expect(await call('quirky.structured/messages', { session: 's_existing' })).toEqual([
      {
        sessionId: 's_existing',
        seq: 1,
        role: 'assistant',
        text: 'saved before upgrade',
        data: { origin: 'v1' },
        at: 42
      }
    ])

    const upgraded = new Database(storePath, { readonly: true })
    try {
      expect(upgraded.query('PRAGMA user_version').get()).toEqual({ user_version: 2 })
      expect(
        upgraded
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'structured_send_receipts'")
          .all()
      ).toEqual([{ name: 'structured_send_receipts' }])
    } finally {
      upgraded.close()
    }
  })
})
