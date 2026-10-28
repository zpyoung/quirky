import { beforeEach, describe, expect, test } from 'bun:test'
import type { AskEnvelope, AskSpec, Session, SessionStatus, StructuredMessage } from '@quirky/protocol'
import { createClaudeRunner, type ClaudeQueryParams } from '../claude-runner'
import type { NewStructuredMessage, StructuredContext, StructuredRunner } from '../runner'
import { FakeQuery } from './fakes/fake-query'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await tick()
  expect(check()).toBe(true)
}

let messages: StructuredMessage[]
let statuses: SessionStatus[]
let asks: { spec: AskSpec; sessionId: string; resolve: (envelope: AskEnvelope) => void }[]
let queries: FakeQuery[]
let providerSessions: { sessionId: string; id: string; transcriptPath?: string | null }[]
let runner: StructuredRunner
let session: Session

function makeContext(): StructuredContext {
  return {
    appendMessage(msg: NewStructuredMessage) {
      const stored = { ...msg, seq: messages.length + 1, at: msg.at ?? Date.now() } as StructuredMessage
      messages.push(stored)
      return stored
    },
    setStatus(_id, status) {
      statuses.push(status)
    },
    createAsk(spec, sessionId) {
      const { promise, resolve } = Promise.withResolvers<AskEnvelope>()
      asks.push({ spec, sessionId, resolve })
      return promise
    },
    async setProviderSession(sessionId, providerSession) {
      providerSessions.push({
        sessionId,
        id: providerSession.id,
        transcriptPath: providerSession.transcriptPath
      })
    },
    resolveClaudePath: async () => '/usr/local/bin/claude',
    resolveCodexPath: async () => '/not-used/codex'
  }
}

function envelope(status: AskEnvelope['status'], decision?: string): AskEnvelope {
  return {
    status,
    askId: 'a_1',
    answers: decision ? { decision: { value: decision, source: 'option' } } : {},
    skipped: decision ? [] : ['decision'],
    summary: ''
  }
}

const assistantText = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  session_id: 'c1'
})

beforeEach(() => {
  messages = []
  statuses = []
  asks = []
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
    query: (params: ClaudeQueryParams) => {
      const query = new FakeQuery(params)
      queries.push(query)
      return query
    }
  })
})

async function begin(prompt = 'hello') {
  await runner.start(session, prompt)
  return queries[0]
}

describe('start', () => {
  test('runs the query with the worktree, the resolved claude and the default permission mode', async () => {
    const query = await begin()
    expect(query.params.options?.cwd).toBe('/work/tree')
    expect(query.params.options?.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
    expect(query.params.options?.permissionMode).toBe('default')
    expect(typeof query.params.options?.canUseTool).toBe('function')
    await until(() => query.written.length === 1)
    expect(query.written[0]).toMatchObject({ type: 'user', message: { role: 'user', content: 'hello' } })
  })

  test('SC-23: a model and effort pick reaches the query options, and no pick sets neither', async () => {
    await runner.start(session, 'hello', { model: 'opus', effort: 'high' })
    expect(queries[0].params.options?.model).toBe('opus')
    expect(queries[0].params.options?.effort).toBe('high')

    session = { ...session, id: 's_2' }
    await runner.start(session, 'again')
    expect(queries[1].params.options).not.toHaveProperty('model')
    expect(queries[1].params.options).not.toHaveProperty('effort')
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
    expect(messages).toEqual([])
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
    expect(messages).toHaveLength(1)
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
    await expect(slow.send(session.id, 'late')).rejects.toThrow('session is not running')
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
    await until(() => messages.length === 6)

    expect(messages.slice(1).map((m) => m.role)).toEqual(['system', 'assistant', 'tool', 'tool', 'result'])
    expect(messages[1].data).toEqual(init)
    expect(messages[2]).toMatchObject({ text: 'Hi there', data: assistant })
    expect(messages[3]).toMatchObject({ text: 'Bash: ls -la', data: toolUse })
    expect(messages[4].text).toContain('file.txt')
    expect(messages[4].data).toEqual(toolResult)
    expect(messages[5].text).toContain('All done')
    expect(messages[5].text).toContain('$0.0123')
    expect(messages[5].text).toContain('2.1s')
    expect(messages[5].data).toEqual(result)
  })

  test('result without cost or duration is just the summary', async () => {
    const query = await begin()
    query.emit({ type: 'result', subtype: 'success', result: 'Fine', is_error: false })
    await until(() => messages.length === 2)
    expect(messages[1]).toMatchObject({ role: 'result', text: 'Fine' })
  })

  test('error results report their subtype and errors', async () => {
    const query = await begin()
    query.emit({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too long'] })
    await until(() => messages.length === 2)
    expect(messages[1].role).toBe('result')
    expect(messages[1].text).toContain('error_max_turns')
    expect(messages[1].text).toContain('too long')
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


  test('failed results journal the error, tear down the query, and exit without publishing done', async () => {
    const query = await begin()
    const failure = { type: 'result', subtype: 'error_api_error', result: 'provider failed', is_error: true }
    query.emit(failure)
    await until(() => statuses.includes('exited'))
    expect(messages.at(-1)).toMatchObject({ role: 'result', text: 'provider failed', data: failure })
    expect(query.closed).toBe(1)
    expect(statuses).toEqual(['working', 'exited'])
    await expect(runner.send('s_1', 'after failure')).rejects.toThrow('session is not running')
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
    expect((question as any).options.map((o: any) => o.value)).toEqual(['allow', 'deny', 'always'])
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
    await expect(runner.send('s_nope', 'x')).rejects.toThrow('session is not running')
  })

  test('throws once the session has been stopped', async () => {
    await begin()
    await runner.stop('s_1')
    await expect(runner.send('s_1', 'x')).rejects.toThrow('session is not running')
  })

  test('throws once the query has ended', async () => {
    const query = await begin()
    query.end()
    await until(() => statuses.includes('exited'))
    await expect(runner.send('s_1', 'x')).rejects.toThrow('session is not running')
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
