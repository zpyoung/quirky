import { describe, expect, test } from 'bun:test'
import { normalizeClaude, normalizeOpenClaude, normalizeQwenCode } from '../src/normalize/claude'
import type { Normalized, Normalizer } from '../src/types'

type Event = [name: string, payload?: Record<string, unknown>]

function run(normalizer: Normalizer, events: Event[]): (Normalized | null)[] {
  const cache = new Map<string, unknown>()
  return events.map(([name, payload]) => normalizer(payload ?? {}, name, cache))
}

const states = (results: (Normalized | null)[]) => results.map((r) => (r ? r.state : 'ignored'))

describe('claude turn', () => {
  test('SC-1: boundary, working, waiting, working, done keep the prompt through tool events', () => {
    const r = run(normalizeClaude, [
      ['SessionStart', { source: 'startup', session_id: 'abc', transcript_path: '/tmp/t/abc.jsonl', model: 'opus' }],
      ['UserPromptSubmit', { prompt: 'fix the tests' }],
      ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't0' }],
      ['PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a.ts' } }],
      ['PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' }],
      ['PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' }],
      ['Stop', { last_assistant_message: 'All green' }]
    ])
    expect(states(r)).toEqual(['done', 'working', 'working', 'working', 'waiting', 'working', 'done'])
    expect(r[0]).toMatchObject({
      sessionBoundary: true,
      newTurn: true,
      cacheReset: true,
      providerSession: { id: 'abc', transcriptPath: '/tmp/t/abc.jsonl' }
    })
    expect(r[0]?.movesLead).toBe(false)
    expect(r[1]).toMatchObject({ newTurn: true, fields: { prompt: 'fix the tests', model: 'opus' } })
    expect(r[3]?.fields).toMatchObject({ prompt: 'fix the tests', toolName: 'Read', toolInput: '/a.ts' })
    expect(r[3]?.newTurn).toBe(false)
    expect(r[4]).toMatchObject({
      permissionRequest: true,
      fields: { prompt: 'fix the tests', toolName: 'Bash', toolInput: 'npm test', toolUseId: 't1' }
    })
    expect(r[5]?.fields.toolUseId).toBe('t1')
    expect(r[6]).toMatchObject({ outcome: 'success', fields: { lastAssistantMessage: 'All green', prompt: 'fix the tests' } })
  })

  test('a new prompt resets the tool and message of the old turn', () => {
    const r = run(normalizeClaude, [
      ['UserPromptSubmit', { prompt: 'one' }],
      ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
      ['Stop', { last_assistant_message: 'done one' }],
      ['UserPromptSubmit', { prompt: 'two' }]
    ])
    expect(r[3]?.fields).toEqual({ prompt: 'two' })
  })

  test('SC-32: a permission request reads as a one-line tool summary, never JSON', () => {
    const [r] = run(normalizeClaude, [['PermissionRequest', { tool_name: 'Bash', tool_input: { command: "printf 'x' >> README.md" } }]])
    expect(r?.fields.toolInput).toBe("printf 'x' >> README.md")
    const [other] = run(normalizeClaude, [['PreToolUse', { tool_name: 'Mystery', tool_input: { nested: { a: 1 } } }]])
    expect(other?.fields.toolInput).toBeUndefined()
  })

  test('PostToolUseFailure clears the tool', () => {
    const r = run(normalizeClaude, [
      ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
      ['PostToolUseFailure', { tool_name: 'Bash' }]
    ])
    expect(r[1]).toMatchObject({ state: 'working' })
    expect(r[1]?.fields.toolName).toBeUndefined()
  })

  test.each([
    ['PreCompact', { trigger: 'manual' }],
    ['PostCompact', { trigger: 'auto' }],
    ['SessionStart', { source: 'compact' }],
    ['Notification', { message: 'hi' }],
    ['SessionEnd', { reason: 'clear' }],
    ['SessionEnd', { reason: 'resume' }],
    ['UnknownEvent', {}]
  ])('%s %j says nothing about status', (name, payload) => {
    expect(run(normalizeClaude, [[name, payload]])[0]).toBeNull()
  })

  test('a manual PostCompact is a done boundary', () => {
    const [r] = run(normalizeClaude, [['PostCompact', { trigger: 'manual' }]])
    expect(r).toMatchObject({ state: 'done', sessionBoundary: true })
  })

  test('a SessionStart from a subagent is ignored', () => {
    expect(run(normalizeClaude, [['SessionStart', { source: 'startup', agent_id: 'a1' }]])[0]).toBeNull()
  })
})

describe('claude questions', () => {
  const ask = { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which branch?', options: ['main', 'dev'] }] }, tool_use_id: 'q1' }

  test('SC-3: AskUserQuestion waits with the question JSON', () => {
    const r = run(normalizeClaude, [
      ['UserPromptSubmit', { prompt: 'go' }],
      ['PreToolUse', ask],
      ['PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' }]
    ])
    expect(states(r)).toEqual(['working', 'waiting', 'working'])
    expect(JSON.parse(r[1]!.fields.question!)).toEqual(ask.tool_input)
    expect(r[1]?.fields.toolInput).toBeUndefined()
    expect(r[2]?.fields.question).toBeUndefined()
  })

  test('requestuserinput and a PermissionRequest for the ask tool also wait', () => {
    const r = run(normalizeClaude, [
      ['PreToolUse', { tool_name: 'request_user_input', tool_input: { questions: [] } }],
      ['PermissionRequest', ask]
    ])
    expect(states(r)).toEqual(['waiting', 'waiting'])
    expect(r[1]?.fields.question).toBeDefined()
  })

  test('a sibling tool finishing during the question is not the answer', () => {
    const r = run(normalizeClaude, [
      ['PreToolUse', ask],
      ['PostToolUse', { tool_name: 'Read', tool_use_id: 'other' }],
      ['PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' }]
    ])
    expect(r[1]).toBeNull()
    expect(r[2]?.state).toBe('working')
  })
})

describe('claude outcomes', () => {
  test('SC-4: StopFailure fails and is_interrupt cancels', () => {
    const r = run(normalizeClaude, [
      ['StopFailure', {}],
      ['Stop', { is_interrupt: true }],
      ['Stop', {}]
    ])
    expect(r[0]).toMatchObject({ state: 'done', outcome: 'failure' })
    expect(r[1]).toMatchObject({ state: 'done', outcome: 'cancellation', interrupted: true })
    expect(r[2]).toMatchObject({ state: 'done', outcome: 'success' })
    expect(r[2]?.interrupted).toBeUndefined()
  })
})

describe('claude children', () => {
  test('SC-5: subagent lifecycle and a child question', () => {
    const r = run(normalizeClaude, [
      ['UserPromptSubmit', { prompt: 'go' }],
      ['SubagentStart', { agent_id: 'a1', agent_type: 'general' }],
      ['Stop', {}],
      ['PreToolUse', { agent_id: 'a1', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Sure?' }] } }],
      ['PostToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'ls' } }],
      ['SubagentStop', { agent_id: 'a1' }]
    ])
    expect(r[1]).toMatchObject({ state: null, childOps: [{ op: 'start', id: 'a1', kind: 'agent' }] })
    expect(r[2]).toMatchObject({ state: 'done', outcome: 'success' })
    expect(r[3]).toMatchObject({
      state: 'waiting',
      agentId: 'a1',
      childOps: [{ op: 'state', id: 'a1', state: 'waiting' }],
      fields: { question: expect.stringContaining('Sure?') }
    })
    expect(r[3]?.newTurn).toBe(false)
    // the child's next tool event swaps the pending card for the lead's own fields
    expect(r[4]).toMatchObject({ state: 'working', agentId: 'a1', childOps: [{ op: 'state', id: 'a1', state: 'working' }] })
    expect(r[4]?.fields).toMatchObject({ prompt: 'go' })
    expect(r[4]?.fields.question).toBeUndefined()
    expect(r[5]).toMatchObject({ state: null, childOps: [{ op: 'stop', id: 'a1' }] })
  })

  test('child tool events leave the lead fields alone', () => {
    const r = run(normalizeClaude, [
      ['UserPromptSubmit', { prompt: 'go' }],
      ['PreToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'ls' } }]
    ])
    expect(r[1]).toMatchObject({ state: 'working', agentId: 'a1', fields: {}, newTurn: false })
  })

  test('a child permission request carries the permission flag', () => {
    const [r] = run(normalizeClaude, [['PermissionRequest', { agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'rm x' } }]])
    expect(r).toMatchObject({ state: 'waiting', agentId: 'a1', permissionRequest: true, fields: { toolInput: 'rm x' } })
  })

  test('a child StopFailure stops the child; a child Stop says nothing', () => {
    const r = run(normalizeClaude, [
      ['StopFailure', { agent_id: 'a1' }],
      ['Stop', { agent_id: 'a1' }]
    ])
    expect(r[0]).toMatchObject({ state: null, childOps: [{ op: 'stop', id: 'a1' }] })
    expect(r[0]?.outcome).toBeUndefined()
    expect(r[1]).toBeNull()
  })

  test('TeammateIdle parks the named teammate', () => {
    const r = run(normalizeClaude, [
      ['SubagentStart', { agent_id: 'areviewer-1f3a' }],
      ['TeammateIdle', { teammate_name: 'reviewer' }],
      ['TeammateIdle', { teammate_name: 'nobody' }]
    ])
    expect(r[1]).toMatchObject({ state: null, childOps: [{ op: 'state', id: 'areviewer-1f3a', state: 'done' }] })
    expect(r[2]).toBeNull()
  })

  test('a released child restores the lead fields over its question', () => {
    const r = run(normalizeClaude, [
      ['UserPromptSubmit', { prompt: 'go' }],
      ['SubagentStart', { agent_id: 'a1' }],
      ['PreToolUse', { agent_id: 'a1', tool_name: 'AskUserQuestion', tool_input: { questions: [] } }],
      ['SubagentStop', { agent_id: 'a1' }]
    ])
    expect(r[3]?.fields).toMatchObject({ prompt: 'go' })
  })
})

describe('claude background work', () => {
  test('SC-6: Stop classifies background_tasks and session_crons', () => {
    const r = run(normalizeClaude, [
      [
        'Stop',
        {
          background_tasks: [
            { id: 'b1', type: 'shell', status: 'running' },
            { id: 'b2', type: 'subagent', status: 'running' },
            { id: 'b3', type: 'shell', status: 'completed' },
            { id: 'b4', type: 'monitor', status: 'running' },
            { id: 'b5', type: 'teammate', status: 'running' }
          ],
          session_crons: [{ id: 'c1' }]
        }
      ],
      ['Stop', { background_tasks: [], session_crons: [] }],
      ['Stop', {}]
    ])
    expect(r[0]?.inventory).toEqual({
      complete: true,
      tasks: [
        { id: 'b1', kind: 'shell', running: true },
        { id: 'b2', kind: 'agent', running: true },
        { id: 'b3', kind: 'shell', running: false },
        { id: 'b4', kind: 'shell', running: true }
      ]
    })
    expect(r[0]?.cronsActive).toBe(true)
    expect(r[1]?.inventory).toEqual({ tasks: [], complete: true })
    expect(r[1]?.cronsActive).toBe(false)
    expect(r[2]?.inventory).toBeUndefined()
    expect(r[2]?.cronsActive).toBeUndefined()
  })

  test('an entry that cannot be listed makes the inventory incomplete and fails active', () => {
    const [r] = run(normalizeClaude, [
      ['Stop', { background_tasks: ['junk', { status: 'running' }, { type: 'subagent', status: 'running' }, { id: 'b9', type: 'shell', status: 'weird' }] }]
    ])
    expect(r?.inventory?.complete).toBe(false)
    expect(r?.inventory?.tasks).toEqual([
      { id: 'shell-0', kind: 'shell', running: true },
      { id: 'shell-1', kind: 'shell', running: true },
      { id: 'b9', kind: 'shell', running: true }
    ])
  })
})

describe('claude session identity', () => {
  test('SC-14: clear and resume move the lead; startup does not', () => {
    const r = run(normalizeClaude, [
      ['SessionStart', { source: 'clear', session_id: 'def' }],
      ['SessionStart', { source: 'resume', session_id: 'def' }],
      ['SessionStart', { source: 'startup', session_id: 'ghi' }]
    ])
    expect(r.map((x) => x?.movesLead)).toEqual([true, true, false])
    expect(r[0]?.providerSession).toEqual({ id: 'def', transcriptPath: null })
  })

  test('SC-14: SessionEnd ends the process only for exit reasons', () => {
    for (const reason of ['prompt_input_exit', 'logout', 'other', 'bypass_permissions_disabled']) {
      const [r] = run(normalizeClaude, [['SessionEnd', { reason, session_id: 'abc' }]])
      expect(r).toMatchObject({ state: null, endsProcess: true, providerSession: { id: 'abc' } })
    }
    expect(run(normalizeClaude, [['SessionEnd', { reason: 'clear' }]])[0]).toBeNull()
    expect(run(normalizeClaude, [['SessionEnd', {}]])[0]).toBeNull()
  })

  test('SessionStart drops the previous session prompt and tool', () => {
    const r = run(normalizeClaude, [
      ['UserPromptSubmit', { prompt: 'old' }],
      ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
      ['SessionStart', { source: 'clear' }],
      ['PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' } }]
    ])
    expect(r[2]?.fields).toEqual({})
    expect(r[3]?.fields).toEqual({ toolName: 'Read', toolInput: '/a' })
  })
})

describe('claude look-alikes', () => {
  const sequence: Event[] = [
    ['UserPromptSubmit', { prompt: 'go' }],
    ['PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
    ['Stop', {}]
  ]

  test('SC-8: qwen-code maps like claude', () => {
    expect(states(run(normalizeQwenCode, sequence))).toEqual(['working', 'waiting', 'done'])
  })

  test('SC-8: openclaude asks a question like claude', () => {
    const r = run(normalizeOpenClaude, [
      ['UserPromptSubmit', { prompt: 'go' }],
      ['PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }],
      ['Stop', {}]
    ])
    expect(states(r)).toEqual(['working', 'waiting', 'done'])
  })

  test('look-alikes capture their own provider session', () => {
    const payload = { source: 'startup', session_id: 's1', transcript_path: '/t.jsonl' }
    for (const normalizer of [normalizeQwenCode, normalizeOpenClaude]) {
      expect(run(normalizer, [['SessionStart', payload]])[0]?.providerSession).toEqual({ id: 's1', transcriptPath: '/t.jsonl' })
    }
  })
})
