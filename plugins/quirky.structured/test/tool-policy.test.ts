import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RpcErrorCode,
  type AskEnvelope,
  type AskSpec,
  type QuirkyClient,
  type RpcError,
  type Session,
  type SessionStatus,
  type StructuredMessage
} from '@quirky/protocol'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { createClaudeRunner, type ClaudeQueryParams } from '../claude-runner'
import { createCodexRunner } from '../codex-runner'
import type { NewStructuredMessage, StructuredContext, StructuredRunner, StructuredRunnerFactory, StructuredStartOptions } from '../runner'
import {
  createCodexAppServerFixture,
  isolatedProviderEnvironment,
  type CodexAppServerFixture
} from './fakes/codex-app-server'
import { FakeQuery } from './fakes/fake-query'
import { FakeWorld } from './fakes/world'

const DENY = 'tools are disabled for this session'

// The JSONL peer is a child process, so these waits need the real OS event loop.
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

async function withFastTimers<T>(work: () => Promise<T>): Promise<T> {
  const original = globalThis.setTimeout
  const accelerated = (...args: Parameters<typeof globalThis.setTimeout>) => {
    const [callback, delay, ...extra] = args
    return original(callback, Math.min(Number(delay ?? 0), 500), ...extra)
  }
  globalThis.setTimeout = accelerated as typeof globalThis.setTimeout
  try {
    return await work()
  } finally {
    globalThis.setTimeout = original
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function expectFixtureStopped(fixture: CodexAppServerFixture) {
  const pid = fixture.processId()
  expect(pid).toEqual(expect.any(Number))
  await until(() => !processIsAlive(pid!))
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

  afterEach(async () => {
    await runner.stop(session.id)
  })

  test('deny-all denies every tool without an ask and passes no tools or MCP servers', async () => {
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    const options = queries[0].params.options!
    expect(options.tools).toEqual([])
    expect(options.mcpServers).toEqual({})
    expect(options.strictMcpConfig).toBe(true)
    const canUseTool = options.canUseTool!
    const signal = new AbortController().signal
    const context: Parameters<typeof canUseTool>[2] = { signal, toolUseID: 't1', requestId: 't1' }
    for (const tool of ['Bash', 'Edit', 'mcp__server__tool', 'AskUserQuestion']) {
      expect(await canUseTool(tool, { command: 'ls' }, context)).toEqual({
        behavior: 'deny',
        message: DENY
      })
    }
    expect(rec.asks).toEqual([])
    expect(rec.statuses).not.toContain('waiting')
  })

  test('an unset policy keeps the approval flow and default options', async () => {
    await runner.start(session, 'hello')
    const options = queries[0].params.options!
    expect(options).not.toHaveProperty('tools')
    expect(options).not.toHaveProperty('mcpServers')
    expect(options).not.toHaveProperty('strictMcpConfig')
    const canUseTool = options.canUseTool!
    const context: Parameters<typeof canUseTool>[2] = {
      signal: new AbortController().signal,
      toolUseID: 't1',
      requestId: 't1'
    }
    const pending = canUseTool('Bash', { command: 'ls' }, context)
    await until(() => rec.asks.length === 1)
    expect(rec.statuses).toContain('waiting')
    void pending
  })

  test('the result preserves provider usage and records a separate context footprint', async () => {
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
    await until(() => rec.messages.some((message) => message.role === 'result'))
    const data = rec.messages.find((message) => message.role === 'result')?.data as Record<string, unknown>
    expect(data).toEqual({ ...result, contextUsage: { contextTokens: 180, contextWindow: 200000 } })
    expect(data).not.toHaveProperty(['sdk', 'Usage'].join(''))
  })

  test('the result keeps raw usage when no model window is reported', async () => {
    await runner.start(session, 'hello')
    const usage = { input_tokens: 7, output_tokens: 3 }
    queries[0].emit({ type: 'result', subtype: 'success', result: 'ok', is_error: false, usage })
    await until(() => rec.messages.some((message) => message.role === 'result'))
    const data = rec.messages.find((message) => message.role === 'result')?.data as Record<string, unknown>
    expect(data.contextUsage).toEqual({ contextTokens: 10, contextWindow: null })
    expect(data.usage).toEqual(usage)
  })

  test('a result without usage is unchanged', async () => {
    await runner.start(session, 'hello')
    const bare = { type: 'result', subtype: 'success', result: 'again', is_error: false }
    queries[0].emit(bare)
    await until(() => rec.messages.some((message) => message.role === 'result'))
    const data = rec.messages.find((message) => message.role === 'result')?.data as Record<string, unknown>
    expect(data).toEqual(bare)
    expect(data).not.toHaveProperty('contextUsage')
  })
})

type FixtureOptions = NonNullable<Parameters<typeof createCodexAppServerFixture>[1]>

describe('Codex runner', () => {
  let home: string
  let fixture: CodexAppServerFixture
  let rec: Recorder
  let runner: StructuredRunner
  let session: Session

  const configureFixture = (options?: FixtureOptions) => {
    fixture = createCodexAppServerFixture(home, options)
  }
  const configureDenyAll = (options: FixtureOptions = {}) => {
    configureFixture({ allowDenyAllEnums: true, configRead: { mcpServers: {} }, ...options })
  }
  const startDeniedTurn = async (notifications: { method: string; params?: Record<string, unknown> }[], interrupt: 'success' | 'error' | 'timeout' = 'success') => {
    configureDenyAll({ turnScript: { notifications, interrupt, hold: true } })
    await runner.start(session, 'scripted turn', { toolPolicy: 'deny-all' })
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tool-policy-codex-'))
    configureFixture()
    rec = recorder()
    session = sessionFor('codex', home)
    runner = createCodexRunner(
      { ...rec.context, resolveCodexPath: async () => fixture.executable },
      { env: isolatedProviderEnvironment(home) }
    )
  })

  afterEach(async () => {
    await runner.stop(session.id)
    rmSync(home, { recursive: true, force: true })
  })

  test('deny-all uses the strict native approval settings and the complete disabled-feature list', async () => {
    configureDenyAll()
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    await until(() => rec.statuses.includes('done'))
    const threadStart = fixture.requests().find((request) => request.method === 'thread/start')
    expect(threadStart?.params).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'read-only' })
    expect(fixture.arguments()).toEqual([
      'app-server',
      '--disable', 'shell_tool',
      '--disable', 'unified_exec',
      '--disable', 'view_image',
      '--disable', 'sleep_tool',
      '--disable', 'apps',
      '--disable', 'plugins',
      '--disable', 'browser_use',
      '--disable', 'computer_use',
      '--disable', 'in_app_browser',
      '--disable', 'image_generation',
      '--disable', 'multi_agent',
      '--disable', 'multi_agent_v2',
      '--disable', 'goals',
      '-c',
      'web_search="disabled"'
    ])
  })

  test.each([
    ['thread/start', undefined],
    ['thread/resume', { id: 'existing-thread', transcriptPath: null }]
  ] as const)('deny-all disables every configured MCP server on %s', async (method, providerSession) => {
    configureDenyAll({
      configRead: {
        mcpServers: Object.fromEntries([
          ['github', { enabled: true, url: 'https://example.invalid' }] as const,
          ['notes', { enabled: false, command: 'notes-server' }] as const,
          ['__proto__', { enabled: true, url: 'https://example.invalid' }] as const
        ])
      }
    })
    await runner.start(session, 'hello', {
      toolPolicy: 'deny-all',
      ...(providerSession === undefined ? {} : { providerSession })
    })
    await until(() => rec.statuses.includes('done'))
    const requests = fixture.requests()
    const configIndex = requests.findIndex((request) => request.method === 'config/read')
    const threadIndex = requests.findIndex((request) => request.method === method)
    expect(configIndex).toBeGreaterThan(-1)
    expect(threadIndex).toBeGreaterThan(configIndex)
    expect(requests[configIndex]?.params).toEqual({ cwd: home })
    expect(requests[threadIndex]?.params).toMatchObject({
      config: {
        mcp_servers: Object.fromEntries([
          ['github', { enabled: false }] as const,
          ['notes', { enabled: false }] as const,
          ['__proto__', { enabled: false }] as const
        ])
      }
    })
  })

  for (const [label, configRead] of [
    ['no server map', {}],
    ['null server map', { mcpServers: null }],
    ['empty server map', { mcpServers: {} }]
  ] as const) {
    test(`deny-all omits thread config for a ${label}`, async () => {
      configureDenyAll({ configRead })
      await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
      await until(() => rec.statuses.includes('done'))
      const threadStart = fixture.requests().find((request) => request.method === 'thread/start')
      expect(threadStart?.params).not.toHaveProperty('config')
    })
  }

  const configFailures = [
    { name: 'error reply', configRead: { error: { code: -32001, message: 'config unavailable' } } },
    { name: 'timeout', configRead: { timeout: true }, timeout: true },
    { name: 'missing config object', configRead: { reply: {} } },
    { name: 'non-map config object', configRead: { reply: { config: [] } } },
    { name: 'invalid server map type', configRead: { mcpServers: 'not-an-object' } },
    { name: 'array server map', configRead: { mcpServers: [] } }
  ] as const

  for (const mode of ['start', 'resume'] as const) {
    for (const failure of configFailures) {
      test(`a ${failure.name} while reading MCP config aborts ${mode}`, async () => {
        configureDenyAll({ configRead: failure.configRead })
        const providerSession = mode === 'resume' ? { id: 'existing-thread', transcriptPath: null } : undefined
        const start = () => runner.start(session, 'hello', {
          toolPolicy: 'deny-all',
          ...(providerSession === undefined ? {} : { providerSession })
        })
        const assertFailure = async () => expect(start()).rejects.toThrow(
          "could not read Codex's MCP servers, so a session without tools can't start"
        )
        if ('timeout' in failure && failure.timeout) await withFastTimers(assertFailure)
        else await assertFailure()
        const requests = fixture.requests()
        expect(requests.some((request) => request.method === 'config/read')).toBe(true)
        expect(requests.some((request) => request.method === 'thread/start' || request.method === 'thread/resume')).toBe(false)
        await expectFixtureStopped(fixture)
      })
    }
  }

  test('an unset policy does not read config or add thread settings or process arguments', async () => {
    await runner.start(session, 'hello')
    await until(() => rec.statuses.includes('done'))
    const requests = fixture.requests()
    expect(requests.some((request) => request.method === 'config/read')).toBe(false)
    expect(requests.find((request) => request.method === 'thread/start')?.params).not.toHaveProperty('config')
    expect(fixture.arguments()).toEqual(['app-server'])
  })


  const requestCases: { method: string; reply: Record<string, unknown> }[] = [
    {
      method: 'item/commandExecution/requestApproval',
      reply: { result: { decision: 'decline' } }
    },
    {
      method: 'item/fileChange/requestApproval',
      reply: { result: { decision: 'decline' } }
    },
    {
      method: 'execCommandApproval',
      reply: { result: { decision: 'denied' } }
    },
    {
      method: 'applyPatchApproval',
      reply: { result: { decision: 'denied' } }
    },
    {
      method: 'mcpServer/elicitation/request',
      reply: { result: { action: 'decline' } }
    },
    {
      method: 'item/tool/requestUserInput',
      reply: { result: { answers: {} } }
    },
    {
      method: 'item/tool/call',
      reply: { result: { success: false, contentItems: [{ type: 'inputText', text: DENY }] } }
    },
    {
      method: 'fixture/unknownRequest',
      reply: { error: { code: -32601 } }
    }
  ]

  for (const requestCase of requestCases) {
    test(`deny-all answers ${requestCase.method} without asking or waiting`, async () => {
      configureDenyAll({
        turnScript: {
          serverRequests: [{
            id: 'policy-request',
            method: requestCase.method,
            params: { threadId: 'scripted-thread', turnId: 'turn-1' }
          }]
        }
      })
      await runner.start(session, 'request script', { toolPolicy: 'deny-all' })
      await until(() => rec.statuses.includes('done'))
      const request = fixture.serverRequests().find((entry) => entry.method === requestCase.method)
      expect(request).toBeDefined()
      const reply = fixture.requests().find((entry) => entry.id === request?.id && entry.method === undefined)
      expect(reply).toMatchObject(requestCase.reply)
      expect(rec.asks).toEqual([])
      expect(rec.statuses).not.toContain('waiting')
    })
  }

  for (const [method, type] of [
    ['item/started', 'commandExecution'],
    ['item/completed', 'commandExecution']
  ] as const) {
    test(`deny-all refuses a ${method} tool item once and interrupts its turn`, async () => {
      const item = { id: 'exec-1', type, status: 'inProgress', command: 'cat secrets' }
      await startDeniedTurn([{ method, params: { threadId: 'scripted-thread', turnId: 'turn-1', item } }])
      await until(() => rec.statuses.includes('done') || rec.statuses.includes('exited'))
      expect(fixture.requests().filter((request) => request.method === 'turn/interrupt')).toHaveLength(1)
      const refusal = rec.messages.find((message) => message.role === 'system' && message.text === DENY)
      expect(refusal?.data).toEqual(item)
      expect(rec.statuses).toContain('done')
      expect(rec.statuses).not.toContain('exited')
      expect(rec.asks).toEqual([])
    })
  }

  for (const type of ['not-yet-known', undefined, 17] as const) {
    test(`deny-all refuses tool items with type ${String(type)} and does so once per turn`, async () => {
      const item = { id: 'unknown-tool', ...(type === undefined ? {} : { type }) }
      await startDeniedTurn([
        { method: 'item/started', params: { threadId: 'scripted-thread', turnId: 'turn-1', item } },
        { method: 'item/completed', params: { threadId: 'scripted-thread', turnId: 'turn-1', item } }
      ])
      await until(() => rec.statuses.includes('done') || rec.statuses.includes('exited'))
      const denials = rec.messages.filter((message) => message.role === 'system' && message.text === DENY)
      expect(denials).toHaveLength(1)
      expect(denials[0]?.data).toEqual(item)
      expect(fixture.requests().filter((request) => request.method === 'turn/interrupt')).toHaveLength(1)
    })
  }

  for (const type of [
    'userMessage',
    'agentMessage',
    'reasoning',
    'plan',
    'hookPrompt',
    'contextCompaction',
    'enteredReviewMode',
    'exitedReviewMode'
  ]) {
    test(`deny-all permits the non-tool item type ${type}`, async () => {
      configureDenyAll({
        turnScript: {
          notifications: [{
            method: 'item/started',
            params: { threadId: 'scripted-thread', turnId: 'turn-1', item: { id: 'safe-item', type } }
          }]
        }
      })
      await runner.start(session, 'safe item', { toolPolicy: 'deny-all' })
      await until(() => rec.statuses.includes('done'))
      expect(fixture.requests().some((request) => request.method === 'turn/interrupt')).toBe(false)
      expect(rec.messages.some((message) => message.role === 'system' && message.text === DENY)).toBe(false)
    })
  }

  test('deny-all journals a completed tool and its refusal', async () => {
    const item = {
      id: 'exec-1',
      type: 'commandExecution',
      status: 'completed',
      command: 'cat file.txt',
      aggregatedOutput: 'file.txt'
    }
    await startDeniedTurn([
      {
        method: 'item/started',
        params: { threadId: 'scripted-thread', turnId: 'turn-1', item: { ...item, status: 'inProgress' } }
      },
      {
        method: 'item/commandExecution/outputDelta',
        params: { threadId: 'scripted-thread', turnId: 'turn-1', itemId: item.id, delta: 'file.txt' }
      },
      { method: 'item/completed', params: { threadId: 'scripted-thread', turnId: 'turn-1', item } }
    ])
    await until(() => rec.statuses.includes('done') || rec.statuses.includes('exited'))
    const tool = rec.messages.find((message) => message.role === 'tool')
    expect(tool).toMatchObject({ text: 'cat file.txt\nfile.txt', data: item })
    expect(rec.messages.filter((message) => message.role === 'system' && message.text === DENY)).toHaveLength(1)
    expect(fixture.requests().filter((request) => request.method === 'turn/interrupt')).toHaveLength(1)
  })

  for (const interrupt of ['error', 'timeout'] as const) {
    test(`an interrupt ${interrupt} ends the deny-all run and stops Codex`, async () => {
      const item = { id: 'exec-1', type: 'commandExecution', command: 'cat secrets' }
      const run = async () => {
        await startDeniedTurn([
          { method: 'item/started', params: { threadId: 'scripted-thread', turnId: 'turn-1', item } }
        ], interrupt)
        await until(() => rec.statuses.includes('exited'))
      }
      if (interrupt === 'timeout') await withFastTimers(run)
      else await run()
      expect(rec.messages.some((message) => message.role === 'system' && message.text.includes('could not stop a tool in a session without tools'))).toBe(true)
      expect(rec.statuses).toContain('exited')
      await expectFixtureStopped(fixture)
    })
  }

  test('a tool notification with no turn fails without sending an interrupt', async () => {
    const item = { id: 'exec-no-turn', type: 'commandExecution' }
    configureDenyAll({
      threadNotifications: [{ method: 'item/started', params: { threadId: 'scripted-thread', item } }]
    })
    await runner.start(session, undefined, { toolPolicy: 'deny-all' })
    await until(() => rec.statuses.includes('exited'))
    expect(fixture.requests().some((request) => request.method === 'turn/interrupt')).toBe(false)
    expect(rec.messages.some((message) => message.role === 'system' && message.text.includes('could not stop a tool in a session without tools'))).toBe(true)
    await expectFixtureStopped(fixture)
  })

  const secondAgentCases = [
    {
      label: 'collaboration-agent item',
      method: 'item/started',
      params: { threadId: 'scripted-thread', turnId: 'turn-1', item: { id: 'agent-call', type: 'collabAgentToolCall' } },
      data: { id: 'agent-call', type: 'collabAgentToolCall' }
    },
    {
      label: 'sub-agent item',
      method: 'item/completed',
      params: { threadId: 'scripted-thread', turnId: 'turn-1', item: { id: 'agent-activity', type: 'subAgentActivity' } },
      data: { id: 'agent-activity', type: 'subAgentActivity' }
    },
    {
      label: 'foreign item start',
      method: 'item/started',
      params: { threadId: 'other-thread', turnId: 'turn-1', item: { id: 'foreign-item', type: 'agentMessage' } }
    },
    {
      label: 'foreign item completion',
      method: 'item/completed',
      params: { threadId: 'other-thread', turnId: 'turn-1', item: { id: 'foreign-item', type: 'commandExecution' } }
    },
    {
      label: 'foreign turn start',
      method: 'turn/started',
      params: { threadId: 'other-thread', turn: { id: 'child-turn' } }
    }
  ] as const

  for (const scenario of secondAgentCases) {
    test(`deny-all ends the run for a ${scenario.label}`, async () => {
      await startDeniedTurn([{ method: scenario.method, params: scenario.params }])
      await until(() => rec.statuses.includes('exited'))
      const denial = rec.messages.find((message) => message.role === 'system' && message.text === DENY)
      expect(denial?.data).toEqual('data' in scenario ? scenario.data : scenario.params)
      expect(rec.messages.some((message) => message.role === 'system' && message.text.includes('Codex started a second agent in a session without tools'))).toBe(true)
      expect(fixture.requests().some((request) => request.method === 'turn/interrupt')).toBe(false)
      await expectFixtureStopped(fixture)
    })
  }

  test('the Codex result carries context usage separately from the provider turn', async () => {
    configureFixture({
      turnScript: {
        notifications: [{
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'scripted-thread',
            tokenUsage: {
              total: { inputTokens: 900, outputTokens: 100 },
              last: { inputTokens: 300, outputTokens: 40 },
              modelContextWindow: 400000
            }
          }
        }]
      }
    })
    await runner.start(session, 'hello')
    await until(() => rec.messages.some((message) => message.role === 'result'))
    const data = rec.messages.find((message) => message.role === 'result')?.data as Record<string, unknown>
    expect(data).toMatchObject({
      id: 'turn-1',
      status: 'completed',
      contextUsage: { contextTokens: 340, contextWindow: 400000 }
    })
    expect(data).not.toHaveProperty('usage')
  })

  test('a Codex turn without usage events is preserved unchanged', async () => {
    await runner.start(session, 'hello')
    await until(() => rec.messages.some((message) => message.role === 'result'))
    expect(rec.messages.find((message) => message.role === 'result')?.data).toEqual({
      id: 'turn-1',
      status: 'completed',
      items: [{ id: 'message-turn-1', type: 'agentMessage', phase: 'final_answer', text: 'Codex: hello' }]
    })
  })

  test('without a policy, tool output deltas are journaled and foreign-thread notifications are dropped', async () => {
    configureFixture({
      turnScript: {
        notifications: [
          {
            method: 'item/started',
            params: { threadId: 'scripted-thread', turnId: 'turn-1', item: { id: 'exec-1', type: 'commandExecution', command: 'cat file.txt' } }
          },
          {
            method: 'item/commandExecution/outputDelta',
            params: { threadId: 'scripted-thread', turnId: 'turn-1', itemId: 'exec-1', delta: 'file.txt' }
          },
          {
            method: 'item/completed',
            params: { threadId: 'scripted-thread', turnId: 'turn-1', item: { id: 'exec-1', type: 'commandExecution', command: 'cat file.txt' } }
          },
          {
            method: 'item/started',
            params: { threadId: 'other-thread', turnId: 'turn-1', item: { id: 'foreign', type: 'commandExecution' } }
          }
        ]
      }
    })
    await runner.start(session, 'scripted turn')
    await until(() => rec.statuses.includes('done'))
    expect(fixture.requests().some((request) => request.method === 'turn/interrupt')).toBe(false)
    expect(rec.messages.filter((message) => message.role === 'tool')).toMatchObject([
      { text: 'cat file.txt\nfile.txt' }
    ])
    expect(rec.messages.some((message) => message.role === 'system' && message.text === DENY)).toBe(false)
  })

  test('without a policy, native input still creates an ask', async () => {
    await runner.start(session, '[native question]')
    await until(() => rec.asks.length === 1)
    expect(rec.statuses).toContain('waiting')
    expect(fixture.requests().some((request) => request.method === 'turn/interrupt')).toBe(false)
  })

  test('without a policy, command and file approvals still ask', async () => {
    await runner.start(session, '[approve twice]')
    await until(() => rec.asks.length === 2)
    expect(fixture.serverRequests().filter((request) =>
      request.method === 'item/commandExecution/requestApproval' || request.method === 'item/fileChange/requestApproval'
    )).toHaveLength(2)
    expect(rec.statuses).toContain('waiting')
    expect(fixture.requests().some((request) => request.method === 'turn/interrupt')).toBe(false)
  })
})

describe('create and resume', () => {
  const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
  const FAKES_DIR = join(PLUGIN_DIR, 'test', 'fakes')
  const globals = globalThis as typeof globalThis & {
    __structuredFakes?: FakeWorld
    __QUIRKY_TEST_STRUCTURED_RUNNER__?: StructuredRunnerFactory
  }
  const entry = { value: 'deny-all', source: 'explicit' } as const

  class RecordingRunner implements StructuredRunner {
    started: { session: Session; prompt: string | undefined; options?: StructuredStartOptions }[] = []
    private codexDelegate: StructuredRunner | null = null

    constructor(readonly context: StructuredContext) {}

    async start(session: Session, prompt?: string, options?: StructuredStartOptions) {
      this.started.push({ session, prompt, options })
      if (codexFixtureForCreate !== null && session.agent === 'codex') {
        this.codexDelegate = createCodexRunner(
          {
            ...this.context,
            resolveCodexPath: async () => codexFixtureForCreate!.executable
          },
          { env: isolatedProviderEnvironment(codexHomeForCreate!) }
        )
        await this.codexDelegate.start(session, prompt, options)
      } else {
        this.context.setStatus(session.id, 'working')
      }
    }

    async send(sessionId: string, text: string) {
      await this.codexDelegate?.send(sessionId, text)
    }

    async stop(sessionId: string) {
      await this.codexDelegate?.stop(sessionId)
    }
  }

  let h: Harness
  let client: QuirkyClient
  let world: FakeWorld
  let runner: RecordingRunner
  let codexFixtureForCreate: CodexAppServerFixture | null = null
  let codexHomeForCreate: string | null = null
  let worktreePath = ''

  beforeEach(async () => {
    world = new FakeWorld()
    worktreePath = mkdtempSync(join(tmpdir(), 'qs-policy-worktree-'))
    world.worktree.path = worktreePath
    globals.__structuredFakes = world
    const factory: StructuredRunnerFactory = (context) => (runner = new RecordingRunner(context))
    globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = factory
    const dir = makeTempDir('qs-policy-')
    symlinkSync(PLUGIN_DIR, join(dir, 'quirky.structured'))
    for (const id of ['quirky.session', 'quirky.worktree', 'quirky.ask', 'quirky.agents']) symlinkSync(join(FAKES_DIR, id), join(dir, id))
    const shortHome = mkdtempSync(join(tmpdir(), 'qs-policy-home-'))
    mkdirSync(shortHome, { recursive: true })
    h = await startHarness({ home: shortHome, builtinPluginsDir: dir })
    client = await h.connect('cli')
  })

  afterEach(async () => {
    await h?.cleanup()
    if (codexHomeForCreate !== null) rmSync(codexHomeForCreate, { recursive: true, force: true })
    if (worktreePath !== '') rmSync(worktreePath, { recursive: true, force: true })
    removeTempDirs()
    codexFixtureForCreate = null
    codexHomeForCreate = null
    delete globals.__structuredFakes
    delete globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
  })

  const create = (params: Record<string, unknown>) =>
    client.callAny('quirky.structured/create', { worktree: 'main', prompt: 'go', ...params }) as Promise<Session>

  async function provideAndStop(session: Session, providerId: string) {
    await runner.context.setProviderSession(session.id, { id: providerId, transcriptPath: null })
    await client.callAny('quirky.structured/stop', { session: session.id })
  }

  test('policy-only creation records the explicit setting and skips launch resolution', async () => {
    const session = await create({ agent: 'claude', options: { toolPolicy: 'deny-all' } })
    await until(() => runner.started.length === 1)
    expect(world.resolveLaunchCalls).toEqual([])
    expect(session.launchSettings).toEqual({
      agent: 'claude',
      options: { toolPolicy: entry },
      summary: 'Claude · No tools'
    })
    expect(runner.started[0]?.options).toMatchObject({ toolPolicy: 'deny-all' })
  })

  test('other launch picks are resolved without the policy and preserve their snapshot fields', async () => {
    const launchSettings = {
      agent: 'claude',
      options: { effort: { value: 'high', source: 'explicit' as const } },
      args: { value: '--safe-mode', source: 'explicit' as const },
      summary: 'Claude · Effort: high'
    }
    world.resolveLaunchOverride = () => ({ structured: { effort: 'high' }, launchSettings })
    const session = await create({ agent: 'claude', options: { effort: 'high', toolPolicy: 'deny-all' } })
    await until(() => runner.started.length === 1)
    expect(world.resolveLaunchCalls).toEqual([
      { agent: 'claude', model: undefined, options: { effort: 'high' }, structured: true }
    ])
    expect(world.registerCalls[0]?.launchSettings).toEqual({
      ...launchSettings,
      options: { ...launchSettings.options, toolPolicy: entry },
      summary: 'Claude · Effort: high · No tools'
    })
    expect(runner.started[0]?.options).toMatchObject({ effort: 'high', toolPolicy: 'deny-all' })
  })

  test('policy-only snapshot is used when other launch picks resolve without a saved snapshot', async () => {
    const session = await create({ agent: 'claude', options: { effort: 'high', toolPolicy: 'deny-all' } })
    await until(() => runner.started.length === 1)
    expect(world.resolveLaunchCalls[0]?.options).toEqual({ effort: 'high' })
    expect(session.launchSettings).toEqual({
      agent: 'claude',
      options: { toolPolicy: entry },
      summary: 'Claude · No tools'
    })
  })

  test('default and unset policies leave launch snapshots and runner options unchanged', async () => {
    const defaulted = await create({ agent: 'claude', options: { toolPolicy: 'default' } })
    const unset = await create({ agent: 'codex' })
    await until(() => runner.started.length === 2)
    expect(defaulted.launchSettings).toBeNull()
    expect(unset.launchSettings).toBeNull()
    for (const started of runner.started) expect(started.options).not.toHaveProperty('toolPolicy')
    expect(world.registerCalls.every((call) => !Object.hasOwn(call, 'launchSettings'))).toBe(true)
  })

  test('unknown policy is refused before any session is registered', async () => {
    const error = await create({ agent: 'claude', options: { toolPolicy: 'allow-all' } }).catch((value: RpcError) => value)
    expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(world.registerCalls).toEqual([])
  })

  test('resume replays the saved deny-all policy and leaves the old snapshot unchanged', async () => {
    const original = await create({ agent: 'claude', options: { toolPolicy: 'deny-all' } })
    await until(() => runner.started.length === 1)
    const launchSettings = original.launchSettings
    await provideAndStop(original, 'provider-thread')
    const resumed = await client.callAny('quirky.structured/resume', { session: original.id }) as Session
    await until(() => runner.started.length === 2)
    expect(runner.started[1]?.options).toMatchObject({ toolPolicy: 'deny-all', providerSession: { id: 'provider-thread' } })
    expect(resumed.launchSettings).toEqual(launchSettings)
    expect(original.launchSettings).toEqual(launchSettings)
  })

  test('resume without a policy starts without one for null and policy-free snapshots', async () => {
    const nullSnapshot = await create({ agent: 'claude' })
    await until(() => runner.started.length === 1)
    await provideAndStop(nullSnapshot, 'null-snapshot-thread')
    const firstResume = await client.callAny('quirky.structured/resume', { session: nullSnapshot.id }) as Session
    await until(() => runner.started.length === 2)
    expect(runner.started[1]?.options).not.toHaveProperty('toolPolicy')
    expect(firstResume.launchSettings).toBeNull()

    world.resolveLaunchOverride = () => ({
      structured: { effort: 'high' },
      launchSettings: {
        agent: 'claude',
        options: { effort: { value: 'high', source: 'explicit' } },
        summary: 'Claude · Effort: high'
      }
    })
    const savedOptions = await create({ agent: 'claude', options: { effort: 'high' } })
    await until(() => runner.started.length === 3)
    await provideAndStop(savedOptions, 'option-snapshot-thread')
    const secondResume = await client.callAny('quirky.structured/resume', { session: savedOptions.id }) as Session
    await until(() => runner.started.length === 4)
    expect(runner.started[3]?.options).toMatchObject({ effort: 'high' })
    expect(runner.started[3]?.options).not.toHaveProperty('toolPolicy')
    expect(secondResume.launchSettings).toEqual(savedOptions.launchSettings)
  })

  for (const [label, badEntry] of [
    ['another string value', { value: 'allow-all', source: 'explicit' }],
    ['missing value', { source: 'explicit' }],
    ['a non-string value', { value: true, source: 'explicit' }]
  ] as const) {
    test(`resume refuses an unreadable tool policy with ${label}`, async () => {
      const original = await create({ agent: 'claude', options: { toolPolicy: 'deny-all' } })
      await until(() => runner.started.length === 1)
      await provideAndStop(original, `provider-${label}`)
      const saved = world.sessions.get(original.id)!
      world.sessions.set(original.id, {
        ...saved,
        launchSettings: {
          agent: 'claude',
          options: { toolPolicy: badEntry },
          summary: 'Claude'
        } as Session['launchSettings']
      })
      const registrationCount = world.registerCalls.length
      const error = await (client.callAny('quirky.structured/resume', { session: original.id }) as Promise<Session>)
        .catch((value: RpcError) => value)
      expect(error).toMatchObject({
        code: RpcErrorCode.Conflict,
        message: `session ${original.id} has an unreadable tool policy`
      })
      expect(world.registerCalls).toHaveLength(registrationCount)
      expect(runner.started).toHaveLength(1)
    })
  }

  test('a fresh store stays at version two without a policy table through create, resume and removal', async () => {
    const original = await create({ agent: 'claude', options: { toolPolicy: 'deny-all' } })
    await until(() => runner.started.length === 1)
    await provideAndStop(original, 'stored-provider-thread')
    const resumed = await client.callAny('quirky.structured/resume', { session: original.id }) as Session
    await until(() => runner.started.length === 2)
    await client.callAny('quirky.session/close', { session: original.id })
    await client.callAny('quirky.session/close', { session: resumed.id })

    const database = new Database(join(h.home, 'plugin-data', 'quirky.structured', 'store.db'), { readonly: true })
    try {
      const tableName = ['structured', 'tool', 'policy'].join('_')
      expect(database.query('SELECT name FROM sqlite_master WHERE name = ?').all(tableName)).toEqual([])
      expect(database.query('PRAGMA user_version').get()).toEqual({ user_version: 2 })
    } finally {
      database.close()
    }
  })

  test('config-read startup failure reaches the session start-failure path', async () => {
    codexHomeForCreate = mkdtempSync(join(tmpdir(), 'tool-policy-main-codex-'))
    world.worktree.path = codexHomeForCreate
    codexFixtureForCreate = createCodexAppServerFixture(codexHomeForCreate, {
      allowDenyAllEnums: true,
      configRead: { error: { code: -32001, message: 'config unavailable' } }
    })
    const session = await create({ agent: 'codex', options: { toolPolicy: 'deny-all' } })
    await until(() => world.statusLog.some((entry) => entry.sessionId === session.id && entry.status === 'exited'))
    const messages = await client.callAny('quirky.structured/messages', { session: session.id }) as StructuredMessage[]
    expect(messages.some((message) => message.text === "could not start: could not read Codex's MCP servers, so a session without tools can't start")).toBe(true)
    expect(codexFixtureForCreate.requests().some((request) => request.method === 'thread/start')).toBe(false)
    await expectFixtureStopped(codexFixtureForCreate)
  })
})
