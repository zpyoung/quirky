import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RpcErrorCode,
  type AskEnvelope,
  type AskSpec,
  type PluginStore,
  type QuirkyClient,
  type RpcError,
  type Session,
  type SessionStatus,
  type StructuredMessage
} from '@quirky/protocol'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { createClaudeRunner, type ClaudeQueryParams } from '../claude-runner'
import { createCodexRunner } from '../codex-runner'
import { Journal, journalMigrations } from '../journal'
import type { NewStructuredMessage, StructuredContext, StructuredRunner, StructuredRunnerFactory, StructuredStartOptions } from '../runner'
import { createCodexAppServerFixture, isolatedProviderEnvironment, type CodexAppServerFixture } from './fakes/codex-app-server'
import { FakeQuery } from './fakes/fake-query'
import { FakeWorld } from './fakes/world'

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

type Recorder = {
  messages: StructuredMessage[]
  statuses: SessionStatus[]
  asks: AskSpec[]
  context: StructuredContext
}

function recorder(): Recorder {
  const messages: StructuredMessage[] = []
  const statuses: SessionStatus[] = []
  const asks: AskSpec[] = []
  const context: StructuredContext = {
    appendMessage(msg: NewStructuredMessage) {
      const stored = { ...msg, seq: messages.length + 1, at: msg.at ?? Date.now() } as StructuredMessage
      messages.push(stored)
      return stored
    },
    setStatus(_id, status) {
      statuses.push(status)
    },
    createAsk(spec) {
      asks.push(spec)
      return new Promise<AskEnvelope>(() => {})
    },
    async setProviderSession() {},
    resolveClaudePath: async () => '/usr/local/bin/claude',
    resolveCodexPath: async () => '/not-used/codex'
  }
  return { messages, statuses, asks, context }
}

function sessionFor(agent: 'claude' | 'codex', cwd: string): Session {
  return {
    id: `s_${agent}`,
    kind: 'structured',
    agent,
    worktreeId: 'wt_1',
    cwd,
    title: agent,
    status: 'starting',
    createdAt: 1,
    lastActivityAt: 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false
  }
}

describe('Claude runner', () => {
  let rec: Recorder
  let queries: FakeQuery[]
  let runner: StructuredRunner
  const session = sessionFor('claude', '/work/tree')

  beforeEach(() => {
    rec = recorder()
    queries = []
    runner = createClaudeRunner(rec.context, {
      query: (params: ClaudeQueryParams) => {
        const query = new FakeQuery(params)
        queries.push(query)
        return query
      }
    })
  })

  test('deny-all denies every tool without an ask and passes no tools or MCP servers', async () => {
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    const options = queries[0].params.options!
    expect(options.tools).toEqual([])
    expect(options.mcpServers).toEqual({})
    expect(options.strictMcpConfig).toBe(true)
    const canUseTool = options.canUseTool!
    const signal = new AbortController().signal
    for (const tool of ['Bash', 'Edit', 'mcp__server__tool', 'AskUserQuestion']) {
      expect(await canUseTool(tool, { command: 'ls' }, { signal, toolUseID: 't1' } as any)).toEqual({
        behavior: 'deny',
        message: 'tools are disabled for this session'
      })
    }
    expect(rec.asks).toEqual([])
    expect(rec.statuses).not.toContain('waiting')
  })

  test('an unset policy keeps the approval flow and the default options', async () => {
    await runner.start(session, 'hello')
    const options = queries[0].params.options!
    expect(options).not.toHaveProperty('tools')
    expect(options).not.toHaveProperty('mcpServers')
    expect(options).not.toHaveProperty('strictMcpConfig')
    const pending = options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 't1' } as any)
    await until(() => rec.asks.length === 1)
    expect(rec.statuses).toContain('waiting')
    void pending
  })

  test('the result message records context usage from the SDK usage', async () => {
    await runner.start(session, 'hello')
    const result = {
      type: 'result',
      subtype: 'success',
      result: 'ok',
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
      modelUsage: { 'claude-opus': { contextWindow: 200000 } }
    }
    queries[0].emit(result)
    await until(() => rec.messages.some((m) => m.role === 'result'))
    expect(rec.messages.find((m) => m.role === 'result')?.data).toMatchObject({
      usage: { contextTokens: 180, contextWindow: 200000 },
      sdkUsage: result.usage,
      subtype: 'success'
    })
  })

  test('context window is null when the SDK names none, and a result without usage is unchanged', async () => {
    await runner.start(session, 'hello')
    queries[0].emit({ type: 'result', subtype: 'success', result: 'ok', is_error: false, usage: { input_tokens: 7, output_tokens: 3 } })
    await until(() => rec.messages.some((m) => m.role === 'result'))
    expect((rec.messages.find((m) => m.role === 'result')?.data as any).usage).toEqual({ contextTokens: 10, contextWindow: null })

    const bare = { type: 'result', subtype: 'success', result: 'again', is_error: false }
    queries[0].emit(bare)
    await until(() => rec.messages.filter((m) => m.role === 'result').length === 2)
    expect(rec.messages.filter((m) => m.role === 'result')[1].data).toEqual(bare)
  })
})

describe('Codex runner', () => {
  let home: string
  let fixture: CodexAppServerFixture
  let rec: Recorder
  let runner: StructuredRunner
  let session: Session

  const patchFixture = (edit: (script: string) => string) =>
    writeFileSync(fixture.executable, edit(readFileSync(fixture.executable, 'utf8')))

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'tool-policy-codex-')))
    fixture = createCodexAppServerFixture(home)
    rec = recorder()
    session = sessionFor('codex', home)
    runner = createCodexRunner({ ...rec.context, resolveCodexPath: async () => fixture.executable }, { env: isolatedProviderEnvironment(home) })
  })

  afterEach(async () => {
    await runner.stop(session.id)
    rmSync(home, { recursive: true, force: true })
  })

  test('deny-all declines every command and patch approval without an ask', async () => {
    // the shared fixture pins the default approval enums; deny-all uses stricter ones
    patchFixture((script) =>
      script.replace("message.params.approvalPolicy !== 'on-request' || message.params.sandbox !== 'workspace-write'", 'false')
    )
    await runner.start(session, '[approve twice]', { toolPolicy: 'deny-all' })
    await until(() => rec.statuses.includes('done'))
    const threadStart = fixture.requests().find((request) => request.method === 'thread/start')
    expect(threadStart?.params).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'read-only' })
    const replies = fixture.requests().filter((request) => request.method === undefined && request.result !== undefined)
    expect(replies.map((reply) => reply.result)).toEqual([{ decision: 'decline' }, { decision: 'decline' }])
    expect(rec.asks).toEqual([])
    expect(rec.statuses).not.toContain('waiting')
  })

  test('an unset policy keeps the on-request workspace-write flow and asks', async () => {
    await runner.start(session, '[approve]')
    await until(() => rec.asks.length === 1)
    const threadStart = fixture.requests().find((request) => request.method === 'thread/start')
    expect(threadStart?.params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  })

  test('the result message records context usage from token usage events', async () => {
    const marker = "  notify('turn/started', { threadId, turn })"
    patchFixture((script) =>
      script.replace(
        marker,
        `${marker}
  notify('thread/tokenUsage/updated', {
    threadId,
    tokenUsage: { total: { inputTokens: 900, outputTokens: 100 }, last: { inputTokens: 300, outputTokens: 40 }, modelContextWindow: 400000 }
  })`
      )
    )
    await runner.start(session, 'hello')
    await until(() => rec.messages.some((m) => m.role === 'result'))
    expect((rec.messages.find((m) => m.role === 'result')?.data as any).usage).toEqual({ contextTokens: 340, contextWindow: 400000 })
  })

  test('a turn with no token usage event leaves the result unchanged', async () => {
    await runner.start(session, 'hello')
    await until(() => rec.messages.some((m) => m.role === 'result'))
    expect(rec.messages.find((m) => m.role === 'result')?.data).not.toHaveProperty('usage')
  })
})

describe('journal', () => {
  let home: string
  let store: PluginStore
  let close: () => void

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tool-policy-journal-'))
    const opened = openPluginStore({ home, pluginId: 'quirky.structured', migrations: journalMigrations(home), isActive: () => true })
    store = opened.store
    close = opened.close
  })

  afterEach(() => {
    close()
    rmSync(home, { recursive: true, force: true })
  })

  test('a recorded policy survives a reopen, defaults otherwise and is dropped with the session', () => {
    const journal = new Journal(store)
    expect(journal.toolPolicy('s_1')).toBe('default')
    journal.setToolPolicy('s_1', 'deny-all')
    expect(new Journal(store).toolPolicy('s_1')).toBe('deny-all')
    expect(journal.toolPolicy('s_2')).toBe('default')
    journal.remove('s_1')
    expect(journal.toolPolicy('s_1')).toBe('default')
  })

  test('recording a policy does not change the store schema version', () => {
    const before = store.version
    new Journal(store).setToolPolicy('s_1', 'deny-all')
    expect(store.version).toBe(before)
  })
})

describe('create', () => {
  const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
  const FAKES_DIR = join(PLUGIN_DIR, 'test', 'fakes')
  const globals = globalThis as any

  class RecordingRunner implements StructuredRunner {
    started: { session: Session; prompt: string | undefined; options?: StructuredStartOptions }[] = []
    constructor(readonly context: StructuredContext) {}
    async start(session: Session, prompt?: string, options?: StructuredStartOptions) {
      this.started.push({ session, prompt, options })
      this.context.setStatus(session.id, 'working')
    }
    async send() {}
    async stop() {}
  }

  let h: Harness
  let client: QuirkyClient
  let world: FakeWorld
  let runner: RecordingRunner

  beforeEach(async () => {
    world = new FakeWorld()
    globals.__structuredFakes = world
    const factory: StructuredRunnerFactory = (context) => (runner = new RecordingRunner(context))
    globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = factory
    const dir = makeTempDir('qs-policy-')
    symlinkSync(PLUGIN_DIR, join(dir, 'quirky.structured'))
    for (const id of ['quirky.session', 'quirky.worktree', 'quirky.ask', 'quirky.agents']) symlinkSync(join(FAKES_DIR, id), join(dir, id))
    const shortHome = mkdtempSync('/tmp/qs-')
    mkdirSync(shortHome, { recursive: true })
    h = await startHarness({ home: shortHome, builtinPluginsDir: dir })
    client = await h.connect('cli')
  })

  afterEach(async () => {
    await h?.cleanup()
    removeTempDirs()
    delete globals.__structuredFakes
    delete globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
  })

  const create = (params: Record<string, unknown>) =>
    client.callAny('quirky.structured/create', { worktree: 'main', prompt: 'go', ...params }) as Promise<Session>

  test('deny-all reaches the runner and is not forwarded to the agent catalog', async () => {
    const session = await create({ agent: 'pi', options: { toolPolicy: 'deny-all' } })
    expect(session).toMatchObject({ kind: 'structured', agent: 'pi' })
    await until(() => runner.started.length === 1)
    expect(runner.started[0].options).toMatchObject({ toolPolicy: 'deny-all' })
    expect(world.resolveLaunchCalls).toEqual([])
  })

  test('other option picks still resolve, without the policy', async () => {
    await create({ agent: 'omp', options: { effort: 'high', toolPolicy: 'deny-all' } })
    await until(() => runner.started.length === 1)
    expect(world.resolveLaunchCalls).toEqual([{ agent: 'omp', model: undefined, options: { effort: 'high' }, structured: true }])
    expect(runner.started[0].options).toMatchObject({ effort: 'high', toolPolicy: 'deny-all' })
    expect(runner.started[0].session.agent).toBe('omp')
  })

  test('default and unset policies leave the runner options without a toolPolicy', async () => {
    await create({ agent: 'claude', options: { toolPolicy: 'default' } })
    await create({ agent: 'codex' })
    await until(() => runner.started.length === 2)
    for (const started of runner.started) expect(started.options).not.toHaveProperty('toolPolicy')
  })

  test('an unknown policy is refused before anything is registered', async () => {
    const error = await create({ agent: 'claude', options: { toolPolicy: 'allow-all' } }).catch((e: RpcError) => e)
    expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(world.registerCalls).toEqual([])
  })

  test('an agent other than claude, codex, pi or omp is refused', async () => {
    const error = await create({ agent: 'gemini' }).catch((e: RpcError) => e)
    expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams })
  })
})
