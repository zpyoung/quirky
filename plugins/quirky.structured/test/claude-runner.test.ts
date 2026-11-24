import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentCommand, AskEnvelope, AskSpec, PlanItem, Session, SessionStatus, StructuredMessage } from '@quirky/protocol'
import { claudeCommands, createClaudeRunner, type ClaudeQueryParams, type ClaudeSlashCommand } from '../claude-runner'
import type { NewStructuredMessage, StructuredContext, StructuredRunner } from '../runner'
import { FakeQuery } from './fakes/fake-query'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await tick()
  expect(check()).toBe(true)
}

let messages: StructuredMessage[]
let statuses: SessionStatus[]
let asks: { spec: AskSpec; sessionId: string; silent: boolean; from?: string; askId: string; resolve: (envelope: AskEnvelope) => void }[]
let cancelled: string[]
let plansDir: string
let queries: FakeQuery[]
let providerSessions: { sessionId: string; id: string; transcriptPath?: string | null }[]
let runner: StructuredRunner
let summariesSetting: 'ai' | 'latest-tool' | undefined
let session: Session

function makeContext(): StructuredContext {
  return {
    process: {
      spawn() {
        throw new Error('Claude runner must not spawn a process')
      }
    },
    appendMessage(msg: NewStructuredMessage) {
      const stored = { ...msg, seq: messages.length + 1, at: msg.at ?? Date.now() } as StructuredMessage
      messages.push(stored)
      return stored
    },
    setStatus(_id, status) {
      statuses.push(status)
    },
    async cancelAsk(askId) {
      cancelled.push(askId)
      asks.find((ask) => ask.askId === askId)?.resolve({ ...envelope('declined'), askId })
    },
    createAsk(spec, sessionId, options) {
      const { promise, resolve } = Promise.withResolvers<AskEnvelope>()
      const askId = `ask_${asks.length + 1}`
      asks.push({ spec, sessionId, silent: options?.silent === true, ...(options?.from === undefined ? {} : { from: options.from }), askId, resolve })
      options?.onAsk?.(askId)
      return promise
    },
    async setProviderSession(sessionId, providerSession) {
      providerSessions.push({
        sessionId,
        id: providerSession.id,
        transcriptPath: providerSession.transcriptPath
      })
    },
    ...(summariesSetting === undefined ? {} : { agentSummaries: () => summariesSetting ?? 'ai' }),
    resolveClaudePath: async () => '/usr/local/bin/claude',
    resolveCodexPath: async () => '/not-used/codex',
    resolvePiPath: async () => '/not-used/pi'
  }
}

function envelope(status: Exclude<AskEnvelope['status'], 'unavailable'>, decision?: string, reason?: string): AskEnvelope {
  return {
    status,
    askId: 'a_1',
    answers: decision
      ? {
          decision: { value: decision, source: 'option' },
          ...(reason ? { reason: { value: reason, source: 'input' as const } } : {})
        }
      : {},
    skipped: decision ? (reason ? [] : ['reason']) : ['decision'],
    summary: ''
  }
}

const assistantText = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  session_id: 'c1'
})

beforeEach(() => {
  summariesSetting = undefined
  messages = []
  statuses = []
  asks = []
  cancelled = []
  plansDir = realpathSync(mkdtempSync(join(tmpdir(), 'plans-')))
  queries = []
  providerSessions = []
  session = {
    id: 's_1',
    kind: 'structured',
    agent: 'claude',
    worktreeId: 'wt_1',
    cwd: '/work/tree',
    title: 'Claude',
    status: 'starting',
    createdAt: 1,
    lastActivityAt: 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false
  }
  runner = createClaudeRunner(makeContext(), {
    plansDir,
    query: (params: ClaudeQueryParams) => {
      const query = new FakeQuery(params)
      queries.push(query)
      return query
    }
  })
})

afterEach(() => rmSync(plansDir, { recursive: true, force: true }))

async function begin(prompt = 'hello') {
  await runner.start(session, prompt)
  return queries[0]
}

describe('configure', () => {
  test('permission mode, model and effort reach the running query and the journal', async () => {
    const query = await begin()
    const result = await runner.configure!(session.id, { permissionMode: 'plan', model: 'opus', effort: 'high' })
    expect(query.permissionModes).toEqual(['plan'])
    expect(query.models).toEqual(['opus'])
    expect(query.flagSettings).toEqual([{ effortLevel: 'high' }])
    expect(result).toEqual({ model: 'opus', effort: 'high', permissionMode: 'plan' })
    expect(messages.at(-1)!.item).toEqual({ kind: 'mode', mode: 'plan', autoAvailable: false })
  })

  test('the settings carry the mode Claude is in, with no separate plan flag', async () => {
    const query = await begin()
    await runner.configure!(session.id, { permissionMode: 'acceptEdits' })
    expect(await runner.configure!(session.id, { effort: 'low' })).toEqual({ effort: 'low', permissionMode: 'acceptEdits' })
    await runner.configure!(session.id, { permissionMode: 'plan' })
    await runner.configure!(session.id, { permissionMode: 'acceptEdits' })
    expect(query.permissionModes).toEqual(['acceptEdits', 'plan', 'acceptEdits'])
  })

  test('overlapping configure calls apply in order and report what the SDK was last told', async () => {
    const query = await begin()
    query.permissionModeDelayMs = (mode) => (mode === 'plan' ? 40 : 0)
    const first = runner.configure!(session.id, { permissionMode: 'plan' })
    const second = runner.configure!(session.id, { permissionMode: 'acceptEdits' })
    const [, last] = await Promise.all([first, second])
    expect(query.permissionModes).toEqual(['plan', 'acceptEdits'])
    expect(last).toMatchObject({ permissionMode: 'acceptEdits' })
  })

  test('picking the mode Claude already holds journals nothing new', async () => {
    const query = await begin()
    const before = messages.length
    await runner.configure!(session.id, { permissionMode: 'default' })
    expect(messages).toHaveLength(before)
    expect(query.permissionModes).toEqual(['default'])
  })

  test('a mode Quirky cannot journal is refused', async () => {
    const query = await begin()
    await expect(runner.configure!(session.id, { permissionMode: 'not-a-mode' })).rejects.toThrow('unsupported permission mode')
    expect(query.permissionModes).toEqual([])
  })

  test('a session that is not running refuses', async () => {
    await expect(runner.configure!('s_none', { permissionMode: 'plan' })).rejects.toThrow('session is not running')
  })

  test('every Claude permission mode passes straight to the SDK', async () => {
    const query = await begin()
    for (const mode of ['acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'default']) {
      expect(await runner.configure!(session.id, { permissionMode: mode })).toMatchObject({ permissionMode: mode })
    }
    expect(query.permissionModes).toEqual(['acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'default'])
  })

  test('a mode Claude refuses keeps the previous mode in force', async () => {
    const query = await begin()
    await runner.configure!(session.id, { permissionMode: 'acceptEdits' })
    query.refusedPermissionMode = { mode: 'bypassPermissions', message: 'bypass permissions is disabled by settings' }
    await expect(runner.configure!(session.id, { permissionMode: 'bypassPermissions' })).rejects.toThrow('bypass permissions is disabled by settings')
    expect(await runner.configure!(session.id, {})).toMatchObject({ permissionMode: 'acceptEdits' })
  })

  test("auto mode is refused before the SDK call when Claude says the model can't use it", async () => {
    await runner.start(session, 'hello', { model: 'haiku' })
    const query = queries[0]
    query.modelList = [{ value: 'haiku', displayName: 'Haiku', description: '', supportsAutoMode: false }]
    await expect(runner.configure!(session.id, { permissionMode: 'auto' })).rejects.toThrow('Haiku does not support auto mode')
    expect(query.permissionModes).toEqual([])
  })

  test('auto mode goes ahead when the model supports it or Claude does not say', async () => {
    const query = await begin()
    query.modelList = [{ value: 'default', displayName: 'Default', description: '', supportsAutoMode: true }]
    await runner.configure!(session.id, { permissionMode: 'auto' })
    await runner.configure!(session.id, { permissionMode: 'default' })
    query.modelList = [{ value: 'other', displayName: 'Other', description: '', supportsAutoMode: false }]
    await runner.configure!(session.id, { permissionMode: 'auto' })
    expect(query.permissionModes).toEqual(['auto', 'default', 'auto'])
  })

  test('an empty configure reads the settings without calling the SDK', async () => {
    const query = await begin()
    expect(await runner.configure!(session.id, {})).toEqual({ permissionMode: 'default' })
    expect(query.permissionModes).toEqual([])
  })
})

describe('appended instructions', () => {
  test('a fresh session and a resumed one both append the instructions to the Claude Code preset', async () => {
    await runner.start(session, 'hello', { appendInstructions: 'draw visuals' })
    expect(queries[0].params.options?.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'draw visuals' })
    await runner.start({ ...session, id: 's_2' }, undefined, {
      appendInstructions: 'draw visuals',
      providerSession: { id: 'native-1', transcriptPath: null }
    })
    expect(queries[1].params.options?.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'draw visuals' })
  })

  test('without instructions the system prompt is left to the SDK default', async () => {
    await runner.start(session, 'hello')
    expect(queries[0].params.options).not.toHaveProperty('systemPrompt')
  })
})

describe('start permission mode', () => {
  test('a session opens in default and may later switch into bypass permissions', async () => {
    const query = await begin()
    expect(query.params.options?.permissionMode).toBe('default')
    expect(query.params.options?.allowDangerouslySkipPermissions).toBe(true)
  })

  test('the opening permission mode reaches the query options and the reported settings', async () => {
    await runner.start(session, 'hello', { permissionMode: 'bypassPermissions' })
    expect(queries[0].params.options?.permissionMode).toBe('bypassPermissions')
    expect(await runner.configure!(session.id, {})).toMatchObject({ permissionMode: 'bypassPermissions' })
  })

  test('opening in plan mode starts the query in plan, and leaving it switches to the picked mode', async () => {
    await runner.start(session, 'hello', { permissionMode: 'plan' })
    expect(queries[0].params.options?.permissionMode).toBe('plan')
    await runner.configure!(session.id, { permissionMode: 'acceptEdits' })
    expect(queries[0].permissionModes).toEqual(['acceptEdits'])
  })
})

describe('start', () => {
  test('runs the query with the worktree and resolved executable', async () => {
    const query = await begin()
    expect(query.params.options?.cwd).toBe('/work/tree')
    expect(query.params.options?.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
    expect(typeof query.params.options?.canUseTool).toBe('function')
    await until(() => query.written.length === 1)
    expect(query.written[0]).toMatchObject({ type: 'user', message: { role: 'user', content: 'hello' } })
  })

  test('starts in the requested permission mode and journals it', async () => {
    await runner.start(session, 'hello', { permissionMode: 'plan' })
    expect(queries[0].params.options?.permissionMode).toBe('plan')
    expect(messages.at(-1)!.item).toEqual({ kind: 'mode', mode: 'plan', autoAvailable: false })
  })

  test('an unknown start mode falls back to default', async () => {
    await runner.start(session, 'hello', { permissionMode: 'not-a-mode' })
    expect(queries[0].params.options?.permissionMode).toBe('default')
  })

  test('a model and effort pick reaches the query options', async () => {
    await runner.start(session, 'hello', { model: 'opus', effort: 'high' })
    expect(queries[0].params.options?.model).toBe('opus')
    expect(queries[0].params.options?.effort).toBe('high')

  })

  test('persists its native ID after SDK init and resumes with the known ID', async () => {
    await runner.start(session, 'first prompt')
    expect(providerSessions).toEqual([])

    const freshInit = { type: 'system', subtype: 'init', session_id: 'fresh-native-id' }
    const nativeSessionId = freshInit.session_id
    queries[0].emit(freshInit)
    await until(() => providerSessions.length === 1)
    expect(providerSessions).toEqual([{ sessionId: 's_1', id: nativeSessionId, transcriptPath: null }])

    const resumedSession = {
      ...session,
      id: 's_2',
      providerSession: { id: nativeSessionId, transcriptPath: '/tmp/native.jsonl' }
    }
    const resumedInit = { type: 'system', subtype: 'init', session_id: nativeSessionId }
    await runner.start(resumedSession, undefined, {
      model: 'sonnet',
      providerSession: { id: nativeSessionId, transcriptPath: '/tmp/native.jsonl' }
    })
    expect(queries[1].params.options?.resume).toBe(nativeSessionId)
    expect(queries[1].params.options).not.toHaveProperty('sessionId')
    expect(queries[1].params.options?.model).toBe('sonnet')
    queries[1].emit(resumedInit)
    await until(() => messages.some((message) => message.data === resumedInit))
    expect(providerSessions).toEqual([
      { sessionId: 's_1', id: nativeSessionId, transcriptPath: null },
      { sessionId: 's_2', id: nativeSessionId, transcriptPath: '/tmp/native.jsonl' }
    ])
    await runner.send('s_2', 'continue later')
    await until(() => queries[1].written.length === 1)
    expect(queries[1].written[0]?.session_id).toBe(nativeSessionId)
    expect(queries[1].written[0]?.message).toEqual({ role: 'user', content: 'continue later' })
  })

  test('opens a native session without submitting an initial model turn', async () => {
    await runner.start(session, undefined)
    expect(providerSessions).toEqual([])
    expect(messages.map((m) => m.item)).toEqual([{ kind: 'mode', mode: 'default', autoAvailable: false }])
    expect(statuses).toEqual(['running'])

    const nativeInit = { type: 'system', subtype: 'init', session_id: 'idle-native-id' }
    queries[0].emit(nativeInit)
    await until(() => providerSessions.length === 1)
    expect(providerSessions).toEqual([{ sessionId: session.id, id: 'idle-native-id', transcriptPath: null }])

    await runner.send(session.id, 'first turn after native init')
    await until(() => queries[0]?.written.length === 1)
    expect(queries[0]?.written[0]?.session_id).toBe('idle-native-id')
    expect(queries[0]?.written[0]?.message).toEqual({
      role: 'user',
      content: 'first turn after native init'
    })
  })


  test('passes the prepared account environment to Claude Code', async () => {
    await runner.start(session, 'hello', { env: { CLAUDE_CONFIG_DIR: '/managed/claude' } })

    expect(queries[0]?.params.options?.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/managed/claude' })
  })

  test('journals the prompt, sets working and returns before the session ends', async () => {
    await begin('do it')
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ sessionId: 's_1', role: 'user', text: 'do it' })
    expect(statuses).toEqual(['working'])
  })

  test('a stop that arrives while the claude path is resolving prevents the query from starting', async () => {
    let release: (path: string) => void = () => {}
    const resolving = new Promise<string>((resolve) => {
      release = resolve
    })
    const slow = createClaudeRunner(
      { ...makeContext(), resolveClaudePath: () => resolving },
      {
        query: (params: ClaudeQueryParams) => {
          const query = new FakeQuery(params)
          queries.push(query)
          return query
        }
      }
    )
    const starting = slow.start(session, 'hello')
    await tick()
    await slow.stop(session.id)
    release('/usr/local/bin/claude')
    await starting
    await tick()
    expect(queries).toHaveLength(0)
    expect(messages).toHaveLength(0)
    expect(statuses).not.toContain('working')
    await expect(slow.send(session.id, 'late')).rejects.toThrow()
  })

  test('rejects agents other than claude', async () => {
    await expect(runner.start({ ...session, agent: 'codex' }, 'x')).rejects.toThrow(
      'structured sessions support claude only'
    )
    expect(queries).toHaveLength(0)
  })
})

describe('journaling', () => {
  test('system init, assistant text, tool use, tool result and result', async () => {
    const query = await begin()
    const init = { type: 'system', subtype: 'init', session_id: 'c1', model: 'm' }
    query.emit(init)
    const toolUse = { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }
    const assistant = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi ' }, { type: 'text', text: 'there' }, toolUse] },
      session_id: 'c1'
    }
    query.emit(assistant)
    const toolResult = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }] },
      session_id: 'c1'
    }
    query.emit(toolResult)
    const result = {
      type: 'result',
      subtype: 'success',
      result: 'All done',
      is_error: false,
      total_cost_usd: 0.0123,
      duration_ms: 2100,
      session_id: 'c1'
    }
    query.emit(result)
    await until(() => messages.length === 7)

    expect(messages.slice(2).map((m) => m.role)).toEqual(['system', 'assistant', 'tool', 'tool', 'result'])
    expect(messages[2].data).toEqual(init)
    expect(messages[3]).toMatchObject({ text: 'Hi there', data: assistant })
    expect(messages[4]).toMatchObject({ text: 'Bash: ls -la', data: toolUse })
    expect(messages[5].text).toContain('file.txt')
    expect(messages[5].data).toEqual(toolResult)
    expect(messages[6].text).toContain('All done')
    expect(messages[6].text).toContain('$0.0123')
    expect(messages[6].text).toContain('2.1s')
    expect(messages[6].data).toEqual(result)
  })

  test('result without cost or duration is just the summary', async () => {
    const query = await begin()
    query.emit({ type: 'result', subtype: 'success', result: 'Fine', is_error: false })
    await until(() => messages.length === 3)
    expect(messages[2]).toMatchObject({ role: 'result', text: 'Fine' })
  })

  test('error results report their subtype and errors', async () => {
    const query = await begin()
    query.emit({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too long'] })
    await until(() => messages.length === 3)
    expect(messages[2].role).toBe('result')
    expect(messages[2].text).toContain('error_max_turns')
    expect(messages[2].text).toContain('too long')
  })
})

describe('status', () => {
  test('working while a turn runs, done on result, working again on send', async () => {
    const query = await begin()
    query.emit(assistantText('x'))
    query.emit({ type: 'result', subtype: 'success', result: 'ok', is_error: false })
    await until(() => statuses.includes('done'))
    expect(statuses).toEqual(['working', 'done'])
    await runner.send('s_1', 'more')
    expect(statuses).toEqual(['working', 'done', 'working'])
  })

  const success = { type: 'result', subtype: 'success', result: 'ok', is_error: false }
  const turnEnds = () => messages.filter((m) => (m.item as any)?.kind === 'turn-end')

  test('a queued second send keeps the session working after the first result', async () => {
    const query = await begin()
    await runner.send('s_1', 'and then this')
    query.emit(assistantText('first'))
    query.emit(success)
    await until(() => turnEnds().length === 1)
    expect(statuses.at(-1)).toBe('working')
    expect(statuses).not.toContain('done')
    query.emit(assistantText('second'))
    query.emit(success)
    await until(() => statuses.at(-1) === 'done')
    expect(turnEnds()).toHaveLength(2)
  })

  test('a turn Claude starts by itself after a result shows working until its own result', async () => {
    const query = await begin()
    query.emit(success)
    await until(() => statuses.at(-1) === 'done')
    // a background task finishing re-invokes the model with no send from Quirky
    query.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } })
    query.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'ls' } }] } })
    await until(() => statuses.at(-1) === 'working')
    query.emit({ ...success, duration_ms: 1200 })
    await until(() => statuses.at(-1) === 'done')
    expect(statuses).toEqual(['working', 'done', 'working', 'done'])
    expect(turnEnds()).toHaveLength(2)
    expect(messages.find((m) => (m.item as any)?.callId === 't9' && (m.item as any)?.state === 'done')).toBeDefined()
  })

  test('a self-started turn can be interrupted', async () => {
    const query = await begin()
    query.emit(success)
    await until(() => statuses.at(-1) === 'done')
    query.emit(assistantText('on my own'))
    await until(() => statuses.at(-1) === 'working')
    await runner.interrupt('s_1')
    expect(query.interrupted).toBe(1)
    expect(statuses.at(-1)).toBe('done')
    expect((turnEnds().at(-1)?.item as any)?.state).toBe('stopped')
  })

  test('subagent output after a result does not reopen the turn', async () => {
    const query = await begin()
    query.emit(success)
    await until(() => statuses.at(-1) === 'done')
    query.emit({ ...assistantText('sub'), parent_tool_use_id: 'task_1' })
    await tick()
    expect(statuses.at(-1)).toBe('done')
  })

  test("Claude's running and idle signals open and close the turn", async () => {
    const query = await begin()
    query.emit(success)
    await until(() => statuses.at(-1) === 'done')
    query.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    await until(() => statuses.at(-1) === 'working')
    query.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await until(() => statuses.at(-1) === 'done')
    expect(messages.some((m) => m.text.includes('session_state_changed'))).toBe(false)
  })

  test('idle ends the wait when Claude folded a queued send into the running turn', async () => {
    const query = await begin()
    await runner.send('s_1', 'steer')
    query.emit(success)
    await until(() => turnEnds().length === 1)
    expect(statuses.at(-1)).toBe('working')
    query.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    await until(() => statuses.at(-1) === 'done')
    await runner.interrupt('s_1')
    expect(query.interrupted).toBe(0)
  })

  test('asks Claude to report its running and idle state', async () => {
    await begin()
    expect(queries[0]?.params.options?.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1')
  })


  test('failed results journal the error, tear down the query, and exit without publishing done', async () => {
    const query = await begin()
    const failure = { type: 'result', subtype: 'error_api_error', result: 'provider failed', is_error: true }
    query.emit(failure)
    await until(() => statuses.includes('exited'))
    expect(messages.at(-1)).toMatchObject({ role: 'result', text: 'provider failed', data: failure })
    await until(() => query.closed > 0)
    expect(query.closed).toBeGreaterThan(0)
    expect(statuses).toEqual(['working', 'exited'])
    await expect(runner.send('s_1', 'after failure')).rejects.toThrow()
  })

  test('exited when the query ends', async () => {
    const query = await begin()
    query.end()
    await until(() => statuses.includes('exited'))
    expect(statuses.at(-1)).toBe('exited')
  })

  test('exited with a system message when the query throws', async () => {
    const query = await begin()
    query.fail(new Error('claude crashed'))
    await until(() => statuses.includes('exited'))
    const last = messages.at(-1)!
    expect(last.role).toBe('system')
    expect(last.text).toContain('claude crashed')
  })
})

describe('canUseTool', () => {
  const canUse = (query: FakeQuery, tool = 'Bash', input: Record<string, unknown> = { command: 'ls' }) =>
    (query.params.options!.canUseTool as any)(tool, input, { signal: new AbortController().signal, toolUseID: 'tu' })

  test('AskUserQuestion returns a typed answer under the original question key, not an allow/deny tool choice', async () => {
    const query = await begin()
    const input = { questions: [{ question: 'Choose a destination', options: [{ label: 'Local' }, { label: 'Remote' }] }] }
    const pending = canUse(query, 'AskUserQuestion', input)
    await until(() => asks.length === 1)
    expect(asks[0].spec.questions[0]).toMatchObject({ id: 'q1', question: 'Choose a destination', type: 'select' })
    asks[0].resolve({ status: 'answered', askId: 'ask_native', answers: { q1: { value: 'o2', label: 'Remote', source: 'option' } }, skipped: [], summary: 'Remote' })
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Choose a destination': 'Remote' } } })
  })

  test('a secret native question never creates an Ask or a session-wide permission rule', async () => {
    const query = await begin()
    expect(await canUse(query, 'AskUserQuestion', { questions: [{ question: 'Which account?', isSecret: true }] })).toEqual({ behavior: 'deny', message: 'Denied from Quirky' })
    expect(asks).toEqual([])
  })

  test('asks one select question and allows with the original input', async () => {
    const query = await begin()
    const input = { command: 'rm -rf\n  build' }
    const pending = canUse(query, 'Bash', input)
    await until(() => asks.length === 1)
    expect(asks[0].sessionId).toBe('s_1')
    const [question] = asks[0].spec.questions
    expect(question).toMatchObject({ id: 'decision', type: 'select' })
    expect(question.question).toContain('Bash')
    expect(question.question).toContain('rm -rf build')
    expect(question.question).not.toContain('\n')
    expect((question as any).options.map((o: any) => o.value)).toEqual(['allow', 'always', 'deny'])
    expect(statuses.at(-1)).toBe('waiting')
    asks[0].resolve(envelope('answered', 'allow'))
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: input })
    expect(statuses.at(-1)).toBe('working')
  })

  test('deny', async () => {
    const query = await begin()
    const pending = canUse(query)
    await until(() => asks.length === 1)
    asks[0].resolve(envelope('answered', 'deny'))
    expect(await pending).toEqual({ behavior: 'deny', message: 'Denied from Quirky' })
  })

  test('the ask offers the three decisions with their labels and an optional reason', async () => {
    const query = await begin()
    const pending = canUse(query)
    await until(() => asks.length === 1)
    const [decision, reason] = asks[0].spec.questions as any[]
    expect(decision.options).toEqual([
      { value: 'allow', label: 'Allow once' },
      { value: 'always', label: 'Allow for this session' },
      { value: 'deny', label: 'Deny' }
    ])
    expect(reason).toEqual({ id: 'reason', type: 'text', question: 'Reason, if you deny', required: false })
    asks[0].resolve(envelope('answered', 'allow'))
    await pending
  })

  test('a deny reason becomes the denial message', async () => {
    const query = await begin()
    const pending = canUse(query)
    await until(() => asks.length === 1)
    asks[0].resolve(envelope('answered', 'deny', 'use the staging db'))
    expect(await pending).toEqual({ behavior: 'deny', message: 'use the staging db' })
  })

  test('a reason typed with an allow is ignored', async () => {
    const query = await begin()
    const pending = canUse(query)
    await until(() => asks.length === 1)
    asks[0].resolve(envelope('answered', 'allow', 'whatever'))
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
  })

  test('always allows and adds a session rule for the tool', async () => {
    const query = await begin()
    const pending = canUse(query, 'Edit', { file_path: '/a' })
    await until(() => asks.length === 1)
    asks[0].resolve(envelope('answered', 'always'))
    expect(await pending).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/a' },
      updatedPermissions: [
        { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' }
      ]
    })
  })

  test('declined and timed out asks deny', async () => {
    const query = await begin()
    for (const status of ['declined', 'timed_out'] as const) {
      const pending = canUse(query)
      await until(() => asks.length === (status === 'declined' ? 1 : 2))
      asks.at(-1)!.resolve(envelope(status))
      expect(await pending).toEqual({ behavior: 'deny', message: 'Denied from Quirky' })
    }
  })
})

describe('plan mode', () => {
  const canUse = (query: FakeQuery, tool: string, input: Record<string, unknown> = {}) =>
    (query.params.options!.canUseTool as any)(tool, input, { signal: new AbortController().signal, toolUseID: 'tu' })
  const items = () => messages.map((m) => m.item)
  const plans = () => items().filter((item): item is PlanItem => item?.kind === 'plan')
  const modes = () => items().filter((item) => item?.kind === 'mode')
  const answer = (decision: string, reason?: string) => envelope('answered', decision, reason)
  const withAuto = async (query: FakeQuery) => {
    query.initialization = { models: [{ value: 'opus', supportsAutoMode: true }] }
    query.emit({ type: 'system', subtype: 'init', session_id: 'c1', model: 'opus', permissionMode: 'plan' })
    await until(() => runner.autoAvailable!(session.id))
  }
  const present = async (query: FakeQuery, input: Record<string, unknown> = { plan: '# Plan\n- step' }) => {
    const before = asks.length
    const pending = canUse(query, 'ExitPlanMode', input)
    await until(() => asks.length === before + 1)
    return pending
  }

  describe('ExitPlanMode', () => {
    test('journals a waiting plan carrying the silent ask id', async () => {
      const query = await begin()
      const pending = present(query)
      await until(() => plans().length === 1)
      expect(asks[0]!.silent).toBe(true)
      expect((asks[0]!.spec.questions[0] as any).options.map((o: any) => o.value)).toEqual(['approve-auto', 'approve-review', 'keep'])
      expect(plans()[0]).toEqual({ kind: 'plan', version: 1, status: 'waiting', text: '# Plan\n- step', askId: 'ask_1' })
      expect(runner.planWaiting!(session.id)).toBe(true)
      expect(statuses.at(-1)).toBe('waiting')
      asks[0]!.resolve(answer('keep'))
      await pending
      expect(statuses.at(-1)).toBe('working')
    })

    test('approve with auto available allows and switches to auto in the same reply', async () => {
      const query = await begin()
      await withAuto(query)
      const pending = present(query)
      await until(() => asks.length === 1)
      asks[0]!.resolve(answer('approve-auto'))
      const input = { plan: '# Plan\n- step' }
      expect(await pending).toEqual({
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }]
      })
      const tail = items().slice(-2)
      expect(tail[0]).toEqual({ kind: 'plan', version: 1, status: 'approved', text: '# Plan\n- step', approvedMode: 'auto' })
      expect(tail[1]).toEqual({ kind: 'mode', mode: 'auto', autoAvailable: true })
      expect(runner.planWaiting!(session.id)).toBe(false)
    })

    test('approve with auto unavailable lands in accept edits', async () => {
      const query = await begin()
      const pending = present(query)
      asks[0]!.resolve(answer('approve-auto'))
      expect(await pending).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits' }] })
      expect(plans().at(-1)).toMatchObject({ status: 'approved', approvedMode: 'acceptEdits' })
      expect(modes().at(-1)).toEqual({ kind: 'mode', mode: 'acceptEdits', autoAvailable: false })
    })

    test('approve for review lands in ask mode', async () => {
      const query = await begin()
      await runner.configure!(session.id, { permissionMode: 'plan' })
      const pending = present(query)
      asks[0]!.resolve(answer('approve-review'))
      expect(await pending).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] })
      expect(plans().at(-1)).toMatchObject({ status: 'approved', approvedMode: 'default' })
      expect(modes().at(-1)).toMatchObject({ mode: 'default' })
    })

    test('keep planning denies with the reason, or a default, and stays in plan', async () => {
      const query = await begin()
      await runner.configure!(session.id, { permissionMode: 'plan' })
      const first = present(query)
      asks[0]!.resolve(answer('keep', 'Split step 2'))
      expect(await first).toEqual({ behavior: 'deny', message: 'Split step 2' })
      expect(plans().at(-1)).toMatchObject({ version: 1, status: 'not-answered', reason: 'feedback' })
      expect(plans().at(-1)).not.toHaveProperty('askId')
      const second = present(query)
      asks[1]!.resolve(answer('keep'))
      expect(await second).toEqual({ behavior: 'deny', message: 'Keep planning.' })
      expect(modes().at(-1)).toMatchObject({ mode: 'plan' })
    })

    test('planFeedback answers the waiting plan, cancels its ask and is one-shot', async () => {
      const query = await begin()
      const pending = present(query)
      await until(() => plans().length === 1)
      expect(runner.planFeedback!(session.id, 'Does this survive a restart?')).toBe(true)
      expect(runner.planFeedback!(session.id, 'again')).toBe(false)
      expect(await pending).toEqual({ behavior: 'deny', message: 'Does this survive a restart?' })
      expect(cancelled).toEqual(['ask_1'])
      expect(plans().at(-1)).toMatchObject({ version: 1, status: 'not-answered', reason: 'feedback' })
    })

    test('an empty feedback text still keeps planning', async () => {
      const query = await begin()
      const pending = present(query)
      await until(() => plans().length === 1)
      runner.planFeedback!(session.id, '  ')
      expect(await pending).toEqual({ behavior: 'deny', message: 'Keep planning.' })
    })

    test('planFeedback is false with no waiting plan or an unknown session', async () => {
      await begin()
      expect(runner.planFeedback!(session.id, 'hi')).toBe(false)
      expect(runner.planFeedback!('s_none', 'hi')).toBe(false)
      expect(runner.planWaiting!('s_none')).toBe(false)
    })

    test('stop leaves the plan not answered and never allows it', async () => {
      const query = await begin()
      const pending = present(query)
      await until(() => plans().length === 1)
      await runner.stop(session.id)
      expect(await pending).toEqual({
        behavior: 'deny',
        message: 'The user stopped before answering. The plan was not approved; stay in plan mode.'
      })
      expect(plans().at(-1)).toMatchObject({ version: 1, status: 'not-answered', reason: 'stopped' })
      expect(cancelled).toEqual(['ask_1'])
    })

    test('interrupt leaves the plan not answered', async () => {
      const query = await begin()
      const pending = present(query)
      await until(() => plans().length === 1)
      await runner.interrupt(session.id)
      expect(await pending).toMatchObject({ behavior: 'deny' })
      expect(plans().at(-1)).toMatchObject({ status: 'not-answered', reason: 'stopped' })
    })

    test('a manual mode switch denies the plan first, then switches', async () => {
      const query = await begin()
      await runner.configure!(session.id, { permissionMode: 'plan' })
      const pending = present(query)
      await until(() => plans().length === 1)
      query.permissionModes.length = 0
      const switching = runner.configure!(session.id, { permissionMode: 'acceptEdits' })
      expect(await pending).toEqual({
        behavior: 'deny',
        message: 'The user switched to Accept edits mode. The plan was not approved.'
      })
      expect(await switching).toMatchObject({ permissionMode: 'acceptEdits' })
      expect(query.permissionModes).toEqual(['acceptEdits'])
      expect(plans().at(-1)).toMatchObject({ version: 1, status: 'not-answered', reason: 'mode-switch' })
      const kinds = items().slice(-2).map((item) => item!.kind)
      expect(kinds).toEqual(['plan', 'mode'])
      expect(cancelled).toEqual(['ask_1'])
    })

    test('picking plan while a plan waits does not disturb it', async () => {
      const query = await begin()
      await runner.configure!(session.id, { permissionMode: 'plan' })
      const pending = present(query)
      await until(() => plans().length === 1)
      await runner.configure!(session.id, { permissionMode: 'plan' })
      expect(runner.planWaiting!(session.id)).toBe(true)
      asks[0]!.resolve(answer('keep'))
      await pending
    })

    test('a newer version revises the earlier one and counts on', async () => {
      const query = await begin()
      const first = present(query, { plan: 'one' })
      asks[0]!.resolve(answer('keep', 'more'))
      await first
      const second = present(query, { plan: 'two' })
      await until(() => plans().length === 4)
      expect(plans().map((p) => [p.version, p.status])).toEqual([[1, 'waiting'], [1, 'not-answered'], [1, 'revised'], [2, 'waiting']])
      expect(plans()[2]).toMatchObject({ text: 'one', reason: 'feedback' })
      expect(plans()[2]).not.toHaveProperty('unchanged')
      expect(plans()[3]).toEqual({ kind: 'plan', version: 2, status: 'waiting', text: 'two', askId: 'ask_2' })
      asks[1]!.resolve(answer('keep'))
      await second
    })

    test('presenting the same text again is marked unchanged', async () => {
      const query = await begin()
      const first = present(query, { plan: 'same' })
      asks[0]!.resolve(answer('keep'))
      await first
      const second = present(query, { plan: 'same' })
      await until(() => plans().at(-1)?.status === 'waiting')
      expect(plans().at(-1)).toMatchObject({ version: 2, unchanged: true })
      asks[1]!.resolve(answer('keep'))
      await second
    })

    test('an empty plan is never approved', async () => {
      const query = await begin()
      const pending = present(query, { plan: '' })
      await until(() => plans().length === 1)
      expect(plans()[0]).toMatchObject({ empty: true, text: '' })
      asks[0]!.resolve(answer('approve-auto'))
      expect(await pending).toEqual({ behavior: 'deny', message: 'The plan was empty. Present the plan again.' })
      expect(plans().at(-1)).toMatchObject({ status: 'not-answered', reason: 'feedback', empty: true })
      expect(plans().some((p) => p.status === 'approved')).toBe(false)
    })

    test('anything but an answered approve fails closed', async () => {
      const query = await begin()
      const unanswered: AskEnvelope[] = [
        envelope('declined'),
        envelope('timed_out'),
        envelope('partial'),
        envelope('answered'),
        { status: 'unavailable', askId: 'a_1', answers: {}, skipped: [], summary: '', reason: 'no ui' }
      ]
      for (const result of unanswered) {
        const pending = present(query)
        asks.at(-1)!.resolve(result)
        expect(await pending).toEqual({
          behavior: 'deny',
          message: 'The user stopped before answering. The plan was not approved; stay in plan mode.'
        })
        expect(plans().at(-1)).toMatchObject({ status: 'not-answered', reason: 'stopped' })
      }
    })

    test('a failing ask denies instead of throwing', async () => {
      const broken = createClaudeRunner(
        { ...makeContext(), createAsk: () => Promise.reject(new Error('ask owner gone')) },
        { plansDir, query: (params) => (queries.push(new FakeQuery(params)), queries.at(-1)!) }
      )
      await broken.start({ ...session, id: 's_2' }, 'hello')
      const result = await canUse(queries.at(-1)!, 'ExitPlanMode', { plan: 'x' })
      expect(result).toMatchObject({ behavior: 'deny' })
      expect(plans().at(-1)).toMatchObject({ status: 'not-answered', reason: 'stopped' })
    })

    test('the plan file text wins, with the checked path on the item', async () => {
      const query = await begin()
      const file = join(plansDir, 'calm-plan.md')
      writeFileSync(file, '# From file')
      const pending = present(query, { planFilePath: file, plan: 'stale inline' })
      await until(() => plans().length === 1)
      expect(plans()[0]).toMatchObject({ text: '# From file', filePath: file })
      asks[0]!.resolve(answer('keep'))
      await pending
    })

    test('a plan file outside the plans directory is ignored', async () => {
      const query = await begin()
      const outside = mkdtempSync(join(tmpdir(), 'outside-'))
      writeFileSync(join(outside, 'secret.md'), 'secret')
      const pending = present(query, { planFilePath: join(outside, 'secret.md'), plan: 'inline' })
      await until(() => plans().length === 1)
      expect(plans()[0]).toMatchObject({ text: 'inline' })
      expect(plans()[0]).not.toHaveProperty('filePath')
      asks[0]!.resolve(answer('keep'))
      await pending
      rmSync(outside, { recursive: true, force: true })
    })

    test('a plan file that still holds the previous plan yields to newer inline text', async () => {
      const query = await begin()
      const file = join(plansDir, 'a.md')
      writeFileSync(file, 'first')
      const one = present(query, { planFilePath: file, plan: 'first' })
      asks[0]!.resolve(answer('keep'))
      await one
      const two = present(query, { planFilePath: file, plan: 'second' })
      await until(() => plans().at(-1)?.status === 'waiting')
      expect(plans().at(-1)).toMatchObject({ version: 2, text: 'second' })
      asks[1]!.resolve(answer('keep'))
      await two
    })

    test('a resumed session continues numbering and revises the restarted plan', async () => {
      const restarted: PlanItem = { kind: 'plan', version: 2, status: 'not-answered', text: 'old', reason: 'restarted' }
      await runner.start(session, undefined, { permissionMode: 'plan', planVersion: 2, lastPlanText: 'old', lastPlan: restarted })
      const query = queries[0]!
      expect(messages.at(-1)!.item).toEqual({ kind: 'mode', mode: 'plan', autoAvailable: false })
      const pending = present(query, { plan: 'old' })
      await until(() => plans().length === 2)
      expect(plans()[0]).toEqual({ kind: 'plan', version: 2, status: 'revised', text: 'old', reason: 'restarted' })
      expect(plans()[1]).toMatchObject({ version: 3, status: 'waiting', unchanged: true })
      asks[0]!.resolve(answer('keep'))
      await pending
    })

    test('an approved version is not revised by the next one', async () => {
      const query = await begin()
      const one = present(query, { plan: 'one' })
      asks[0]!.resolve(answer('approve-review'))
      await one
      const two = present(query, { plan: 'two' })
      await until(() => plans().at(-1)?.version === 2)
      expect(plans().filter((p) => p.status === 'revised')).toEqual([])
      asks[1]!.resolve(answer('keep'))
      await two
    })
  })

  describe('EnterPlanMode', () => {
    test('is allowed without an ask and journals the plan mode', async () => {
      const query = await begin()
      expect(await canUse(query, 'EnterPlanMode', {})).toEqual({ behavior: 'allow', updatedInput: {} })
      expect(asks).toEqual([])
      expect(modes().at(-1)).toEqual({ kind: 'mode', mode: 'plan', autoAvailable: false })
      const count = modes().length
      await canUse(query, 'EnterPlanMode', {})
      expect(modes()).toHaveLength(count)
    })
  })

  describe('reported mode', () => {
    test('init and status reports journal a mode change once', async () => {
      const query = await begin()
      const before = modes().length
      query.emit({ type: 'system', subtype: 'init', session_id: 'c1', permissionMode: 'default' })
      query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits', session_id: 'c1' })
      query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits', session_id: 'c1' })
      query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'bypassPermissions', session_id: 'c1' })
      query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan', session_id: 'c1' })
      await until(() => modes().length === before + 3)
      await tick()
      expect(modes().slice(before)).toEqual([
        { kind: 'mode', mode: 'acceptEdits', autoAvailable: false },
        { kind: 'mode', mode: 'bypassPermissions', autoAvailable: false },
        { kind: 'mode', mode: 'plan', autoAvailable: false }
      ])
    })

    test('a status that only carries the mode adds no status row', async () => {
      const query = await begin()
      query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan', session_id: 'c1' })
      await until(() => modes().length === 2)
      expect(items().filter((item) => item?.kind === 'status')).toEqual([])
    })

    test('ExitPlanMode and EnterPlanMode calls and results add no activity rows', async () => {
      const query = await begin()
      query.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x1', name: 'ExitPlanMode', input: { plan: 'p' } }] } })
      query.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'ok' }] } })
      query.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x2', name: 'EnterPlanMode', input: {} }] } })
      query.emit({ type: 'result', subtype: 'success', result: 'ok', is_error: false })
      await until(() => items().some((item) => item?.kind === 'turn-end'))
      expect(items().filter((item) => item?.kind === 'activity')).toEqual([])
    })

    test('Auto refused after an approval corrects to accept edits and says so', async () => {
      const query = await begin()
      await withAuto(query)
      const pending = present(query)
      asks[0]!.resolve(answer('approve-auto'))
      await pending
      query.permissionModes.length = 0
      query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'default', session_id: 'c1' })
      await until(() => items().some((item) => item?.kind === 'prose' && item.text === "Auto mode isn't available. Using Accept edits."))
      expect(query.permissionModes).toEqual(['acceptEdits'])
      expect(runner.autoAvailable!(session.id)).toBe(false)
      expect(items().slice(-3)).toEqual([
        { kind: 'plan', version: 1, status: 'approved', text: '# Plan\n- step', approvedMode: 'acceptEdits' },
        { kind: 'mode', mode: 'acceptEdits', autoAvailable: false },
        { kind: 'prose', text: "Auto mode isn't available. Using Accept edits." }
      ])
    })

    test('a failed fallback switch journals the mode Claude reported and says so', async () => {
      const query = await begin()
      await withAuto(query)
      const pending = present(query)
      asks[0]!.resolve(answer('approve-auto'))
      await pending
      query.refusedPermissionMode = { mode: 'acceptEdits', message: 'switch failed' }
      query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'default', session_id: 'c1' })
      await until(() => items().some((item) => item?.kind === 'prose' && item.text.includes('failed')))
      expect(modes().at(-1)).toEqual({ kind: 'mode', mode: 'default', autoAvailable: false })
      expect(modes().some((item) => item?.kind === 'mode' && item.mode === 'acceptEdits')).toBe(false)
    })

    test('Claude re-entering plan after Auto was honoured is not treated as a refusal', async () => {
      const query = await begin()
      await withAuto(query)
      const pending = present(query)
      asks[0]!.resolve(answer('approve-auto'))
      await pending
      query.permissionModes.length = 0
      query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'auto', session_id: 'c1' })
      query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan', session_id: 'c1' })
      await until(() => modes().at(-1)?.mode === 'plan')
      expect(query.permissionModes).toEqual([])
    })

    test('a second ExitPlanMode closes the first and leaves only the newer plan answerable', async () => {
      const query = await begin()
      const first = present(query)
      await until(() => asks.length === 1)
      const second = canUse(query, 'ExitPlanMode', { plan: '# Revised' })
      expect(await first).toMatchObject({ behavior: 'deny' })
      await until(() => asks.length === 2)
      expect(runner.planWaiting!(session.id)).toBe(true)
      asks[1]!.resolve(answer('approve-review'))
      expect(await second).toMatchObject({ behavior: 'allow' })
      const states = plans().map((item) => [item.version, item.status])
      expect(states).toContainEqual([1, 'revised'])
      expect(states).toContainEqual([2, 'approved'])
      expect(states).not.toContainEqual([1, 'approved'])
    })

    test('three overlapping ExitPlanMode calls leave only the newest approvable', async () => {
      const query = await begin()
      const first = present(query)
      await until(() => asks.length === 1)
      const second = canUse(query, 'ExitPlanMode', { plan: '# B' })
      const third = canUse(query, 'ExitPlanMode', { plan: '# C' })
      expect(await first).toMatchObject({ behavior: 'deny' })
      expect(await second).toMatchObject({ behavior: 'deny' })
      await until(() => asks.length === 2)
      await tick()
      expect(asks).toHaveLength(2)
      asks[1]!.resolve(answer('approve-review'))
      expect(await third).toMatchObject({ behavior: 'allow', updatedInput: { plan: '# C' } })
      const states = plans().map((item) => [item.version, item.status])
      expect(states).toContainEqual([1, 'revised'])
      expect(states).toContainEqual([2, 'approved'])
      expect(states.filter(([, status]) => status === 'approved')).toHaveLength(1)
    })

    test('an interrupt while a second call is queued denies it without a new plan or ask', async () => {
      const query = await begin()
      const first = present(query)
      await until(() => asks.length === 1)
      const second = canUse(query, 'ExitPlanMode', { plan: '# B' })
      await runner.interrupt(session.id)
      expect(await first).toMatchObject({ behavior: 'deny' })
      expect(await second).toMatchObject({ behavior: 'deny', message: expect.stringContaining('stopped') })
      await tick()
      expect(asks).toHaveLength(1)
      expect(plans().some((item) => item.text === '# B')).toBe(false)
      expect(runner.planWaiting!(session.id)).toBe(false)
    })

    describe('overlapping calls', () => {
      type Ending = { name: string; queued: boolean; run: () => Promise<void>; final: Partial<PlanItem> | null; result: Record<string, unknown> }
      const endings: Ending[] = [
        {
          name: 'approve-auto on the newest',
          queued: false,
          run: async () => void asks.at(-1)!.resolve(answer('approve-auto')),
          final: { status: 'approved', approvedMode: 'acceptEdits' },
          result: { behavior: 'allow' }
        },
        {
          name: 'keep with feedback',
          queued: false,
          run: async () => void asks.at(-1)!.resolve(answer('keep', 'tighten it')),
          final: { status: 'not-answered', reason: 'feedback' },
          result: { behavior: 'deny', message: 'tighten it' }
        },
        {
          name: 'interrupt while a call is queued',
          queued: true,
          run: () => runner.interrupt(session.id),
          final: null,
          result: { behavior: 'deny', message: expect.stringContaining('stopped') }
        },
        {
          name: 'interrupt while the newest waits',
          queued: false,
          run: () => runner.interrupt(session.id),
          final: { status: 'not-answered', reason: 'stopped' },
          result: { behavior: 'deny', message: expect.stringContaining('stopped') }
        },
        {
          name: 'stop while a call is queued',
          queued: true,
          run: () => runner.stop(session.id),
          final: null,
          result: { behavior: 'deny', message: expect.stringContaining('stopped') }
        },
        {
          name: 'mode switch while the newest waits',
          queued: false,
          run: () => runner.configure!(session.id, { permissionMode: 'acceptEdits' }).then(() => {}),
          final: { status: 'not-answered', reason: 'mode-switch' },
          result: { behavior: 'deny', message: expect.stringContaining('not approved') }
        }
      ]
      const finalStatuses = () => {
        const last = new Map<number, PlanItem>()
        for (const item of plans()) last.set(item.version, item)
        return last
      }
      const liveAsks = () => asks.filter((ask) => !cancelled.includes(ask.askId) && !resolvedAsks.has(ask.askId))
      const resolvedAsks = new Set<string>()

      for (const calls of [1, 2, 3]) {
        for (const ending of endings) {
          if (ending.queued && calls === 1) continue
          test(`${calls} call(s), ${ending.name}`, async () => {
            resolvedAsks.clear()
            const query = await begin()
            await runner.configure!(session.id, { permissionMode: 'plan' })
            const pending = Array.from({ length: calls }, (_, i) => canUse(query, 'ExitPlanMode', { plan: `# Plan ${i + 1}` }))
            if (ending.queued) {
              // ended before the first plan unwinds, so the later calls are still queued
              expect(asks).toHaveLength(1)
              await ending.run()
            } else {
              await until(() => asks.length === Math.min(calls, 2))
              await tick()
              expect(liveAsks()).toHaveLength(1)
              expect(liveAsks()[0]!.askId).toBe(asks.at(-1)!.askId)
              await ending.run()
            }
            const results = await Promise.all(pending)
            await tick()

            const last = finalStatuses()
            expect(runner.planWaiting!(session.id)).toBe(false)
            expect([...last.values()].filter((item) => item.status === 'waiting')).toEqual([])
            if (ending.queued) {
              expect([...last.values()].map((item) => [item.version, item.status, item.reason])).toEqual([[1, 'not-answered', 'stopped']])
              expect(asks).toHaveLength(1)
              expect(results[0]).toMatchObject({ behavior: 'deny', message: expect.stringContaining('newer plan') })
              for (const result of results.slice(1)) expect(result).toMatchObject(ending.result)
            } else {
              const newest = Math.min(calls, 2)
              expect(last.size).toBe(newest)
              if (newest === 2) expect(last.get(1)!.status).toBe('revised')
              expect(last.get(newest)).toMatchObject(ending.final!)
              expect(results.at(-1)).toMatchObject(ending.result)
              for (const result of results.slice(0, -1)) expect(result).toMatchObject({ behavior: 'deny', message: expect.stringContaining('newer plan') })
              expect(results.filter((result: any) => result.behavior === 'allow')).toHaveLength(ending.result.behavior === 'allow' ? 1 : 0)
            }
          })
        }
      }
    })

    test('an approval into auto that Claude honours is left alone', async () => {
      const query = await begin()
      await withAuto(query)
      const pending = present(query)
      asks[0]!.resolve(answer('approve-auto'))
      await pending
      const before = messages.length
      query.permissionModes.length = 0
      query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'auto', session_id: 'c1' })
      await tick()
      expect(messages).toHaveLength(before)
      expect(query.permissionModes).toEqual([])
    })

    test('the pending approval is forgotten once the turn ends', async () => {
      const query = await begin()
      await withAuto(query)
      const pending = present(query)
      asks[0]!.resolve(answer('approve-auto'))
      await pending
      query.emit({ type: 'result', subtype: 'success', result: 'ok', is_error: false })
      await until(() => statuses.includes('done'))
      query.permissionModes.length = 0
      query.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan', session_id: 'c1' })
      await until(() => modes().at(-1)?.mode === 'plan')
      expect(query.permissionModes).toEqual([])
    })
  })

  describe('auto availability', () => {
    test('comes from the current model after init and is journaled on the mode item', async () => {
      const query = await begin()
      expect(runner.autoAvailable!(session.id)).toBe(false)
      await withAuto(query)
      expect(modes().at(-1)).toEqual({ kind: 'mode', mode: 'plan', autoAvailable: true })
    })

    test('is re-evaluated after the model changes', async () => {
      const query = await begin()
      query.initialization = { models: [{ value: 'opus', supportsAutoMode: true }, { value: 'haiku' }] }
      query.emit({ type: 'system', subtype: 'init', session_id: 'c1', model: 'opus', permissionMode: 'default' })
      await until(() => runner.autoAvailable!(session.id))
      await runner.configure!(session.id, { model: 'haiku' })
      expect(runner.autoAvailable!(session.id)).toBe(false)
      expect(modes().at(-1)).toEqual({ kind: 'mode', mode: 'default', autoAvailable: false })
      await runner.configure!(session.id, { model: 'opus' })
      expect(modes().at(-1)).toEqual({ kind: 'mode', mode: 'default', autoAvailable: true })
    })

    test('a failing initialization leaves auto unavailable', async () => {
      const query = await begin()
      query.initialization = null
      query.emit({ type: 'system', subtype: 'init', session_id: 'c1', model: 'opus', permissionMode: 'default' })
      await tick()
      await tick()
      expect(runner.autoAvailable!(session.id)).toBe(false)
    })
  })
})

describe('send', () => {
  test('pushes a user turn, journals it and sets working', async () => {
    const query = await begin()
    await runner.send('s_1', 'next please')
    await until(() => query.written.length === 2)
    expect(query.written[1]).toMatchObject({ type: 'user', message: { role: 'user', content: 'next please' } })
    expect(messages.at(-1)).toMatchObject({ role: 'user', text: 'next please' })
    expect(statuses.at(-1)).toBe('working')
  })

  test('throws for an unknown session', async () => {
    await expect(runner.send('s_nope', 'x')).rejects.toThrow()
  })

  test('throws once the session has been stopped', async () => {
    await begin()
    await runner.stop('s_1')
    await expect(runner.send('s_1', 'x')).rejects.toThrow()
  })

  test('throws once the query has ended', async () => {
    const query = await begin()
    query.end()
    await until(() => statuses.includes('exited'))
    await expect(runner.send('s_1', 'x')).rejects.toThrow()
  })
})

describe('stop', () => {
  test('interrupts, closes and sets exited once', async () => {
    const query = await begin()
    await runner.stop('s_1')
    expect(query.interrupted).toBe(1)
    expect(query.closed).toBe(1)
    await tick()
    expect(statuses.filter((s) => s === 'exited')).toHaveLength(1)
    expect(statuses.at(-1)).toBe('exited')
  })

  test('is a no-op for an unknown session', async () => {
    await runner.stop('s_nope')
    expect(statuses).toEqual([])
  })
})

describe('chat items', () => {
  const run = async (query: FakeQuery, ...events: any[]) => {
    for (const event of events) query.emit(event)
  }
  const items = () => messages.map((m) => m.item)

  test('every journaled message carries an item', async () => {
    const query = await begin('do it')
    await run(
      query,
      { type: 'system', subtype: 'init', session_id: 'c1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
      { type: 'weird' },
      { type: 'result', subtype: 'success', result: 'ok', is_error: false, duration_ms: 5 }
    )
    await until(() => messages.length === 8)
    expect(items().every((item) => item !== undefined)).toBe(true)
    expect(items().map((item) => item!.kind)).toEqual(['user', 'mode', 'status', 'prose', 'activity', 'activity', 'status', 'turn-end'])
    expect(items()[4]).toMatchObject({ callId: 't1', state: 'running' })
    expect(items()[5]).toMatchObject({ callId: 't1', state: 'done' })
    expect(items()[7]).toEqual({ kind: 'turn-end', state: 'done', durationMs: 5 })
  })

  test('sent messages carry their images and queue id', async () => {
    const query = await begin()
    const dir = mkdtempSync(join(tmpdir(), 'claude-img-'))
    const image = join(dir, 'a.png')
    writeFileSync(image, 'PNG')
    await runner.send('s_1', 'look', { images: [image], queuedId: 'q-1' })
    expect(messages.at(-1)!.item).toEqual({ kind: 'user', text: 'look', images: [image], queuedId: 'q-1' })
    await until(() => query.written.length === 2)
    expect(query.written[1].message.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('PNG').toString('base64') } }
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  test('an image sent with no text goes out as the image alone, without an empty text block', async () => {
    const query = await begin()
    const dir = mkdtempSync(join(tmpdir(), 'claude-img-'))
    const image = join(dir, 'a.png')
    writeFileSync(image, 'PNG')
    await runner.send('s_1', '', { images: [image] })
    await until(() => query.written.length === 2)
    expect(query.written[1].message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('PNG').toString('base64') } }
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  test('an image path that became a FIFO is refused without blocking', async () => {
    const query = await begin()
    const dir = mkdtempSync(join(tmpdir(), 'claude-fifo-'))
    const fifo = join(dir, 'a.png')
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
    const outcome = await Promise.race([
      runner.send('s_1', 'look', { images: [fifo] }).then(
        () => 'sent',
        (error: Error) => error.message
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 2000))
    ])
    expect(outcome).toContain('is not a regular file')
    expect(messages.filter((m) => m.item?.kind === 'user')).toHaveLength(1)
    expect(query.written).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })

  test('stopping mid-turn closes running calls as stopped, then ends the turn as stopped', async () => {
    const query = await begin()
    await run(query, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 9' } }, { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/a', old_string: 'a', new_string: 'b' } }] } })
    await until(() => messages.length === 4)
    await runner.stop('s_1')
    expect(items().slice(4).map((item) => item && [item.kind, (item as any).callId, (item as any).state])).toEqual([
      ['activity', 't1', 'stopped'],
      ['file-change', 't2', 'stopped'],
      ['turn-end', undefined, 'stopped']
    ])
  })

  test('stopping a turn sent before the earlier turn finished closes its calls and ends it as stopped', async () => {
    const query = await begin('first')
    await runner.send('s_1', 'second')
    await run(query, { type: 'result', subtype: 'success', result: 'first done', is_error: false })
    await until(() => items().some((item) => item?.kind === 'turn-end'))
    await run(query, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'Read', input: { file_path: '/a' } }] } })
    await until(() => items().some((item) => (item as any)?.callId === 't9'))
    await runner.stop('s_1')
    const tail = items().slice(-2).map((item) => item && [item.kind, (item as any).callId, (item as any).state])
    expect(tail).toEqual([
      ['activity', 't9', 'stopped'],
      ['turn-end', undefined, 'stopped']
    ])
  })

  test('a result for the last open turn leaves nothing to stop', async () => {
    const query = await begin('first')
    await runner.send('s_1', 'second')
    await run(query, { type: 'result', subtype: 'success', result: 'one', is_error: false })
    await run(query, { type: 'result', subtype: 'success', result: 'two', is_error: false })
    await until(() => items().filter((item) => item?.kind === 'turn-end').length === 2)
    const before = messages.length
    await runner.stop('s_1')
    expect(messages).toHaveLength(before)
  })

  test('stopping an idle session adds no turn-end', async () => {
    const query = await begin()
    await run(query, { type: 'result', subtype: 'success', result: 'ok', is_error: false })
    await until(() => statuses.includes('done'))
    const before = messages.length
    await runner.stop('s_1')
    expect(messages).toHaveLength(before)
  })

  test('a crash mid-turn ends the turn as failed and journals an error item', async () => {
    const query = await begin()
    await run(query, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } })
    await until(() => messages.length === 3)
    query.fail(new Error('claude crashed'))
    await until(() => statuses.includes('exited'))
    expect(items().slice(3).map((item) => item!.kind)).toEqual(['activity', 'turn-end', 'error'])
    expect(items().at(-1)).toEqual({ kind: 'error', reason: 'exited', stderrTail: ['claude crashed'], resumable: false })
  })

  test('partial-message deltas stream as throttled prose, and the final message supersedes them', async () => {
    const query = await begin()
    expect(query.params.options?.includePartialMessages).toBe(true)
    const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
    await run(query, delta('Hel'), { type: 'stream_event', event: { type: 'message_start' } })
    await tick()
    expect(messages.filter((m) => m.item?.kind === 'prose')).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 280))
    await run(query, delta('lo'))
    await tick()
    const streaming = messages.filter((m) => m.item?.kind === 'prose')
    expect(streaming).toHaveLength(1)
    expect(streaming[0]).toMatchObject({ role: 'system', item: { kind: 'prose', text: 'Hello', streaming: true } })
    await run(query, assistantText('Hello'))
    await until(() => messages.some((m) => m.role === 'assistant'))
    expect(messages.at(-1)!.item).toEqual({ kind: 'prose', text: 'Hello' })
  })
})

describe('interrupt', () => {
  const emit = async (query: FakeQuery, ...events: any[]) => {
    for (const event of events) query.emit(event)
    await tick()
  }
  const items = () => messages.map((m) => m.item) as any[]

  test('mid-turn it stops running calls, ends the turn as stopped and leaves the session able to send', async () => {
    const query = await begin()
    await emit(query, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 9' } }] } })
    await until(() => messages.length === 3)
    await runner.interrupt('s_1')
    expect(items().slice(3).map((item) => [item.kind, item.callId, item.state])).toEqual([
      ['activity', 't1', 'stopped'],
      ['turn-end', undefined, 'stopped']
    ])
    expect(query.interrupted).toBe(1)
    expect(query.closed).toBe(0)
    expect(statuses.at(-1)).toBe('done')
    expect(statuses).not.toContain('exited')
    await emit(query, { type: 'result', subtype: 'error_during_execution', is_error: true })
    expect(statuses).not.toContain('exited')
    await runner.send('s_1', 'again')
    expect(statuses.at(-1)).toBe('working')
    expect(query.written.at(-1).message.content).toBeDefined()
  })

  test('echoes of the interrupt after the turn closed journal nothing', async () => {
    const query = await begin()
    await emit(query, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/a/bye.txt', content: 'x' } }] } })
    await until(() => messages.length === 3)
    await runner.interrupt('s_1')
    const before = messages.length
    await emit(
      query,
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'The user doesn\'t want to proceed' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true }
    )
    expect(messages).toHaveLength(before)
    expect(items().filter((item) => item.callId === 't1').map((item) => item.state)).toEqual(['running', 'stopped'])
    expect(items().filter((item) => item.kind === 'turn-end')).toHaveLength(1)
    expect(items().some((item) => item.kind === 'user' && item.text.startsWith('[Request interrupted'))).toBe(false)
  })

  test('a second final for an already closed call emits nothing', async () => {
    const query = await begin()
    await emit(
      query,
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'late' }] } }
    )
    expect(items().filter((item) => item.callId === 't1').map((item) => item.state)).toEqual(['running', 'done'])
  })

  test('a live tool result still closes its call as failed', async () => {
    const query = await begin()
    await emit(
      query,
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'nope' }] } }
    )
    expect(items().filter((item) => item.callId === 't1').map((item) => item.state)).toEqual(['running', 'failed'])
  })

  test('with no open turn it does nothing', async () => {
    const query = await begin()
    await emit(query, { type: 'result', subtype: 'success', result: 'ok', is_error: false })
    await until(() => statuses.includes('done'))
    const before = messages.length
    const status = statuses.length
    await runner.interrupt('s_1')
    expect(messages).toHaveLength(before)
    expect(statuses).toHaveLength(status)
    expect(query.interrupted).toBe(0)
  })

  test('an interrupt the agent ignores falls back to a full stop', async () => {
    const query = await begin()
    query.hangInterrupt = true
    await runner.interrupt('s_1')
    expect(query.closed).toBe(1)
    expect(statuses.at(-1)).toBe('exited')
    expect(items().at(-1).state).toBe('stopped')
  })

  test('a pending approval resolving after the interrupt does not flip the session back to working', async () => {
    const query = await begin()
    const options = query.params.options as any
    const decision = options.canUseTool('Bash', { command: 'ls' })
    await until(() => asks.length === 1)
    await runner.interrupt('s_1')
    asks[0]!.resolve(envelope('declined'))
    await decision
    expect(statuses.at(-1)).toBe('done')
  })
})

describe('commands', () => {
  const LIST: ClaudeSlashCommand[] = [
    { name: 'compact', description: 'Free up context', argumentHint: '<instructions>', builtin: true },
    { name: 'simplify', description: 'Review the changed code', argumentHint: '', builtin: true },
    { name: '__remote-workflow', description: 'internal', argumentHint: '', builtin: true },
    { name: 'graphify', description: 'Build a knowledge graph', argumentHint: '' },
    { name: 'research', description: 'Research a repo (user)', argumentHint: '[topic]' },
    { name: 'quirk:brainstorming', description: '(quirk) Turn an idea into a design', argumentHint: '' },
    { name: 'claude.ai Notion:make-a-page (MCP)', description: 'Make a Notion page', argumentHint: '' }
  ]

  test('sorts the SDK list into built-in, skill, command, plugin and MCP entries before the first turn', () => {
    expect(claudeCommands(LIST, null)).toEqual([
      { name: 'compact', kind: 'builtin', description: 'Free up context', argumentHint: '<instructions>', startOnly: true },
      { name: 'simplify', kind: 'builtin', description: 'Review the changed code', startOnly: true },
      { name: 'graphify', kind: 'skill', description: 'Build a knowledge graph' },
      { name: 'research', kind: 'command', description: 'Research a repo', argumentHint: '[topic]' },
      { name: 'quirk:brainstorming', kind: 'plugin', description: 'Turn an idea into a design' },
      { name: 'mcp__claude_ai_Notion__make-a-page', kind: 'mcp', description: 'Make a Notion page' }
    ])
  })

  test('once init names the skills, a built-in skill can be used mid-message and init decides skill or command', () => {
    const sorted = claudeCommands(LIST, new Set(['simplify', 'research']))
    expect(sorted.find((command) => command.name === 'simplify')).toEqual({ name: 'simplify', kind: 'skill', description: 'Review the changed code' })
    expect(sorted.find((command) => command.name === 'research')?.kind).toBe('skill')
    expect(sorted.find((command) => command.name === 'graphify')?.kind).toBe('command')
  })

  function commandRunner(list: ClaudeSlashCommand[] | Promise<ClaudeSlashCommand[]>) {
    const reported: AgentCommand[][] = []
    const commandQueries: FakeQuery[] = []
    const withCommands = createClaudeRunner(
      { ...makeContext(), reportCommands: (_id, commands) => void reported.push(commands) },
      {
        query: (params: ClaudeQueryParams) => {
          const query = new FakeQuery(params)
          query.supportedCommands = () => Promise.resolve(list)
          commandQueries.push(query)
          return query
        }
      }
    )
    return { reported, commandQueries, withCommands }
  }

  test('reports the list as soon as the session opens, then refines it from init and follows commands_changed', async () => {
    const { reported, commandQueries, withCommands } = commandRunner(LIST)
    await withCommands.start(session, undefined)
    await until(() => reported.length === 1)
    expect(reported[0]!.map((command) => `${command.kind}:${command.name}`)).toContain('skill:graphify')
    commandQueries[0]!.emit({ type: 'system', subtype: 'init', session_id: 'c1', slash_commands: [], skills: ['simplify'] })
    await until(() => reported.length === 2)
    expect(reported[1]!.find((command) => command.name === 'simplify')?.kind).toBe('skill')
    expect(reported[1]!.find((command) => command.name === 'graphify')?.kind).toBe('command')
    commandQueries[0]!.emit({ type: 'system', subtype: 'commands_changed', session_id: 'c1', commands: [{ name: 'new-skill', description: 'Added', argumentHint: '' }] })
    await until(() => reported.length === 3)
    expect(reported[2]).toEqual([{ name: 'new-skill', kind: 'command', description: 'Added' }])
    await withCommands.stop(session.id)
  })

  test('a command picked mid-message opens the prompt Claude receives; the journal keeps what was typed', async () => {
    const { commandQueries, withCommands } = commandRunner(LIST)
    await withCommands.start(session, 'tidy this up /simplify please')
    await until(() => commandQueries[0]!.written.length === 1)
    expect(commandQueries[0]!.written[0]).toMatchObject({ message: { content: 'tidy this up /simplify please' } })
    await withCommands.send(session.id, 'fix the login /quirk:brainstorming focus on auth')
    await until(() => commandQueries[0]!.written.length === 2)
    expect(commandQueries[0]!.written[1]).toMatchObject({ message: { content: '/quirk:brainstorming fix the login focus on auth' } })
    expect(messages.filter((message) => message.role === 'user').map((message) => message.text)).toEqual([
      'tidy this up /simplify please',
      'fix the login /quirk:brainstorming focus on auth'
    ])
    await withCommands.stop(session.id)
  })

  test('messages wait for the command list and keep their order', async () => {
    const { promise, resolve } = Promise.withResolvers<ClaudeSlashCommand[]>()
    const { commandQueries, withCommands } = commandRunner(promise)
    await withCommands.start(session, 'one /graphify')
    await withCommands.send(session.id, 'two')
    await tick()
    expect(commandQueries[0]!.written).toEqual([])
    resolve(LIST)
    await until(() => commandQueries[0]!.written.length === 2)
    expect(commandQueries[0]!.written.map((message) => message.message.content)).toEqual(['/graphify one', 'two'])
    await withCommands.stop(session.id)
  })
})

describe('subagents', () => {
  const emit = async (query: FakeQuery, ...events: any[]) => {
    for (const event of events) query.emit(event)
    await tick()
  }
  const items = () => messages.map((m) => m.item) as any[]
  const agentItems = (id?: string) => items().filter((item) => item.kind === 'agent' && (id === undefined || item.id === id))
  const spawn = (id: string, parent: string | null = null, input: Record<string, unknown> = { subagent_type: 'Explore', description: 'look' }) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input }] },
    parent_tool_use_id: parent
  })
  const started = (taskId: string, spawnId: string, extra: Record<string, unknown> = {}) => ({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: spawnId,
    task_type: 'local_agent',
    description: 'd',
    ...extra
  })
  const canUseAs = (query: FakeQuery, agentID: string | undefined) =>
    (query.params.options!.canUseTool as any)('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tu', ...(agentID === undefined ? {} : { agentID }) })

  test('forwards subagent text and asks for AI progress summaries by default', async () => {
    const query = await begin()
    expect(query.params.options).toMatchObject({ forwardSubagentText: true, agentProgressSummaries: true })
  })

  test('the latest-tool setting turns progress summaries off and journals none', async () => {
    summariesSetting = 'latest-tool'
    runner = createClaudeRunner(makeContext(), { plansDir, query: (params) => (queries.push(new FakeQuery(params)), queries.at(-1)!) })
    const query = await begin()
    expect(query.params.options).toMatchObject({ forwardSubagentText: true, agentProgressSummaries: false })
    await emit(query, spawn('a1'), started('t1', 'a1'), { type: 'system', subtype: 'task_progress', task_id: 't1', usage: { total_tokens: 7 }, summary: 'AI line' })
    expect(agentItems('a1').at(-1)).toMatchObject({ tokens: 7 })
    expect(agentItems('a1').some((item) => item.summary !== undefined)).toBe(false)
  })

  test('a deny-all session gets neither subagent option', async () => {
    await runner.start(session, 'hello', { toolPolicy: 'deny-all' })
    expect(queries[0].params.options).not.toHaveProperty('forwardSubagentText')
    expect(queries[0].params.options).not.toHaveProperty('agentProgressSummaries')
  })

  test('streams each agent under its own key so a subagent never resets the main prose', async () => {
    const query = await begin()
    const delta = (text: string, parent: string | null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
    await emit(query, spawn('a1'), delta('main ', null), delta('sub ', 'a1'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    await emit(query, delta('more', null), delta('more', 'a1'))
    const streamed = items().filter((item) => item.kind === 'prose' && item.streaming)
    expect(streamed.map((item) => [item.text, item.agent])).toEqual([['main more', undefined], ['sub more', 'a1']])
    await emit(query, { ...assistantText('sub final'), parent_tool_use_id: 'a1' }, delta('next ', null))
    await new Promise((resolve) => setTimeout(resolve, 300))
    await emit(query, delta('x', null))
    expect(items().filter((item) => item.kind === 'prose' && item.streaming).at(-1)).toMatchObject({ text: 'main more' + 'next x' })
  })

  test('subagent messages never settle or end the parent turn, and a background agent survives the parent result', async () => {
    const query = await begin()
    await emit(
      query,
      spawn('a1'),
      started('t1', 'a1', { is_backgrounded: true }),
      { type: 'assistant', parent_tool_use_id: 'a1', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Bash', input: { command: 'sleep 9' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'm1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'result', subtype: 'success', result: 'ok' }
    )
    const calls = items().filter((item) => item.kind === 'activity')
    expect(calls.filter((item) => item.callId === 'r1').map((item) => item.state)).toEqual(['running'])
    expect(calls.filter((item) => item.callId === 'm1').map((item) => item.state)).toEqual(['running', 'done'])
    expect(agentItems('a1').at(-1).state).toBe('working')
    expect(statuses.at(-1)).toBe('done')
  })

  test('task events stop producing status lines for agents but local_bash keeps its line', async () => {
    const query = await begin()
    await emit(query, spawn('a1'), started('t1', 'a1'), { type: 'system', subtype: 'task_started', task_id: 'b1', task_type: 'local_bash' })
    const statusTexts = items().filter((item) => item.kind === 'status').map((item) => item.text)
    expect(statusTexts.filter((text) => text.startsWith('system: task_'))).toEqual(['system: task_started'])
  })

  test('stopAgent stops the agent and its live descendants deepest first, journals them stopped, and keeps the turn open', async () => {
    const query = await begin()
    await emit(query, spawn('a1'), started('t1', 'a1'), spawn('a2', 'a1'), started('t2', 'a2'), spawn('a3', 'a2'), started('t3', 'a3'), spawn('b1'), started('tb', 'b1'))
    await runner.stopAgent!('s_1', 'a1')
    expect(query.stoppedTasks).toEqual(['t3', 't2', 't1'])
    expect(agentItems().slice(-3).map((item) => [item.id, item.state])).toEqual([['a3', 'stopped'], ['a2', 'stopped'], ['a1', 'stopped']])
    expect(agentItems('b1').at(-1).state).toBe('working')
    expect(items().some((item) => item.kind === 'turn-end')).toBe(false)
    const before = messages.length
    await runner.stopAgent!('s_1', 'a1')
    await runner.stopAgent!('s_1', 'nobody')
    expect(messages.length).toBe(before)
    expect(query.stoppedTasks).toHaveLength(3)
  })

  test('stopAgent keeps an agent live and rejects when the SDK cannot stop it, so Stop can be retried', async () => {
    const query = await begin()
    await emit(query, spawn('a1'), started('t1', 'a1'), spawn('a2', 'a1'), started('t2', 'a2'))
    query.failingTasks.add('t2')
    await expect(runner.stopAgent!('s_1', 'a1')).rejects.toThrow('could not stop t2')
    expect(agentItems('a2').at(-1).state).toBe('working')
    expect(agentItems('a1').at(-1).state).toBe('stopped')
    query.failingTasks.clear()
    await runner.stopAgent!('s_1', 'a2')
    expect(agentItems('a2').at(-1).state).toBe('stopped')
  })

  test('interrupt still ends the turn when stopping an agent fails', async () => {
    const query = await begin()
    await emit(query, spawn('a1'), started('t1', 'a1', { is_backgrounded: true }))
    query.failingTasks.add('t1')
    await runner.interrupt('s_1')
    expect(agentItems('a1').at(-1).state).toBe('working')
    expect(items().some((item) => item.kind === 'turn-end' && item.state === 'stopped')).toBe(true)
    expect(query.interrupted).toBe(1)
  })

  test('interrupt stops every live agent, background ones included, before ending the turn', async () => {
    const query = await begin()
    await emit(query, spawn('a1'), started('t1', 'a1', { is_backgrounded: true }), spawn('b1'), started('tb', 'b1'))
    await runner.interrupt('s_1')
    expect(query.stoppedTasks.sort()).toEqual(['t1', 'tb'])
    const kinds = items().map((item) => item.kind + (item.state ? `:${item.state}` : ''))
    expect(kinds.lastIndexOf('agent:stopped')).toBeLessThan(kinds.indexOf('turn-end:stopped'))
    expect(query.interrupted).toBe(1)
  })

  test('run end journals live agents as stopped and cut off', async () => {
    const query = await begin()
    await emit(query, spawn('a1'), started('t1', 'a1'), { type: 'assistant', parent_tool_use_id: 'a1', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Bash', input: { command: 'x' } }] } })
    query.end()
    await until(() => statuses.at(-1) === 'exited')
    expect(agentItems('a1').at(-1)).toMatchObject({ state: 'stopped', cutOff: true })
    expect(items().filter((item) => item.callId === 'r1').at(-1)).toMatchObject({ state: 'failed', agent: 'a1' })
  })

  test('stop journals live agents as cut off', async () => {
    const query = await begin()
    await emit(query, spawn('a1'), started('t1', 'a1'))
    await runner.stop('s_1')
    expect(agentItems('a1').at(-1)).toMatchObject({ state: 'stopped', cutOff: true })
  })

  test('canUseTool from a subagent labels the ask and flips needs-you then back to working', async () => {
    const query = await begin()
    await emit(query, spawn('a1'), started('t1', 'a1'))
    const pending = canUseAs(query, 't1')
    await until(() => asks.length === 1)
    expect(asks[0].from).toBe('a1')
    expect(asks[0].spec.title).toBe('Explore asks')
    expect(agentItems('a1').at(-1).state).toBe('needs-you')
    asks[0].resolve(envelope('answered', 'allow'))
    await pending
    expect(agentItems('a1').at(-1).state).toBe('working')
  })

  test('canUseTool maps the AgentOutput agentId too, and a main-agent ask stays unlabeled', async () => {
    const query = await begin()
    await emit(query, spawn('a1'), started('t1', 'a1'), {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'launched' }] },
      tool_use_result: { status: 'async_launched', agentId: 'ag9', description: 'd' }
    })
    const viaAgentId = canUseAs(query, 'ag9')
    await until(() => asks.length === 1)
    expect(asks[0].from).toBe('a1')
    asks[0].resolve(envelope('answered', 'allow'))
    await viaAgentId
    const main = canUseAs(query, undefined)
    await until(() => asks.length === 2)
    expect(asks[1].from).toBeUndefined()
    expect(asks[1].spec.title).toBeUndefined()
    asks[1].resolve(envelope('answered', 'allow'))
    await main
  })
})
