import { describe, expect, test } from 'bun:test'
import {
  CallTracker,
  ProseStream,
  claudeEntries,
  claudeTextDelta,
  closingEntries,
  codexEntries,
  codexPlanEntry,
  isTestCommand,
  parseTestCounts
} from '../items'

const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content } })
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input })
const toolResult = (id: string, content: unknown, is_error?: boolean) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error } : {}) }] }
})

describe('claudeEntries', () => {
  test('assistant text is a prose item', () => {
    const [entry] = claudeEntries(assistant({ type: 'text', text: 'Hi ' }, { type: 'text', text: 'there' }), new CallTracker())
    expect(entry).toMatchObject({ role: 'assistant', text: 'Hi there', item: { kind: 'prose', text: 'Hi there' } })
    expect((entry!.item as { streaming?: boolean }).streaming).toBeUndefined()
  })

  test('a read-only tool is an activity that closes under the same callId', () => {
    const calls = new CallTracker()
    const [start] = claudeEntries(assistant(toolUse('t1', 'Read', { file_path: '/a/b.ts' })), calls)
    expect(start!.item).toEqual({ kind: 'activity', callId: 't1', tool: 'Read', summary: '/a/b.ts', state: 'running' })
    expect(calls.size).toBe(1)
    const [done] = claudeEntries(toolResult('t1', 'contents'), calls)
    expect(done!.item).toEqual({ kind: 'activity', callId: 't1', tool: 'Read', summary: '/a/b.ts', state: 'done', detail: 'contents' })
    expect(calls.size).toBe(0)
  })

  test('a failed tool result closes the call as failed', () => {
    const calls = new CallTracker()
    claudeEntries(assistant(toolUse('t1', 'Grep', { pattern: 'x' })), calls)
    const [done] = claudeEntries(toolResult('t1', 'boom', true), calls)
    expect(done!.item).toMatchObject({ kind: 'activity', state: 'failed' })
  })

  test('edit tools become file-change items with line counts', () => {
    const calls = new CallTracker()
    const [edit] = claudeEntries(
      assistant(toolUse('e1', 'Edit', { file_path: '/w/a.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree\nfour' })),
      calls
    )
    expect(edit!.item).toEqual({ kind: 'file-change', callId: 'e1', path: '/w/a.ts', added: 4, removed: 2, state: 'running' })
    const [write] = claudeEntries(assistant(toolUse('w1', 'Write', { file_path: '/w/b.ts', content: 'a\nb\n' })), calls)
    expect(write!.item).toMatchObject({ kind: 'file-change', path: '/w/b.ts', added: 2 })
    const [done] = claudeEntries(toolResult('e1', 'ok'), calls)
    expect(done!.item).toMatchObject({ kind: 'file-change', callId: 'e1', state: 'done', added: 4, removed: 2 })
  })

  test('a test command becomes a tests item with parsed counts and a tail', () => {
    const calls = new CallTracker()
    const [start] = claudeEntries(assistant(toolUse('b1', 'Bash', { command: 'bun test src/a.test.ts' })), calls)
    expect(start!.item).toMatchObject({ kind: 'tests', callId: 'b1', command: 'bun test src/a.test.ts', state: 'running' })
    const [done] = claudeEntries(toolResult('b1', 'bun test v1\n\n 42 pass\n 1 fail\n 2 skip\nRan 45 tests'), calls)
    expect(done!.item).toMatchObject({ kind: 'tests', passed: 42, failed: 1, skipped: 2, state: 'done' })
    expect((done!.item as { tail?: string }).tail).toContain('Ran 45 tests')
  })

  test('other shell commands stay activities', () => {
    const [entry] = claudeEntries(assistant(toolUse('b2', 'Bash', { command: 'ls -la' })), new CallTracker())
    expect(entry!.item).toMatchObject({ kind: 'activity', tool: 'Bash', summary: 'ls -la' })
  })

  test('TodoWrite becomes a steps item', () => {
    const calls = new CallTracker()
    const [entry] = claudeEntries(
      assistant(toolUse('td', 'TodoWrite', { todos: [
        { content: 'Plan', status: 'completed', activeForm: 'Planning' },
        { content: 'Build', status: 'in_progress', activeForm: 'Building' },
        { content: 'Ship', status: 'pending', activeForm: 'Shipping' }
      ] })),
      calls
    )
    expect(entry!.item).toEqual({
      kind: 'steps',
      callId: 'td',
      steps: [{ text: 'Plan', state: 'done' }, { text: 'Build', state: 'active' }, { text: 'Ship', state: 'pending' }]
    })
    const [result] = claudeEntries(toolResult('td', 'Todos modified'), calls)
    expect(result!.item.kind).toBe('status')
  })

  test('assistant text and tool uses in one message give one entry each', () => {
    const entries = claudeEntries(assistant({ type: 'text', text: 'Looking' }, toolUse('t1', 'Read', { file_path: '/a' })), new CallTracker())
    expect(entries.map((entry) => entry.item.kind)).toEqual(['prose', 'activity'])
  })

  test('result is a turn-end with its duration', () => {
    const [done] = claudeEntries({ type: 'result', subtype: 'success', result: 'ok', is_error: false, duration_ms: 2100 }, new CallTracker())
    expect(done!.item).toEqual({ kind: 'turn-end', state: 'done', durationMs: 2100 })
    const [failed] = claudeEntries({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too long'] }, new CallTracker())
    expect(failed!.item).toEqual({ kind: 'turn-end', state: 'failed' })
  })

  test('system, rate limit and unknown events become status items and never throw', () => {
    const calls = new CallTracker()
    expect(claudeEntries({ type: 'system', subtype: 'init', model: 'm' }, calls)[0]!.item).toEqual({ kind: 'status', text: 'session started (m)' })
    expect(claudeEntries({ type: 'rate_limit_event' }, calls)[0]!.item.kind).toBe('status')
    expect(claudeEntries({ type: 'brand_new' }, calls)[0]!.item).toEqual({ kind: 'status', text: 'brand_new' })
    expect(claudeEntries(null, calls)[0]!.item.kind).toBe('status')
    expect(claudeEntries({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }, calls)[0]!.item.kind).toBeDefined()
  })

  test('a user message without tool results is a user item', () => {
    const [entry] = claudeEntries({ type: 'user', message: { role: 'user', content: 'hello' } }, new CallTracker())
    expect(entry!.item).toEqual({ kind: 'user', text: 'hello' })
  })

  test('partial-message events carry their text delta and journal nothing themselves', () => {
    const event = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ab' } } }
    expect(claudeTextDelta(event)).toBe('ab')
    expect(claudeTextDelta({ type: 'assistant' })).toBeNull()
    expect(claudeEntries(event, new CallTracker())).toEqual([])
  })
})

describe('closing running calls', () => {
  test('every call still running closes in the requested state', () => {
    const calls = new CallTracker()
    claudeEntries(assistant(toolUse('a', 'Read', { file_path: '/a' }), toolUse('b', 'Bash', { command: 'pytest' })), calls)
    const closing = closingEntries(calls, 'stopped')
    expect(closing.map((entry) => entry.item)).toEqual([
      expect.objectContaining({ kind: 'activity', callId: 'a', state: 'stopped' }),
      expect.objectContaining({ kind: 'tests', callId: 'b', state: 'stopped' })
    ])
    expect(calls.size).toBe(0)
  })
})

describe('codexEntries', () => {
  test('an unrecognized item type is a status item and is never tracked as a call', () => {
    const calls = new CallTracker()
    expect(codexEntries({ id: 'x', type: 'futureEvent' }, 'started', calls)).toEqual([])
    const entries = codexEntries({ id: 'x', type: 'futureEvent' }, 'completed', calls)
    expect(entries.map((entry) => entry.item)).toEqual([{ kind: 'status', text: 'Codex futureEvent' }])
    expect(closingEntries(calls, 'stopped')).toEqual([])
  })

  test('a command pairs its start and completion by id', () => {
    const calls = new CallTracker()
    const started = { id: 'c1', type: 'commandExecution', command: 'ls', status: 'inProgress' }
    expect(codexEntries(started, 'started', calls)[0]!.item).toEqual({ kind: 'activity', callId: 'c1', tool: 'Command', summary: 'ls', state: 'running' })
    const completed = { ...started, status: 'completed', aggregatedOutput: 'a.txt', exitCode: 0 }
    expect(codexEntries(completed, 'completed', calls)[0]!.item).toEqual({ kind: 'activity', callId: 'c1', tool: 'Command', summary: 'ls', state: 'done', detail: 'a.txt' })
    expect(calls.size).toBe(0)
  })

  test('a non-zero exit fails the call and a test command becomes tests', () => {
    const calls = new CallTracker()
    const item = { id: 'c2', type: 'commandExecution', command: 'pytest -q', status: 'completed', exitCode: 1, aggregatedOutput: '2 passed, 1 failed in 0.1s' }
    expect(codexEntries(item, 'completed', calls)[0]!.item).toMatchObject({ kind: 'tests', callId: 'c2', passed: 2, failed: 1, state: 'failed' })
  })

  test('declined commands fail', () => {
    const [entry] = codexEntries({ id: 'c3', type: 'commandExecution', command: 'rm x', status: 'declined' }, 'completed', new CallTracker())
    expect(entry!.item).toMatchObject({ state: 'failed' })
  })

  test('file changes give one file-change item per path', () => {
    const calls = new CallTracker()
    const item = { id: 'f1', type: 'fileChange', status: 'inProgress', changes: [
      { path: 'a.txt', kind: { type: 'add' }, diff: 'one\ntwo\n' },
      { path: 'b.txt', kind: { type: 'update' }, diff: '@@\n-old\n+new\n+more\n' }
    ] }
    const entries = codexEntries(item, 'started', calls)
    expect(entries.map((entry) => entry.item)).toEqual([
      { kind: 'file-change', callId: 'f1:0', path: 'a.txt', added: 2, removed: 0, state: 'running' },
      { kind: 'file-change', callId: 'f1:1', path: 'b.txt', added: 2, removed: 1, state: 'running' }
    ])
    const done = codexEntries({ ...item, status: 'completed' }, 'completed', calls)
    expect(done.map((entry) => (entry.item as { state: string }).state)).toEqual(['done', 'done'])
    expect(calls.size).toBe(0)
  })

  test('a single file change keeps the item id', () => {
    const [entry] = codexEntries({ id: 'f2', type: 'fileChange', changes: [{ path: 'a', kind: 'add', diff: '+x' }] }, 'completed', new CallTracker())
    expect(entry!.item).toMatchObject({ callId: 'f2', path: 'a' })
  })

  test('todo and plan items become steps', () => {
    const calls = new CallTracker()
    const [todo] = codexEntries({ id: 't', type: 'todo_list', items: [{ text: 'a', completed: true }, { text: 'b', completed: false }] }, 'completed', calls)
    expect(todo!.item).toEqual({ kind: 'steps', callId: 't', steps: [{ text: 'a', state: 'done' }, { text: 'b', state: 'pending' }] })
    const [plan] = codexEntries({ id: 'p', type: 'plan', text: '- first\n2. second' }, 'completed', calls)
    expect(plan!.item).toEqual({ kind: 'steps', callId: 'p', steps: [{ text: 'first', state: 'pending' }, { text: 'second', state: 'pending' }] })
    expect(codexPlanEntry('turn-1', [{ step: 'x', status: 'inProgress' }, { step: 'y', status: 'completed' }]).item).toEqual({
      kind: 'steps', callId: 'turn-1', steps: [{ text: 'x', state: 'active' }, { text: 'y', state: 'done' }]
    })
  })

  test('mcp calls, web searches and other typed items are activities', () => {
    const calls = new CallTracker()
    expect(codexEntries({ id: 'm', type: 'mcpToolCall', server: 'docs', tool: 'search', arguments: { query: 'q' }, status: 'completed' }, 'completed', calls)[0]!.item)
      .toMatchObject({ kind: 'activity', tool: 'docs/search', summary: 'q', state: 'done' })
    expect(codexEntries({ id: 'w', type: 'webSearch', query: 'bun' }, 'completed', calls)[0]!.item).toMatchObject({ kind: 'activity', tool: 'Web search', summary: 'bun' })
    expect(codexEntries({ id: 'x', type: 'imageView' }, 'completed', calls)[0]!.item).toMatchObject({ kind: 'activity', tool: 'imageView' })
  })

  test('reasoning and agent messages are left to the runner, and malformed items become status', () => {
    const calls = new CallTracker()
    expect(codexEntries({ id: 'r', type: 'reasoning' }, 'completed', calls)).toEqual([])
    expect(codexEntries({ id: 'a', type: 'agentMessage', text: 'x' }, 'completed', calls)).toEqual([])
    expect(codexEntries({ id: 'u' }, 'completed', calls)[0]!.item.kind).toBe('status')
    expect(codexEntries({ id: 'f', type: 'fileChange', changes: 5 }, 'completed', calls)[0]!.item.kind).toBe('activity')
  })
})

describe('helpers', () => {
  test('test-command detection covers the documented runners', () => {
    for (const command of ['pnpm test', 'npm run test', 'bun test a.ts', 'pytest -q', 'npx jest', 'pnpm exec vitest run', 'go test ./...', 'cargo test', 'cd x && bun test']) {
      expect(isTestCommand(command)).toBe(true)
    }
    for (const command of ['ls', 'test -f x', 'echo bun testing']) expect(isTestCommand(command)).toBe(false)
  })

  test('test counts come from the runner summaries', () => {
    expect(parseTestCounts('Tests:       1 failed, 2 passed, 3 total')).toEqual({ passed: 2, failed: 1 })
    expect(parseTestCounts('test result: ok. 3 passed; 0 failed; 1 ignored')).toEqual({ passed: 3, failed: 0, skipped: 1 })
    expect(parseTestCounts('ok  pkg 0.1s')).toEqual({})
  })

  test('streaming prose is throttled and carries the accumulated text', () => {
    const stream = new ProseStream()
    expect(stream.push('m', 'He', 1000)).toBeNull()
    expect(stream.push('m', 'll', 1100)).toBeNull()
    expect(stream.push('m', 'o', 1400)).toEqual({ kind: 'prose', text: 'Hello', streaming: true })
    expect(stream.push('m', '!', 1500)).toBeNull()
    stream.reset('m')
    expect(stream.push('m', 'x', 1501)).toBeNull()
    expect(stream.push('other', 'y', 1501)).toBeNull()
  })
})
