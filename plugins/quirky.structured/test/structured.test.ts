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
  started: { session: Session; prompt: string; options?: unknown }[] = []
  sent: { sessionId: string; text: string }[] = []
  stopped: string[] = []
  startError: Error | null = null
  sendError: Error | null = null
  constructor(readonly context: StructuredContext) {}
  async start(session: Session, prompt: string, options?: StructuredLaunchOptions) {
    if (this.startError) throw this.startError
    this.started.push({ session, prompt, options })
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

const createAgent = (agent: string, prompt = 'fix the bug', extra: Record<string, unknown> = {}) =>
  call('quirky.structured/create', { worktree: 'main', agent, prompt, ...extra }) as Promise<Session>

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
    expect(options?.env).toEqual({ CLAUDE_CONFIG_DIR: '/custom/claude' })
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

  test('SC-23: a model and effort pick is resolved, recorded on the session and given to the runner', async () => {
    const snapshot = {
      agent: 'claude',
      options: { model: { value: 'opus', source: 'explicit' }, effort: { value: 'high', source: 'explicit' } },
      summary: 'Claude · Opus · Effort: high'
    }
    world.resolveLaunchOverride = () => ({
      added: [],
      args: '',
      structured: { model: 'opus', effort: 'high' },
      shadowed: [],
      launchSettings: snapshot
    })
    await call('quirky.structured/create', {
      worktree: 'main',
      agent: 'claude',
      prompt: 'hi',
      model: 'opus',
      options: { effort: 'high' }
    })
    expect(world.resolveLaunchCalls).toEqual([
      { agent: 'claude', model: 'opus', options: { effort: 'high' }, structured: true }
    ])
    expect(world.registerCalls[0].launchSettings).toEqual(snapshot)
    await waitFor(() => runner.started.length === 1)
    expect(runner.started[0].options).toEqual({ model: 'opus', effort: 'high' })
  })

  test('SC-23: with no pick nothing is resolved and the runner gets no options', async () => {
    await create()
    await waitFor(() => runner.started.length === 1)
    expect(world.resolveLaunchCalls).toEqual([])
    expect(world.registerCalls[0]).not.toHaveProperty('launchSettings')
    expect(runner.started[0].options).toEqual({})
  })

  test('SC-23: a pick that resolves to no snapshot registers without launchSettings', async () => {
    await call('quirky.structured/create', { worktree: 'main', agent: 'claude', prompt: 'hi', model: 'opus' })
    expect(world.registerCalls[0]).not.toHaveProperty('launchSettings')
    await waitFor(() => runner.started.length === 1)
    expect(runner.started[0].options).toEqual({ model: 'opus' })
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
    await waitFor(() => settledEvents().some((event) => event.sessionId === session.id && event.state === 'done'))
    expect(settledEvents().find((event) => event.sessionId === session.id && event.state === 'done')).toMatchObject({
      agent: 'codex',
      state: 'done',
      lastAssistantMessage: 'Codex: [approve] summarize'
    })

    const stored = (await call('quirky.session/get', { session: session.id })) as Session
    expect(stored).toMatchObject({
      providerSession: { id: 'scripted-thread', transcriptPath: null },
      launchSettings: snapshot
    })
    expect(fixture.requests().filter((request) => request.method).map((request) => request.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start'
    ])
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
      await waitFor(() => world.statusLog.some((entry) => entry.sessionId === session.id && entry.status === 'exited'))
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
    await waitFor(() =>
      worldWithManagedCodex.statusLog.some((entry) => entry.sessionId === original.id && entry.status === 'done')
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
