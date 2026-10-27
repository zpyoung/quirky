import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Database } from 'bun:sqlite'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, Session } from '@quirky/protocol'
import type { DockQuestion } from '../src/types'
import { createProviderBridge } from '../src/providers'

const providerSessionId = 'provider-session-123'
const sessionId = 'terminal-session-123'
const prompt = {
  questions: [
    { question: 'Choose a color', options: ['Red', 'Blue'] },
    { question: 'Choose a shape', options: ['Circle', 'Square'] }
  ]
}

type Status = {
  sessionId: string
  agent: string
  state: 'working' | 'waiting' | 'blocked' | 'done'
  question?: string
  toolName?: string
  toolInput?: string
  heldPermission?: { toolUseId: string | null; toolName: string; input: string; childId: string | null }
  lead: { providerSession: string | null; ended: boolean }
  stateStartedAt: number
  evidenceAt: number
  turnStartedAt: number | null
  source: string
  restoredUnconfirmed?: boolean
  model?: string
  prompt: string
}

class FakeTui {
  screen: string
  readonly writes: string[] = []
  readonly writeTimes: number[] = []
  failNext: Error | null = null
  onInput: (input: string) => void = () => {}

  constructor(screen: string) {
    this.screen = screen
  }

  protected record(input: string): void {
    if (this.failNext) {
      const error = this.failNext
      this.failNext = null
      throw error
    }
    this.writes.push(input)
    this.writeTimes.push(performance.now())
  }

  consume(input: string): void | Promise<void> {
    this.record(input)
    return this.onInput(input)
  }
}

const childProcesses: ChildProcessWithoutNullStreams[] = []

class ProcessFakeTui extends FakeTui {
  readonly child: ChildProcessWithoutNullStreams
  private acknowledgementCount = 0
  private pendingOutputLine = ''
  private processError: Error | null = null
  private exited = false
  private waiters: { condition: () => boolean; resolve: () => void; reject: (error: unknown) => void }[] = []

  constructor() {
    super('')
    const script = String.raw`process.stdout.write('ENV:' + process.env.HOME + ':' + process.env.QUIRKY_HOME + '\nChoose a color\n1. Red\n2. Blue\nREADY\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', input => process.stdout.write('TUI consumed ' + JSON.stringify(input) + '\nACK\n'))`
    this.child = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, HOME: home, QUIRKY_HOME: process.env.QUIRKY_HOME ?? join(home, 'quirky') },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    childProcesses.push(this.child)
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.screen += chunk
      this.pendingOutputLine += chunk
      const lines = this.pendingOutputLine.split('\n')
      this.pendingOutputLine = lines.pop() ?? ''
      this.acknowledgementCount += lines.filter((line) => line === 'ACK').length
      this.settleWaiters()
    })
    this.child.once('error', (error) => {
      this.processError = error
      this.settleWaiters()
    })
    this.child.once('exit', () => {
      this.exited = true
      this.settleWaiters()
    })
    this.child.stderr.resume()
  }

  async ready(): Promise<void> {
    await this.waitFor(() => this.screen.includes('READY'))
  }

  override async consume(input: string): Promise<void> {
    this.record(input)
    const expected = this.acknowledgementCount + 1
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.child.stdin.write(input, (error?: Error | null) => error ? reject(error) : resolve())
    await promise
    await this.waitFor(() => this.acknowledgementCount >= expected)
  }

  private waitFor(condition: () => boolean): Promise<void> {
    if (condition()) return Promise.resolve()
    if (this.processError) return Promise.reject(this.processError)
    if (this.exited) return Promise.reject(new Error('fake TUI process exited before acknowledging input'))
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.waiters.push({ condition, resolve, reject })
    return promise
  }

  private settleWaiters(): void {
    this.waiters = this.waiters.filter((waiter) => {
      if (this.processError) {
        waiter.reject(this.processError)
        return false
      }
      if (waiter.condition()) {
        waiter.resolve()
        return false
      }
      if (this.exited) {
        waiter.reject(new Error('fake TUI process exited before acknowledging input'))
        return false
      }
      return true
    })
  }
}

let home = ''
let workspace = ''
let savedEnvironment: Record<string, string | undefined> = {}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'terminal-dock-provider-'))
  workspace = join(home, 'workspace')
  await mkdir(workspace, { recursive: true })
  savedEnvironment = {
    HOME: process.env.HOME,
    QUIRKY_HOME: process.env.QUIRKY_HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    GROK_HOME: process.env.GROK_HOME,
    OMP_SESSIONS_DIR: process.env.OMP_SESSIONS_DIR,
    OMP_CODING_AGENT_DIR: process.env.OMP_CODING_AGENT_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    OMP_PROFILE: process.env.OMP_PROFILE,
    PI_PROFILE: process.env.PI_PROFILE,
    PI_CONFIG_DIR: process.env.PI_CONFIG_DIR,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    OPENCODE_DB: process.env.OPENCODE_DB,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME
  }
  process.env.HOME = home
  process.env.QUIRKY_HOME = join(home, 'quirky')
  process.env.CODEX_HOME = join(home, '.codex')
  process.env.GROK_HOME = join(home, '.grok')
  process.env.OMP_SESSIONS_DIR = join(home, '.omp', 'agent', 'sessions')
  process.env.XDG_DATA_HOME = join(home, '.local', 'share')
  delete process.env.OMP_CODING_AGENT_DIR
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.OMP_PROFILE
  delete process.env.PI_PROFILE
  delete process.env.PI_CONFIG_DIR
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.OPENCODE_DB
  delete process.env.XDG_CONFIG_HOME
})

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const { promise, resolve } = Promise.withResolvers<void>()
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
    if (!child.kill('SIGKILL')) resolve()
    await promise
  }
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (home) await rm(home, { recursive: true, force: true })
})

function makeSession(agent: string, transcriptPath: string | null = null): Session {
  return {
    id: sessionId,
    kind: 'terminal',
    agent,
    worktreeId: 'worktree-1',
    cwd: workspace,
    title: `${agent} session`,
    status: 'waiting',
    createdAt: 10,
    lastActivityAt: 10,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: true,
    launch: null,
    providerSession: { id: providerSessionId, transcriptPath },
    promptDelivery: null,
    launchSettings: null,
    resumedFrom: null,
    agentStatus: null,
    unread: null
  }
}

function makeStatus(agent: string, overrides: Partial<Status> = {}): Status {
  return {
    sessionId,
    agent,
    state: 'waiting',
    question: JSON.stringify(prompt),
    toolName: 'AskUserQuestion',
    toolInput: JSON.stringify(prompt),
    lead: { providerSession: providerSessionId, ended: false },
    stateStartedAt: 100,
    evidenceAt: 101,
    turnStartedAt: 90,
    source: 'hook',
    model: agent === 'claude' || agent === 'openclaude' ? 'sonnet' : 'gpt-5.6-luna',
    prompt: 'Summarize the repository',
    ...overrides
  }
}

function makeContext(args: {
  agent: string
  status?: Status
  tui?: FakeTui
  onCall?: (method: string, params: Record<string, unknown>) => unknown
}): { context: PluginContext; setStatus: (status: Status) => void; tui: FakeTui; calls: string[][] } {
  let status = args.status ?? makeStatus(args.agent)
  const tui = args.tui ?? new FakeTui('Choose a color\n1. Red\n2. Blue')
  const calls: string[][] = []
  const context = {
    pluginId: 'quirky.terminal-dock',
    dir: home,
    dataDir: join(home, 'plugin-data'),
    home: join(home, 'quirky'),
    log: () => {},
    provide: () => {},
    emit: () => true,
    subscribe: () => () => {},
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push([method, JSON.stringify(params)])
      if (method === 'quirky.agent-status/get') return status
      if (method === 'quirky.agents/options') {
        return (
          args.onCall?.(method, params) ?? {
            agent: args.agent,
            label: args.agent,
            supported: true,
            models: [
              {
                id: 'sonnet',
                label: 'Sonnet',
                options: [
                  {
                    id: 'effort',
                    label: 'Effort',
                    type: 'select',
                    choices: [
                      { value: 'low', label: 'Low' },
                      { value: 'medium', label: 'Medium' },
                      { value: 'high', label: 'High' }
                    ]
                  }
                ]
              },
              { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', options: [] }
            ],
            unlisted: 'refuse',
            unlistedOptions: [],
            structured: false,
            extraArgs: { allowed: [], placeholder: '' }
          }
        )
      }
      return args.onCall?.(method, params)
    },
    openStore: () => {
      throw new Error('providers must not open persistent stores')
    },
    getSetting: () => undefined,
    storedSettingValue: () => undefined,
    error: (_kind: string, message: string) => new Error(message),
    pty: {
      connected: true,
      write: (id: string, data: string | Uint8Array) => { void tui.consume(typeof data === 'string' ? data : Buffer.from(data).toString()) },
      writeAccepted: async (id: string, data: string | Uint8Array) => {
        if (id !== sessionId) throw new Error('wrong terminal session')
        await tui.consume(typeof data === 'string' ? data : Buffer.from(data).toString())
      },
      read: async (id: string) => {
        if (id !== sessionId) throw new Error('wrong terminal session')
        return { lines: tui.screen.split('\n'), cols: 100, rows: 30, alt: true }
      },
      list: async () => [],
      onData: () => () => {},
      onExit: () => () => {},
      onFact: () => () => {},
      onInput: () => () => {},
      onReconnect: () => () => {}
    }
  } as unknown as PluginContext
  return { context, setStatus: (next) => (status = next), tui, calls }
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

function callStatus(agent: string): Status {
  return makeStatus(agent, { question: undefined })
}

const jsonlCases: {
  agent: string
  transcriptPath: () => string
  call: unknown
  result: unknown
}[] = [
  {
    agent: 'claude',
    transcriptPath: () => join(home, 'claude.jsonl'),
    call: {
      type: 'assistant',
      uuid: 'claude-message',
      timestamp: '2026-10-27T12:00:00.000Z',
      message: {
        id: 'claude-message',
        model: 'claude-sonnet-4-5',
        effort: 'high',
        usage: { input_tokens: 100, context_window: 1_000 },
        content: [{ type: 'tool_use', id: 'claude-question-1', name: 'AskUserQuestion', input: prompt }]
      }
    },
    result: {
      type: 'user',
      uuid: 'claude-result',
      timestamp: '2026-10-27T12:00:01.000Z',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'claude-question-1', content: 'answered' }]
      }
    }
  },
  {
    agent: 'codex',
    transcriptPath: () => join(home, 'codex.jsonl'),
    call: {
      type: 'response_item',
      timestamp: '2026-10-27T12:00:00.000Z',
      payload: {
        type: 'function_call',
        call_id: 'codex-question-1',
        name: 'request_user_input',
        arguments: JSON.stringify(prompt)
      }
    },
    result: {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'codex-question-1',
        output: 'answered'
      }
    }
  },
  {
    agent: 'grok',
    transcriptPath: () => join(home, '.grok', 'sessions', encodeURIComponent(workspace), providerSessionId, 'chat_history.jsonl'),
    call: {
      type: 'backend_tool_call',
      id: 'grok-question-1',
      timestamp: '2026-10-27T12:00:00.000Z',
      kind: { tool_type: 'ask_user_question', ...prompt }
    },
    result: {
      type: 'tool_result',
      id: 'grok-result-1',
      tool_call_id: 'grok-question-1',
      content: 'answered'
    }
  },
  {
    agent: 'omp',
    transcriptPath: () => join(home, '.omp', 'agent', 'sessions', 'workspace', `${providerSessionId}.jsonl`),
    call: {
      type: 'message',
      id: 'omp-call-row',
      timestamp: '2026-10-27T12:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'omp-question-1', name: 'ask_user_question', arguments: prompt }]
      }
    },
    result: {
      type: 'message',
      id: 'omp-result-row',
      message: { role: 'toolResult', toolCallId: 'omp-question-1', content: 'answered' }
    }
  }
]
const claudeEffortChoices = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

function claudeOptionCatalog(fableLabel = 'Fable') {
  const effortOption = () => ({ id: 'effort', label: 'Effort', type: 'select', choices: claudeEffortChoices })
  return {
    agent: 'claude',
    supported: true,
    models: [
      { id: 'fable', label: fableLabel, options: [effortOption()] },
      { id: 'opus', label: 'Opus', options: [effortOption()] },
      { id: 'sonnet', label: 'Sonnet', options: [effortOption()] },
      { id: 'haiku', label: 'Haiku', options: [] }
    ]
  }
}


describe('provider bridge from actual transcript and hook evidence', () => {
  test('decodes unresolved provider-shaped question calls for each JSONL family', async () => {
    for (const fixture of jsonlCases) {
      const path = fixture.transcriptPath()
      await writeJsonl(path, [fixture.call])
      const { context } = makeContext({ agent: fixture.agent, status: callStatus(fixture.agent) })
      const bridge = createProviderBridge(context)
      const result = await bridge.read(makeSession(fixture.agent, fixture.agent === 'grok' ? null : path))
      expect(result.question?.questions[0]?.prompt).toBe('Choose a color')
      expect(result.question?.questions[0]?.choices.map((choice) => choice.label)).toEqual(['Red', 'Blue'])
      expect(result.question?.id).toContain(fixture.agent === 'claude' ? 'claude-question-1' : fixture.agent === 'codex' ? 'codex-question-1' : fixture.agent === 'grok' ? 'grok-question-1' : 'omp-question-1')
      if (fixture.agent === 'claude') {
        expect(result.options.model).toBe('sonnet')
        expect(result.options.effort).toBe('high')
        expect(result.options.context).toEqual({ used: 100, limit: 1_000 })
        expect(result.options.choices.effort).toContain('low')
      }
      bridge.dispose()
    }
  })
  test('matches a Claude native Sonnet transcript to its family catalog without changing the reported ID', async () => {
    const transcriptPath = join(home, 'claude-native-sonnet.jsonl')
    await writeJsonl(transcriptPath, [{
      type: 'assistant',
      uuid: 'claude-sonnet-options',
      timestamp: '2026-10-27T12:00:00.000Z',
      message: {
        id: 'claude-sonnet-options',
        model: 'claude-sonnet-4-5',
        effort: 'medium',
        usage: { input_tokens: 100, context_window: 1_000 },
        content: []
      }
    }])
    const tui = new FakeTui('Model selector\nEffort\n❯ Low\nPress s for this session only')
    tui.onInput = (input) => {
      if (input === 's') tui.screen = 'Current effort: low'
    }
    const { context, calls } = makeContext({
      agent: 'claude',
      status: makeStatus('claude', { model: undefined, question: undefined, toolName: undefined, toolInput: undefined }),
      tui,
      onCall: (method) => method === 'quirky.agents/options' ? claudeOptionCatalog() : undefined
    })
    const bridge = createProviderBridge(context)
    const session = makeSession('claude', transcriptPath)
    const state = await bridge.read(session)
    expect(state.options.model).toBe('claude-sonnet-4-5')
    expect(state.options.effort).toBe('medium')
    expect(state.options.choices.model).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(state.options.choices.effort).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])

    const result = await bridge.setOption(session, 'effort', 'low', new AbortController().signal)
    expect(tui.writes).toEqual(['s'])
    expect(result.confirmed).toBe(true)
    expect(calls.some(([method]) => method === 'setting.set')).toBe(false)
    bridge.dispose()
  })

  test('keeps a Claude native Haiku model unavailable when its catalog alias has no options', async () => {
    const transcriptPath = join(home, 'claude-native-haiku.jsonl')
    await writeJsonl(transcriptPath, [{
      type: 'assistant',
      uuid: 'claude-haiku-options',
      timestamp: '2026-10-27T12:00:00.000Z',
      message: {
        id: 'claude-haiku-options',
        model: 'claude-haiku-4-5',
        effort: 'medium',
        usage: { input_tokens: 100, context_window: 1_000 },
        content: []
      }
    }])
    const { context } = makeContext({
      agent: 'claude',
      status: makeStatus('claude', { model: undefined, question: undefined, toolName: undefined, toolInput: undefined }),
      onCall: (method) => method === 'quirky.agents/options' ? claudeOptionCatalog() : undefined
    })
    const bridge = createProviderBridge(context)
    const state = await bridge.read(makeSession('claude', transcriptPath))
    expect(state.options.model).toBe('claude-haiku-4-5')
    expect(state.options.effort).toBe('medium')
    expect(state.options.choices.effort).toEqual([])
    bridge.dispose()
  })

  test('does not infer an effort family from an unknown Claude native model ID', async () => {
    const transcriptPath = join(home, 'claude-native-unknown.jsonl')
    await writeJsonl(transcriptPath, [{
      type: 'assistant',
      uuid: 'claude-unknown-options',
      timestamp: '2026-10-27T12:00:00.000Z',
      message: {
        id: 'claude-unknown-options',
        model: 'claude-nova-4-5',
        effort: 'medium',
        usage: { input_tokens: 100, context_window: 1_000 },
        content: []
      }
    }])
    const { context } = makeContext({
      agent: 'claude',
      status: makeStatus('claude', { model: undefined, question: undefined, toolName: undefined, toolInput: undefined }),
      onCall: (method) => method === 'quirky.agents/options' ? claudeOptionCatalog('Claude') : undefined
    })
    const bridge = createProviderBridge(context)
    const state = await bridge.read(makeSession('claude', transcriptPath))
    expect(state.options.model).toBe('claude-nova-4-5')
    expect(state.options.effort).toBe('medium')
    expect(state.options.choices.effort).toEqual([])
    bridge.dispose()
  })


  test('retires transcript questions only when the matching provider call resolves', async () => {
    for (const fixture of jsonlCases) {
      const path = fixture.transcriptPath()
      await writeJsonl(path, [fixture.call, fixture.result])
      const { context } = makeContext({ agent: fixture.agent, status: callStatus(fixture.agent) })
      const bridge = createProviderBridge(context)
      const result = await bridge.read(makeSession(fixture.agent, fixture.agent === 'grok' ? null : path))
      expect(result.question).toBeNull()
      bridge.dispose()
    }
  })

  test('rejects stale hook answers before sending any selector key', async () => {
    const { context, setStatus, tui } = makeContext({ agent: 'claude' })
    const bridge = createProviderBridge(context)
    const session = makeSession('claude')
    const question = (await bridge.read(session)).question as DockQuestion
    setStatus(makeStatus('claude', { state: 'working', question: undefined, toolName: undefined, toolInput: undefined }))
    const result = await bridge.answer(session, question, [['Blue'], ['Circle']], new AbortController().signal)
    expect(result.confirmed).toBe(false)
    expect(tui.writes).toEqual([])
    bridge.dispose()
  })

  // Why: fake clocks cannot prove the next selector group waits after a real PTY acknowledgement.
  test('answers a live Claude selector with paced keys and its visible submit step', async () => {
    const tui = new FakeTui('AskUserQuestion\nChoose a color\n1. Red\n2. Blue\nChoose a shape\n1. Circle\n2. Square')
    tui.onInput = (input) => {
      if (input === '2' && tui.writes.length === 1) tui.screen = 'Choose a shape\n1. Circle\n2. Square'
      else if (input === '1' && tui.writes.length === 2) tui.screen = 'Submit answers\nPress Enter to submit'
      else if (input === '\r' && tui.writes.length === 3) tui.screen = 'Answer recorded'
    }
    const { context } = makeContext({ agent: 'claude', tui })
    const bridge = createProviderBridge(context)
    const session = makeSession('claude')
    const question = (await bridge.read(session)).question as DockQuestion
    const result = await bridge.answer(session, question, [['Blue'], ['Circle']], new AbortController().signal)
    expect(tui.writes).toEqual(['2', '1', '\r'])
    expect(tui.writeTimes[1]! - tui.writeTimes[0]!).toBeGreaterThanOrEqual(950)
    expect(result.notice).toContain('not confirmed')
    bridge.dispose()
  })

  test('delivers selector bytes to an isolated fake TUI child process', async () => {
    const tui = new ProcessFakeTui()
    await tui.ready()
    expect(tui.screen).toContain(`ENV:${home}:${join(home, 'quirky')}`)
    const activePrompt = { questions: [{ question: 'Choose a color', options: ['Red', 'Blue'] }] }
    const status = makeStatus('claude', { question: JSON.stringify(activePrompt), toolInput: JSON.stringify(activePrompt) })
    const { context } = makeContext({ agent: 'claude', status, tui })
    const bridge = createProviderBridge(context)
    const session = makeSession('claude')
    const question = (await bridge.read(session)).question as DockQuestion
    const result = await bridge.answer(session, question, [['Blue']], new AbortController().signal)
    expect(tui.writes).toEqual(['2'])
    expect(tui.screen).toContain('TUI consumed \"2\"')
    expect(result.confirmed).toBe(false)
    bridge.dispose()
  })
  test('sends Grok and OMP answers as acknowledged terminal paste followed by submit', async () => {
    for (const agent of ['grok', 'omp']) {
      const tui = new FakeTui('Question: Choose a color\n1. Red\n2. Blue')
      const { context } = makeContext({ agent, tui })
      const bridge = createProviderBridge(context)
      const session = makeSession(agent)
      const question = (await bridge.read(session)).question as DockQuestion
      await bridge.answer(session, question, [['Blue'], ['Circle']], new AbortController().signal)
      expect(tui.writes[0]).toContain('\u001b[200~')
      expect(tui.writes.at(-1)).toBe('\r')
      expect(tui.writes.join('')).toContain('Blue')
      bridge.dispose()
    }
  })

  test('accepts a real held permission with the provider key and refuses arbitrary answer text', async () => {
    const status = makeStatus('codex', {
      question: undefined,
      toolName: 'Bash',
      heldPermission: { toolUseId: 'permission-call-1', toolName: 'Bash', input: '{"command":"pwd"}', childId: null }
    })
    const tui = new FakeTui('Allow Bash?\n1 to accept, Escape to deny')
    const { context, setStatus } = makeContext({ agent: 'codex', status, tui })
    const bridge = createProviderBridge(context)
    const session = makeSession('codex')
    const question = (await bridge.read(session)).question as DockQuestion
    expect(question.kind).toBe('permission')
    const blockedOption = await bridge.setOption(session, 'permission', 'ask', new AbortController().signal)
    expect(blockedOption.confirmed).toBe(false)
    expect(blockedOption.notice).toContain('active provider question')
    expect(tui.writes).toEqual([])
    const invalid = await bridge.answer(session, question, [['yes']], new AbortController().signal)
    expect(invalid.confirmed).toBe(false)
    expect(tui.writes).toEqual([])
    const accepted = await bridge.answer(session, question, [['allow']], new AbortController().signal)
    expect(accepted.confirmed).toBe(false)
    expect(tui.writes).toEqual(['1'])
    setStatus(makeStatus('codex', { state: 'working', question: undefined, heldPermission: undefined }))
    bridge.dispose()
  })

  test('uses each provider permission acceptance control instead of answer prose', async () => {
    for (const agent of ['claude', 'openclaude', 'codex', 'grok', 'omp', 'opencode', 'opencode2', 'zcode']) {
      const status = makeStatus(agent, {
        question: undefined,
        toolName: 'Bash',
        heldPermission: { toolUseId: `permission-${agent}`, toolName: 'Bash', input: '{"command":"pwd"}', childId: null }
      })
      const tui = new FakeTui('Allow Bash?\n1 to accept, Escape to deny')
      const { context } = makeContext({ agent, status, tui })
      const bridge = createProviderBridge(context)
      const result = await bridge.answer(
        makeSession(agent),
        (await bridge.read(makeSession(agent))).question as DockQuestion,
        [['allow']],
        new AbortController().signal
      )
      expect(result.confirmed).toBe(false)
      expect(tui.writes).toEqual([['opencode', 'opencode2', 'zcode'].includes(agent) ? '\r' : '1'])
      bridge.dispose()
    }
  })

  test('does not resurrect an acknowledged hook request from a stale status row', async () => {
    const { context } = makeContext({ agent: 'claude' })
    const bridge = createProviderBridge(context)
    const session = makeSession('claude')
    const question = (await bridge.read(session)).question as DockQuestion
    await bridge.answer(session, question, [['Blue'], ['Circle']], new AbortController().signal)
    expect((await bridge.read(session)).question).toBeNull()
    bridge.dispose()
  })

  test('refuses to type an option into an active provider question selector', async () => {
    const tui = new FakeTui('AskUserQuestion\nChoose a color\n1. Red\n2. Blue\n⏸ manual mode on (shift+tab to cycle)\n❯')
    const { context } = makeContext({ agent: 'claude', tui })
    const bridge = createProviderBridge(context)
    const session = makeSession('claude')
    const state = await bridge.read(session)
    expect(state.options.permission).toBe('ask')
    expect(state.options.choices.permission).toEqual([])
    const result = await bridge.setOption(session, 'effort', 'low', new AbortController().signal)
    expect(result.confirmed).toBe(false)
    expect(result.notice).toContain('active provider question')
    const permission = await bridge.setOption(session, 'permission', 'accept-edits', new AbortController().signal)
    expect(permission.confirmed).toBe(false)
    expect(permission.notice).toContain('active provider question')
    expect(tui.writes).toEqual([])
    bridge.dispose()
  })
  test('observes only the exact prompt in the matching live turn', async () => {
    const { context, setStatus } = makeContext({ agent: 'codex' })
    const bridge = createProviderBridge(context)
    const session = makeSession('codex')
    expect(await bridge.observed(session, 'Summarize the repository', 90)).toBe(true)
    expect(await bridge.observed(session, 'unrelated output', 90)).toBe(false)
    setStatus(makeStatus('codex', { prompt: 'Summarize the repository', turnStartedAt: 50 }))
    expect(await bridge.observed(session, 'Summarize the repository', 90)).toBe(false)
    bridge.dispose()
  })

  test('uses Claude session-only picker action and leaves global settings bytes unchanged', async () => {
    const claudeHome = join(home, '.claude')
    await mkdir(claudeHome, { recursive: true })
    const settings = join(claudeHome, 'settings.json')
    const sentinel = '{"effortLevel":"high","sentinel":"keep"}\n'
    await writeFile(settings, sentinel)
    const tui = new FakeTui('Model selector\nEffort\n❯ Low\nPress s for this session only')
    tui.onInput = (input) => {
      if (input === 's') tui.screen = 'Current effort: low'
    }
    const { context, calls } = makeContext({ agent: 'claude', status: makeStatus('claude', { question: undefined, toolName: undefined }), tui })
    const bridge = createProviderBridge(context)
    const result = await bridge.setOption(makeSession('claude'), 'effort', 'low', new AbortController().signal)
    expect(tui.writes).toEqual(['s'])
    expect(result.confirmed).toBe(true)
    expect(await readFile(settings, 'utf8')).toBe(sentinel)
    expect(calls.some(([method]) => method === 'setting.set')).toBe(false)
    bridge.dispose()
  })



  test('keeps Claude model selection session-only and leaves global settings bytes unchanged', async () => {
    const claudeHome = join(home, '.claude')
    await mkdir(claudeHome, { recursive: true })
    const settings = join(claudeHome, 'settings.json')
    const sentinel = '{"model":"sonnet","sentinel":"keep"}\n'
    await writeFile(settings, sentinel)
    const tui = new FakeTui('Model selector\n❯ GPT-5.6 Luna\nPress s for this session only')
    tui.onInput = (input) => {
      if (input === 's') tui.screen = 'Current model: gpt-5.6-luna'
    }
    const { context, calls } = makeContext({ agent: 'claude', status: makeStatus('claude', { question: undefined, toolName: undefined, model: 'sonnet' }), tui })
    const bridge = createProviderBridge(context)
    const result = await bridge.setOption(makeSession('claude'), 'model', 'gpt-5.6-luna', new AbortController().signal)
    expect(tui.writes).toEqual(['s'])
    expect(result.confirmed).toBe(true)
    expect(await readFile(settings, 'utf8')).toBe(sentinel)
    expect(calls.some(([method]) => method === 'setting.set')).toBe(false)
    bridge.dispose()
  })
  test('uses the public Grok catalog for a session-only effort change', async () => {
    const tui = new FakeTui('Grok prompt')
    tui.onInput = (input) => {
      if (input === '\r') tui.screen = 'Current effort: low'
    }
    const status = makeStatus('grok', { question: undefined, toolName: undefined, model: 'grok-4.7' })
    const { context, calls } = makeContext({
      agent: 'grok',
      status,
      tui,
      onCall: (method) => method === 'quirky.agents/options' ? {
        agent: 'grok',
        supported: true,
        models: [{
          id: 'grok-4.7',
          label: 'Grok 4.7',
          options: [{
            id: 'effort',
            label: 'Reasoning effort',
            type: 'select',
            choices: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }]
          }]
        }]
      } : undefined
    })
    const bridge = createProviderBridge(context)
    const session = makeSession('grok')
    const state = await bridge.read(session)
    expect(state.options.choices.effort).toEqual(['low', 'medium'])
    const result = await bridge.setOption(session, 'effort', 'low', new AbortController().signal)
    expect(tui.writes[0]).toContain('/effort low')
    expect(tui.writes.at(-1)).toBe('\r')
    expect(result.confirmed).toBe(true)
    expect(calls.some(([method]) => method === 'setting.set')).toBe(false)
    bridge.dispose()
  })
  test('changes OMP models through the visible session picker and current-session evidence', async () => {
    const tui = new FakeTui('Model selector\n❯ Model B\nModel A')
    tui.onInput = (input) => {
      if (input === '\r') tui.screen = 'Current model: model-b'
    }
    const status = makeStatus('omp', { question: undefined, toolName: undefined, model: 'model-a' })
    const { context, calls } = makeContext({
      agent: 'omp',
      status,
      tui,
      onCall: (method) => method === 'quirky.agents/options' ? {
        agent: 'omp',
        supported: true,
        models: [
          { id: 'model-a', label: 'Model A', options: [] },
          { id: 'model-b', label: 'Model B', options: [] }
        ]
      } : undefined
    })
    const bridge = createProviderBridge(context)
    const result = await bridge.setOption(makeSession('omp'), 'model', 'model-b', new AbortController().signal)
    expect(tui.writes).toEqual(['\r'])
    expect(result.confirmed).toBe(true)
    expect(calls.some(([method]) => method === 'setting.set')).toBe(false)
    bridge.dispose()
  })
  test('refuses an unrecognized Claude option screen without writing a persistent fallback', async () => {
    const claudeHome = join(home, '.claude')
    await mkdir(claudeHome, { recursive: true })
    const settings = join(claudeHome, 'settings.json')
    const sentinel = '{"effortLevel":"high","sentinel":"keep"}\n'
    await writeFile(settings, sentinel)
    const tui = new FakeTui('Save model as the new default?\n1. Yes\n2. No')
    const { context } = makeContext({ agent: 'claude', status: makeStatus('claude', { question: undefined, toolName: undefined }), tui })
    const bridge = createProviderBridge(context)
    const result = await bridge.setOption(makeSession('claude'), 'effort', 'low', new AbortController().signal)
    expect(result.confirmed).toBe(false)
    expect(tui.writes).toEqual([])
    expect(await readFile(settings, 'utf8')).toBe(sentinel)
    bridge.dispose()
  })

  test('reads Claude and OpenClaude permission modes only from visible session status', async () => {
    for (const agent of ['claude', 'openclaude']) {
      const mode = agent === 'claude' ? '⏸ manual mode on' : '⏵⏵ accept edits on'
      const tui = new FakeTui(`${mode} (shift+tab to cycle)\n❯`)
      const { context } = makeContext({
        agent,
        status: makeStatus(agent, { question: undefined, toolName: undefined, toolInput: undefined }),
        tui
      })
      const bridge = createProviderBridge(context)
      const state = await bridge.read(makeSession(agent))
      expect(state.options.permission).toBe(agent === 'claude' ? 'ask' : 'accept-edits')
      expect(state.options.choices.permission).toEqual(agent === 'claude' ? ['ask', 'accept-edits', 'plan'] : ['accept-edits', 'plan'])
      bridge.dispose()
    }
    const claudeTui = new FakeTui('No permission status is visible\n❯')
    const claude = makeContext({
      agent: 'claude',
      status: makeStatus('claude', { question: undefined, toolName: undefined, toolInput: undefined }),
      tui: claudeTui
    })
    const claudeBridge = createProviderBridge(claude.context)
    const claudeState = await claudeBridge.read(makeSession('claude'))
    expect(claudeState.options.permission).toBeNull()
    expect(claudeState.options.choices.permission).toEqual([])
    claudeBridge.dispose()

    const openClaudeTui = new FakeTui('Default permission mode\n❯')
    const openClaude = makeContext({
      agent: 'openclaude',
      status: makeStatus('openclaude', { question: undefined, toolName: undefined, toolInput: undefined }),
      tui: openClaudeTui
    })
    const openClaudeBridge = createProviderBridge(openClaude.context)
    const openClaudeState = await openClaudeBridge.read(makeSession('openclaude'))
    expect(openClaudeState.options.permission).toBeNull()
    expect(openClaudeState.options.choices.permission).toEqual([])
    expect(openClaudeState.options.notice).toContain('not visible')
    openClaudeBridge.dispose()
  })

  test('changes Claude and OpenClaude modes through observed session-only Shift+Tab transitions', async () => {
    for (const agent of ['claude', 'openclaude']) {
      const settingsDirectory = join(home, agent === 'claude' ? '.claude' : '.openclaude')
      await mkdir(settingsDirectory, { recursive: true })
      const settings = join(settingsDirectory, 'settings.json')
      const sentinel = '{"permissionMode":"ask","sentinel":"keep"}\n'
      await writeFile(settings, sentinel)
      const initialMode = agent === 'claude' ? '⏸ manual mode on' : '⏵⏵ accept edits on'
      const nextMode = agent === 'claude' ? '⏵⏵ accept edits on' : '⏸ plan mode on'
      const value = agent === 'claude' ? 'accept-edits' : 'plan'
      const tui = new FakeTui(`${initialMode} (shift+tab to cycle)\n❯`)
      tui.onInput = (input) => {
        if (input === '\u001b[Z') tui.screen = `${nextMode} (shift+tab to cycle)\n❯`
      }
      const { context, calls } = makeContext({
        agent,
        status: makeStatus(agent, { question: undefined, toolName: undefined, toolInput: undefined }),
        tui
      })
      const bridge = createProviderBridge(context)
      const result = await bridge.setOption(makeSession(agent), 'permission', value, new AbortController().signal)
      expect(tui.writes).toEqual(['\u001b[Z'])
      expect(result.confirmed).toBe(true)
      expect(await readFile(settings, 'utf8')).toBe(sentinel)
      expect(calls.some(([method]) => method === 'setting.set')).toBe(false)
      bridge.dispose()
    }
  })

  test('Claude mode traversal observes every step and refuses an unknown optional-mode wrap', async () => {
    const tui = new FakeTui('⏸ manual mode on (shift+tab to cycle)\n❯')
    tui.onInput = (input) => {
      if (input === '\u001b[Z' && tui.writes.length === 1) tui.screen = '⏵⏵ accept edits on (shift+tab to cycle)\n❯'
      else if (input === '\u001b[Z' && tui.writes.length === 2) tui.screen = '⏸ plan mode on (shift+tab to cycle)\n❯'
    }
    const { context } = makeContext({
      agent: 'claude',
      status: makeStatus('claude', { question: undefined, toolName: undefined, toolInput: undefined }),
      tui
    })
    const bridge = createProviderBridge(context)
    const result = await bridge.setOption(makeSession('claude'), 'permission', 'plan', new AbortController().signal)
    expect(tui.writes).toEqual(['\u001b[Z', '\u001b[Z'])
    expect(result.confirmed).toBe(true)
    tui.screen = '⏸ plan mode on (shift+tab to cycle)\n❯'
    const refused = await bridge.setOption(makeSession('claude'), 'permission', 'ask', new AbortController().signal)
    expect(refused.confirmed).toBe(false)
    expect(refused.notice).toContain('optional')
    expect(tui.writes).toHaveLength(2)
    bridge.dispose()
  })

  test('Codex uses its live /permissions picker without writing config and reports unconfirmed selection', async () => {
    const configDirectory = join(home, '.codex')
    await mkdir(configDirectory, { recursive: true })
    const config = join(configDirectory, 'config.toml')
    const sentinel = 'approval_policy = "on-request"\n# keep this byte-for-byte\n'
    await writeFile(config, sentinel)
    const tui = new FakeTui('Codex prompt\n›')
    tui.onInput = (input) => {
      if (input === '/permissions\r') {
        tui.screen = 'Permissions\n❯ Ask for approval\n  Read Only\n  Approve for me\n  Full Access'
      } else if (input === '\r') {
        tui.screen = 'Permission selection requested: Ask for approval\n›'
      }
    }
    const { context, calls } = makeContext({
      agent: 'codex',
      status: makeStatus('codex', { question: undefined, toolName: undefined, toolInput: undefined }),
      tui
    })
    const bridge = createProviderBridge(context)
    const session = makeSession('codex')
    const before = await bridge.read(session)
    expect(before.options.permission).toBeNull()
    expect(before.options.choices.permission).toContain('ask')
    const result = await bridge.setOption(session, 'permission', 'ask', new AbortController().signal)
    expect(tui.writes).toEqual(['/permissions\r', '\r'])
    expect(result.confirmed).toBe(false)
    expect(result.notice).toContain('not confirmed')
    expect(await readFile(config, 'utf8')).toBe(sentinel)
    expect(calls.some(([method]) => method === 'setting.set')).toBe(false)
    bridge.dispose()
  })

  test('Codex refuses a permission preset absent from the live /permissions menu', async () => {
    const tui = new FakeTui('Codex prompt\n›')
    tui.onInput = (input) => {
      if (input === '/permissions\r') tui.screen = 'Permissions\n❯ Ask for approval\n  Read Only'
    }
    const { context } = makeContext({
      agent: 'codex',
      status: makeStatus('codex', { question: undefined, toolName: undefined, toolInput: undefined }),
      tui
    })
    const bridge = createProviderBridge(context)
    const result = await bridge.setOption(makeSession('codex'), 'permission', 'full-access', new AbortController().signal)
    expect(result.confirmed).toBe(false)
    expect(result.notice).toContain('not visible')
    expect(tui.writes).toEqual(['/permissions\r'])
    bridge.dispose()
  })

  test('refuses permission changes while an unprojected approval prompt owns the terminal', async () => {
    const tui = new FakeTui('Allow Bash?\n1 to accept\nEscape to deny\n❯')
    const { context } = makeContext({
      agent: 'codex',
      status: makeStatus('codex', { question: undefined, toolName: undefined, toolInput: undefined, heldPermission: undefined }),
      tui
    })
    const bridge = createProviderBridge(context)
    const result = await bridge.setOption(makeSession('codex'), 'permission', 'ask', new AbortController().signal)
    expect(result.confirmed).toBe(false)
    expect(result.notice).toContain('approval selector owns terminal input')
    expect(tui.writes).toEqual([])
    bridge.dispose()
  })

  test('reports per-agent permission limits instead of applying a blanket mode refusal', async () => {
    for (const agent of ['grok', 'omp', 'opencode', 'opencode2', 'zcode']) {
      const tui = new FakeTui('Provider prompt\n❯')
      const { context } = makeContext({
        agent,
        status: makeStatus(agent, { question: undefined, toolName: undefined, toolInput: undefined }),
        tui
      })
      const bridge = createProviderBridge(context)
      const state = await bridge.read(makeSession(agent))
      expect(state.options.permission).toBeNull()
      expect(state.options.choices.permission).toEqual([])
      const result = await bridge.setOption(makeSession(agent), 'permission', 'ask', new AbortController().signal)
      expect(result.confirmed).toBe(false)
      expect(result.notice.length).toBeGreaterThan(0)
      expect(tui.writes).toEqual([])
      bridge.dispose()
    }
  })


  test('reports malformed provider transcript data without inventing a question', async () => {
    const path = join(home, 'malformed-claude.jsonl')
    await writeFile(path, '{\"type\":\"assistant\"}\n{broken json}\n')
    const { context } = makeContext({ agent: 'claude', status: callStatus('claude') })
    const bridge = createProviderBridge(context)
    const result = await bridge.read(makeSession('claude', path))
    expect(result.question).toBeNull()
    expect(result.options.notice).toContain('transcript records could not be read')
    bridge.dispose()
  })
  test('does not read or surface hidden Zcode OpenCode-v1 messages', async () => {
    const dbPath = join(home, '.zcode', 'cli', 'db', 'db.sqlite')
    await mkdir(join(home, '.zcode', 'cli', 'db'), { recursive: true })
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_updated INTEGER, data TEXT);`)
    db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run(providerSessionId, workspace)
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      'hidden-message', providerSessionId, 1, 1,
      JSON.stringify({ role: 'assistant', semantics: { transcriptVisibility: 'hidden' } })
    )
    db.prepare('INSERT INTO part (id, session_id, message_id, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      'hidden-part', providerSessionId, 'hidden-message', 1,
      JSON.stringify({ type: 'tool', id: 'z-hidden', callID: 'z-hidden', tool: 'question', state: { status: 'input', input: prompt } })
    )
    db.close()
    const { context } = makeContext({ agent: 'zcode', status: callStatus('zcode') })
    const bridge = createProviderBridge(context)
    expect((await bridge.read(makeSession('zcode'))).question).toBeNull()
    bridge.dispose()
  })

  test('reads and resolves OpenCode-v1 question tool parts from its SQLite session', async () => {
    const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db')
    await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true })
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_updated INTEGER, data TEXT);`)
    db.prepare('INSERT INTO session (id) VALUES (?)').run(providerSessionId)
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      'message-v1', providerSessionId, 1, 1, JSON.stringify({ role: 'assistant', modelID: 'provider/model' })
    )
    const call = { type: 'tool', id: 'part-v1', callID: 'question-v1', tool: 'question', state: { status: 'input', input: prompt } }
    db.prepare('INSERT INTO part (id, session_id, message_id, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      'part-v1', providerSessionId, 'message-v1', 1, JSON.stringify(call)
    )
    db.close()
    const { context } = makeContext({ agent: 'opencode', status: callStatus('opencode') })
    const bridge = createProviderBridge(context)
    const session = makeSession('opencode')
    expect((await bridge.read(session)).question?.id).toContain('question-v1')
    const update = new Database(dbPath)
    update.prepare('UPDATE part SET data = ? WHERE id = ?').run(
      JSON.stringify({ ...call, state: { ...call.state, status: 'completed', output: 'answered' } }),
      'part-v1'
    )
    update.close()
    expect((await bridge.read(session)).question).toBeNull()
    bridge.dispose()
  })

  test('reads and resolves OpenCode-v2 question parts from session_message', async () => {
    const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db')
    await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true })
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);`)
    db.prepare('INSERT INTO session_v2 (id) VALUES (?)').run(providerSessionId)
    const message = { type: 'tool', id: 'part-v2', callID: 'question-v2', tool: 'question', state: { status: 'input', input: prompt } }
    db.prepare('INSERT INTO session_message (id, session_id, type, seq, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'message-v2', providerSessionId, 'tool', 1, JSON.stringify(message), 1, 1
    )
    db.close()
    const { context } = makeContext({ agent: 'opencode2', status: callStatus('opencode2') })
    const bridge = createProviderBridge(context)
    const session = makeSession('opencode2')
    expect((await bridge.read(session)).question?.id).toContain('question-v2')
    const update = new Database(dbPath)
    update.prepare('UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?').run(
      JSON.stringify({ ...message, state: { ...message.state, status: 'completed', output: 'answered' } }),
      2,
      'message-v2'
    )
    update.close()
    expect((await bridge.read(session)).question).toBeNull()
    bridge.dispose()
  })

  test('keeps a rejected provider answer retryable', async () => {
    const tui = new FakeTui('Choose a color\n1. Red\n2. Blue\nChoose a shape\n1. Circle\n2. Square')
    const rejected = Object.assign(new Error('write rejected'), { code: 'PTY_WRITE_REJECTED', acceptedBytes: 0 })
    tui.failNext = rejected
    const { context } = makeContext({ agent: 'claude', tui })
    const bridge = createProviderBridge(context)
    const session = makeSession('claude')
    const question = (await bridge.read(session)).question as DockQuestion
    const result = await bridge.answer(session, question, [['Blue'], ['Circle']], new AbortController().signal)
    expect(result.notice).toContain('refused')
    expect(tui.writes).toEqual([])
    expect((await bridge.read(session)).question?.id).toBe(question.id)
    bridge.dispose()
  })

  test('stops a paced selector after cancellation without sending later groups', async () => {
    const controller = new AbortController()
    const tui = new FakeTui('Choose a color\n1. Red\n2. Blue\nChoose a shape\n1. Circle\n2. Square')
    tui.onInput = () => controller.abort()
    const { context } = makeContext({ agent: 'claude', tui })
    const bridge = createProviderBridge(context)
    const session = makeSession('claude')
    const question = (await bridge.read(session)).question as DockQuestion
    const result = await bridge.answer(session, question, [['Blue'], ['Circle']], controller.signal)
    expect(result.notice).toContain('cancelled')
    expect(tui.writes).toEqual(['2'])
    bridge.dispose()
  })
})
