import { describe, expect, test } from 'bun:test'
import { normalizeCodex } from '../src/normalize/codex'
import type { Normalized } from '../src/types'

type Event = [name: string, payload?: Record<string, unknown>]

function run(events: Event[]): (Normalized | null)[] {
  const cache = new Map<string, unknown>()
  return events.map(([name, payload]) => normalizeCodex(payload ?? {}, name, cache))
}

const states = (results: (Normalized | null)[]) => results.map((r) => (r ? r.state : 'ignored'))

describe('codex hooks', () => {
  test('SC-7a: SessionStart is working, not done, and starts a fresh session', () => {
    const [r] = run([['SessionStart', { source: 'startup', session_id: 'c1', transcript_path: '/r.jsonl', model: 'gpt-5' }]])
    expect(r).toMatchObject({
      state: 'working',
      newTurn: true,
      cacheReset: true,
      providerSession: { id: 'c1', transcriptPath: '/r.jsonl' },
      fields: { model: 'gpt-5' }
    })
    expect(r?.sessionBoundary).toBeUndefined()
  })

  test('a turn: prompt, tool, question, permission, done', () => {
    const r = run([
      ['SessionStart', { source: 'startup' }],
      ['UserPromptSubmit', { prompt: 'fix it' }],
      ['PreToolUse', { tool_name: 'shell_command', tool_input: { command: 'make' } }],
      ['PreToolUse', { tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Which?' }] } }],
      ['PostToolUse', { tool_name: 'request_user_input' }],
      ['PermissionRequest', { tool_name: 'apply_patch', input: 'diff --git a/x b/x\n+y' }],
      ['Stop', { last_assistant_message: 'Fixed.' }]
    ])
    expect(states(r)).toEqual(['working', 'working', 'working', 'waiting', 'working', 'waiting', 'done'])
    expect(r[1]).toMatchObject({ newTurn: true, fields: { prompt: 'fix it' } })
    expect(r[2]?.fields).toMatchObject({ prompt: 'fix it', toolName: 'shell_command', toolInput: 'make' })
    expect(JSON.parse(r[3]!.fields.question!)).toEqual({ questions: [{ question: 'Which?' }] })
    expect(r[5]).toMatchObject({ permissionRequest: true, fields: { toolInput: 'diff --git a/x b/x +y' } })
    expect(r[6]).toMatchObject({ outcome: 'success', fields: { lastAssistantMessage: 'Fixed.', prompt: 'fix it' } })
  })

  test('SC-7b/c: a PermissionRequest waits unless approvals are auto-reviewed', () => {
    const r = run([
      ['PermissionRequest', { tool_name: 'shell', approvals_reviewer: 'auto_review' }],
      ['PermissionRequest', { tool_name: 'shell', approvals_reviewer: 'user' }],
      ['PermissionRequest', { tool_name: 'shell' }]
    ])
    expect(states(r)).toEqual(['working', 'waiting', 'waiting'])
    expect(r[0]?.permissionRequest).toBeUndefined()
    expect(r[1]?.permissionRequest).toBe(true)
  })

  test('SC-7d: Interrupt is done with cancellation', () => {
    const [r] = run([['Interrupt', {}]])
    expect(r).toMatchObject({ state: 'done', outcome: 'cancellation', interrupted: true })
  })

  test('a compaction SessionStart in a running turn keeps the prompt and the turn', () => {
    const r = run([
      ['UserPromptSubmit', { prompt: 'keep me' }],
      ['SessionStart', { source: 'compact' }],
      ['Stop', {}],
      ['SessionStart', { source: 'compact' }]
    ])
    expect(r[1]).toMatchObject({ state: 'working', newTurn: false, fields: { prompt: 'keep me' } })
    expect(r[1]?.cacheReset).toBeUndefined()
    expect(r[3]?.newTurn).toBe(true)
  })

  test('events with no status are ignored', () => {
    expect(run([['Notification', {}]])[0]).toBeNull()
    expect(run([['PreCompact', {}]])[0]).toBeNull()
  })
})

describe('codex subagents', () => {
  test('subagent events become child ops; a child event never moves the lead', () => {
    const r = run([
      ['UserPromptSubmit', { prompt: 'go' }],
      ['SubagentStart', { agent_id: 'k1', session_id: 'child-session' }],
      ['PermissionRequest', { agent_id: 'k1', session_id: 'child-session', tool_name: 'shell', tool_input: { command: 'rm x' } }],
      ['PostToolUse', { agent_id: 'k1', session_id: 'child-session' }],
      ['SubagentStop', { agent_id: 'k1' }]
    ])
    expect(r[1]).toMatchObject({ state: null, childOps: [{ op: 'start', id: 'k1', kind: 'agent' }] })
    expect(r[1]?.providerSession).toBeUndefined()
    expect(r[2]).toMatchObject({
      state: 'waiting',
      agentId: 'k1',
      childOps: [{ op: 'state', id: 'k1', state: 'waiting' }],
      fields: { toolInput: 'rm x' },
      permissionRequest: true
    })
    expect(r[2]?.providerSession).toBeUndefined()
    expect(r[3]).toMatchObject({ state: 'working', agentId: 'k1', fields: {}, childOps: [{ op: 'state', id: 'k1', state: 'working' }] })
    expect(r[4]).toMatchObject({ state: null, childOps: [{ op: 'stop', id: 'k1' }] })
  })

  test('a child approval under auto review stays working', () => {
    const [r] = run([['PermissionRequest', { agent_id: 'k1', approvals_reviewer: 'auto_review' }]])
    expect(r).toMatchObject({ state: 'working', childOps: [{ op: 'state', id: 'k1', state: 'working' }] })
  })

  test('the lead Stop retires children whose Stop hook never came', () => {
    const r = run([
      ['SubagentStart', { agent_id: 'k1' }],
      ['SubagentStart', { agent_id: 'k2' }],
      ['SubagentStop', { agent_id: 'k2' }],
      ['Stop', {}],
      ['Stop', {}]
    ])
    expect(r[3]?.childOps).toEqual([{ op: 'stop', id: 'k1' }])
    expect(r[4]?.childOps).toBeUndefined()
  })
})

describe('codex notify', () => {
  test('SC-7e: agent-turn-complete is done with the thread as the provider session', () => {
    const cache = new Map<string, unknown>()
    normalizeCodex({ prompt: 'ship it' }, 'UserPromptSubmit', cache)
    const r = normalizeCodex({ type: 'agent-turn-complete', 'thread-id': 'th-9', 'last-assistant-message': 'Shipped' }, '', cache)
    expect(r).toMatchObject({
      eventName: 'agent-turn-complete',
      state: 'done',
      outcome: 'success',
      providerSession: { id: 'th-9', transcriptPath: null },
      fields: { lastAssistantMessage: 'Shipped', prompt: 'ship it' }
    })
  })

  test('the notify call works without a thread id or message', () => {
    const [r] = run([['', { type: 'agent-turn-complete' }]])
    expect(r).toMatchObject({ state: 'done' })
    expect(r?.providerSession).toBeUndefined()
  })
})
