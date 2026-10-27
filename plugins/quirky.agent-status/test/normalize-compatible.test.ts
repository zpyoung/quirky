import { describe, expect, test } from 'bun:test'
import { normalizeCodebuddy, normalizeQoder } from '../src/normalize/compatible'
import type { Normalized, Normalizer } from '../src/types'

type Event = [name: string, payload?: Record<string, unknown>]

function run(normalizer: Normalizer, events: Event[]): (Normalized | null)[] {
  const cache = new Map<string, unknown>()
  return events.map(([name, payload]) => normalizer(payload ?? {}, name, cache))
}

const states = (results: (Normalized | null)[]) => results.map((r) => (r ? r.state : 'ignored'))

describe('qoder', () => {
  test('SC-8: new session, prompt, permission prompt, tool result, idle prompt', () => {
    const r = run(normalizeQoder, [
      ['SessionStart', { source: 'new', session_id: 'q1', transcript_path: '/q.jsonl' }],
      ['UserPromptSubmit', { prompt: 'refactor' }],
      ['Notification', { notification_type: 'permission_prompt', message: 'needs permission' }],
      ['PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/a.ts' } }],
      ['Notification', { notification_type: 'idle_prompt' }]
    ])
    expect(states(r)).toEqual(['done', 'working', 'waiting', 'working', 'done'])
    expect(r[0]).toMatchObject({
      sessionBoundary: true,
      newTurn: true,
      cacheReset: true,
      movesLead: true,
      providerSession: { id: 'q1', transcriptPath: '/q.jsonl' }
    })
    expect(r[1]).toMatchObject({ newTurn: true, fields: { prompt: 'refactor' } })
    expect(r[2]?.fields.prompt).toBe('refactor')
    expect(r[3]?.fields).toMatchObject({ prompt: 'refactor', toolName: 'Edit', toolInput: '/a.ts' })
    expect(r[4]).toMatchObject({ outcome: 'success', fields: { prompt: 'refactor' } })
    expect(r[4]?.sessionBoundary).toBeUndefined()
  })

  test.each(['startup', 'resume', 'clear', 'new'])('SessionStart %s is a done boundary', (source) => {
    const [r] = run(normalizeQoder, [['SessionStart', { source }]])
    expect(r).toMatchObject({ state: 'done', sessionBoundary: true, movesLead: source !== 'startup' })
  })

  test('a compaction SessionStart is ignored', () => {
    expect(run(normalizeQoder, [['SessionStart', { source: 'compact' }]])[0]).toBeNull()
  })

  test('elicitation dialogs and permission requests wait; AskUserQuestion waits with its question', () => {
    const input = { questions: [{ question: 'Pick' }] }
    const r = run(normalizeQoder, [
      ['Notification', { notification_type: 'elicitation_dialog' }],
      ['PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
      ['PreToolUse', { tool_name: 'AskUserQuestion', tool_input: input }],
      ['PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }]
    ])
    expect(states(r)).toEqual(['waiting', 'waiting', 'waiting', 'working'])
    expect(r[1]?.permissionRequest).toBe(true)
    expect(JSON.parse(r[2]!.fields.question!)).toEqual(input)
  })

  test('failure, interrupt, session end and manual compact end the turn', () => {
    const r = run(normalizeQoder, [
      ['StopFailure', {}],
      ['Stop', { is_interrupt: true }],
      ['SessionEnd', {}],
      ['PostCompact', { trigger: 'manual' }],
      ['PostCompact', { trigger: 'auto' }],
      ['Notification', { notification_type: 'other' }]
    ])
    expect(r[0]).toMatchObject({ state: 'done', outcome: 'failure' })
    expect(r[1]).toMatchObject({ state: 'done', interrupted: true, outcome: 'cancellation' })
    expect(r[2]).toMatchObject({ state: 'done' })
    expect(r[3]).toMatchObject({ state: 'done', sessionBoundary: true })
    expect(r[4]).toBeNull()
    expect(r[5]).toBeNull()
  })

  test('the last message survives to the Stop row', () => {
    const r = run(normalizeQoder, [
      ['UserPromptSubmit', { prompt: 'go' }],
      ['Stop', { last_assistant_message: 'Done here' }]
    ])
    expect(r[1]?.fields).toMatchObject({ prompt: 'go', lastAssistantMessage: 'Done here' })
  })
})

describe('codebuddy', () => {
  test('SC-8: SessionStart ignored, prompt works, AskUserQuestion keeps working, stop is done', () => {
    const r = run(normalizeCodebuddy, [
      ['SessionStart', { source: 'startup', session_id: 'b1' }],
      ['UserPromptSubmit', { prompt: 'build' }],
      ['PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }],
      ['Stop', {}]
    ])
    expect(states(r)).toEqual(['ignored', 'working', 'working', 'done'])
    expect(r[2]?.fields.question).toBeUndefined()
    expect(r[2]?.fields.prompt).toBe('build')
  })

  test('a permission notification for AskUserQuestion names the tool', () => {
    const [r] = run(normalizeCodebuddy, [
      ['Notification', { notification_type: 'permission_prompt', message: 'needs your permission to use AskUserQuestion' }]
    ])
    expect(r).toMatchObject({ state: 'waiting', fields: { toolName: 'AskUserQuestion' } })
  })

  test('a notification message never becomes the prompt', () => {
    const r = run(normalizeCodebuddy, [
      ['UserPromptSubmit', { prompt: 'build' }],
      ['Notification', { notification_type: 'permission_prompt', message: 'needs permission' }]
    ])
    expect(r[1]?.fields.prompt).toBe('build')
  })

  test('captures session and transcript like claude', () => {
    const [r] = run(normalizeCodebuddy, [['UserPromptSubmit', { prompt: 'x', session_id: 'b1', transcript_path: '/b.jsonl' }]])
    expect(r?.providerSession).toEqual({ id: 'b1', transcriptPath: '/b.jsonl' })
  })
})
