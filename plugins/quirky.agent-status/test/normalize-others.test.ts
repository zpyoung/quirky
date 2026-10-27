import { describe, expect, test } from 'bun:test'
import { normalizeAmp } from '../src/normalize/amp'
import { normalizeAntigravity } from '../src/normalize/antigravity'
import { normalizeCommandCode } from '../src/normalize/command-code'
import { normalizeCopilot } from '../src/normalize/copilot'
import { normalizeCursor } from '../src/normalize/cursor'
import { normalizeDevin } from '../src/normalize/devin'
import { normalizeDroid } from '../src/normalize/droid'
import { normalizeDsh } from '../src/normalize/dsh'
import { normalizeGemini } from '../src/normalize/gemini'
import { normalizeGrok } from '../src/normalize/grok'
import { normalizeHermes } from '../src/normalize/hermes'
import { normalizeJcode } from '../src/normalize/jcode'
import { normalizeKimi } from '../src/normalize/kimi'
import { normalizeKiro } from '../src/normalize/kiro'
import { normalizeMimoCode, normalizeOpencode, normalizeOpencode2 } from '../src/normalize/opencode'
import { normalizeMuse } from '../src/normalize/muse'
import { normalizeOmp, normalizePi, normalizePrimeAgent } from '../src/normalize/pi'
import { normalizeZcode } from '../src/normalize/zcode'
import type { Normalized, Normalizer } from '../src/types'

type Step = [event: string, payload?: Record<string, unknown>]

/** Runs the events through one normalizer with a shared cache; null and state-less results read as `none`. */
function run(normalize: Normalizer, steps: Step[]): { states: string[]; results: (Normalized | null)[] } {
  const cache = new Map<string, unknown>()
  const results = steps.map(([event, payload]) => normalize(payload ?? {}, event, cache))
  return { states: results.map((r) => r?.state ?? 'none'), results }
}

function table(normalize: Normalizer, steps: Step[], expected: string[]) {
  expect(run(normalize, steps).states).toEqual(expected)
}

describe('gemini', () => {
  test('BeforeAgent, BeforeTool, AfterAgent', () => {
    const { states, results } = run(normalizeGemini, [
      ['BeforeAgent', { prompt: 'fix it' }],
      ['BeforeTool', { tool_name: 'run_shell_command', tool_input: { command: 'ls' } }],
      ['AfterAgent', { prompt_response: 'done!' }],
    ])
    expect(states).toEqual(['working', 'working', 'done'])
    expect(results[0]).toMatchObject({ newTurn: true, fields: { prompt: 'fix it' } })
    expect(results[1]?.fields).toMatchObject({ toolName: 'run_shell_command', toolInput: 'ls' })
    expect(results[2]?.fields.lastAssistantMessage).toBe('done!')
  })

  test('unknown events say nothing', () => {
    expect(normalizeGemini({}, 'SessionStart', new Map())).toBeNull()
  })
})

describe('antigravity', () => {
  test('SC-8 row: ask_permission waits, a busy Stop works, the idle Stop settles, later PostToolUse is ignored', () => {
    const { states, results } = run(normalizeAntigravity, [
      ['PreInvocation'],
      ['PreToolUse', { toolCall: { name: 'ask_permission', args: { Action: 'rm', Target: '/x' } } }],
      ['Stop', { fullyIdle: false }],
      ['Stop'],
      ['PostToolUse', { toolCall: { name: 'ls' } }],
    ])
    expect(states).toEqual(['working', 'waiting', 'working', 'done', 'none'])
    expect(results[0]?.newTurn).toBe(true)
    expect(results[1]?.fields.toolName).toBe('ask_permission')
  })

  test('the next PreInvocation reopens the transcript', () => {
    const t = { transcriptPath: '/t' }
    table(
      normalizeAntigravity,
      [['PreInvocation', t], ['Stop', t], ['PostToolUse', t], ['PreInvocation', t], ['PostToolUse', t]],
      ['working', 'done', 'none', 'working', 'working'],
    )
  })

  test('a Stop for another transcript is not suppressed', () => {
    table(
      normalizeAntigravity,
      [['Stop', { transcriptPath: '/a' }], ['PostToolUse', { transcriptPath: '/b' }]],
      ['done', 'working'],
    )
  })
})

describe('amp', () => {
  test('SC-8 row: cancelled agent.end is interrupted and later tool.result is ignored', () => {
    const { states, results } = run(normalizeAmp, [
      ['agent.start', { threadId: 'T1', message: 'hello' }],
      ['tool.call', { threadId: 'T1', tool: 'Bash', input: { command: 'ls' } }],
      ['agent.end', { threadId: 'T1', status: 'cancelled' }],
      ['tool.result', { threadId: 'T1', tool: 'Bash' }],
    ])
    expect(states).toEqual(['working', 'working', 'done', 'none'])
    expect(results[0]).toMatchObject({ newTurn: true, fields: { prompt: 'hello' } })
    expect(results[1]?.fields).toMatchObject({ toolName: 'Bash', toolInput: 'ls' })
    expect(results[2]?.interrupted).toBe(true)
  })

  test('SC-10: the drop is per thread and agent.start reopens it', () => {
    table(
      normalizeAmp,
      [
        ['agent.start', { threadId: 'A' }],
        ['agent.end', { threadId: 'A' }],
        ['tool.call', { threadId: 'B', tool: 'x' }],
        ['tool.call', { threadId: 'A', tool: 'x' }],
        ['agent.start', { threadId: 'A' }],
        ['tool.call', { threadId: 'A', tool: 'x' }],
      ],
      ['working', 'done', 'working', 'none', 'working', 'working'],
    )
  })

  test('only the 32 most recent threads are remembered', () => {
    const cache = new Map<string, unknown>()
    normalizeAmp({ threadId: 'old' }, 'agent.end', cache)
    for (let i = 0; i < 32; i++) normalizeAmp({ threadId: `t${i}` }, 'agent.end', cache)
    expect(normalizeAmp({ threadId: 'old' }, 'tool.call', cache)?.state).toBe('working')
    expect(normalizeAmp({ threadId: 't31' }, 'tool.call', cache)).toBeNull()
  })

  test('session.start clears the thread and reports a cache reset', () => {
    const cache = new Map<string, unknown>()
    normalizeAmp({ threadId: 'A' }, 'agent.end', cache)
    const reset = normalizeAmp({ threadId: 'A' }, 'session.start', cache)
    expect(reset).toMatchObject({ state: null, cacheReset: true })
    expect(normalizeAmp({ threadId: 'A' }, 'tool.call', cache)?.state).toBe('working')
  })
})

describe('opencode family', () => {
  test('SC-8 row: opencode and opencode2', () => {
    for (const n of [normalizeOpencode, normalizeOpencode2]) {
      const { states, results } = run(n, [
        ['SessionStart'],
        ['SessionBusy'],
        ['PermissionRequest', { permission: 'bash', metadata: { command: 'rm -rf x' } }],
        ['SessionIdle'],
      ])
      expect(states).toEqual(['done', 'working', 'waiting', 'done'])
      expect(results[0]?.sessionBoundary).toBe(true)
      expect(results[2]?.fields).toMatchObject({ toolName: 'bash', toolInput: 'rm -rf x' })
    }
  })

  test('SC-8 row: mimo-code has no SessionStart boundary', () => {
    table(
      normalizeMimoCode,
      [['SessionStart'], ['SessionBusy'], ['AskUserQuestion', { questions: [{ question: 'ok?' }] }], ['SessionIdle']],
      ['none', 'working', 'waiting', 'done'],
    )
    const ask = normalizeMimoCode({ questions: [{ question: 'ok?' }], hook_event_name: 'AskUserQuestion' }, 'AskUserQuestion', new Map())
    expect(JSON.parse(ask?.fields.question ?? 'null')).toEqual({ questions: [{ question: 'ok?' }] })
  })

  test('root_turn_error_name decides the outcome of a done root', () => {
    const aborted = normalizeOpencode({ root_state: 'done', root_turn_error_name: 'MessageAbortedError' }, 'SessionIdle', new Map())
    expect(aborted).toMatchObject({ state: 'done', outcome: 'cancellation', interrupted: true })
    const failed = normalizeOpencode({ root_state: 'done', root_turn_error_name: 'APIError' }, 'SessionIdle', new Map())
    expect(failed).toMatchObject({ state: 'done', outcome: 'failure' })
    expect(failed?.interrupted).toBeUndefined()
    const mimo = normalizeMimoCode({ root_state: 'done', root_turn_error_name: 'APIError' }, 'SessionIdle', new Map())
    expect(mimo?.outcome).toBeUndefined()
  })

  test('a user-role MessagePart is the prompt and starts a turn', () => {
    const user = normalizeOpencode({ role: 'user', text: 'do it' }, 'MessagePart', new Map())
    expect(user).toMatchObject({ state: 'working', newTurn: true, fields: { prompt: 'do it' } })
    const assistant = normalizeOpencode({ role: 'assistant', text: 'ok' }, 'MessagePart', new Map())
    expect(assistant).toMatchObject({ state: 'working', newTurn: false, fields: { lastAssistantMessage: 'ok' } })
  })
})

describe('cursor', () => {
  test('SC-8 row: aborted stop is interrupted and a late afterAgentResponse stays done', () => {
    const { states, results } = run(normalizeCursor, [
      ['beforeSubmitPrompt', { prompt: 'go' }],
      ['beforeShellExecution', { command: 'ls' }],
      ['stop', { status: 'aborted' }],
      ['afterAgentResponse', { text: 'final text' }],
    ])
    expect(states).toEqual(['working', 'working', 'done', 'done'])
    expect(results[0]?.newTurn).toBe(true)
    expect(results[1]?.fields).toMatchObject({ toolName: 'Shell', toolInput: 'ls' })
    expect(results[2]?.interrupted).toBe(true)
    expect(results[3]?.fields.lastAssistantMessage).toBe('final text')
  })

  test('afterAgentResponse mid-turn is working, and a completed stop is not interrupted', () => {
    const { states, results } = run(normalizeCursor, [
      ['sessionStart'],
      ['afterAgentResponse', { text: 'x' }],
      ['stop', { status: 'completed' }],
      ['sessionEnd'],
    ])
    expect(states).toEqual(['working', 'working', 'done', 'done'])
    expect(results[2]?.interrupted).toBeUndefined()
  })
})

describe('pi family', () => {
  test('SC-8 row: pi', () => {
    const { states, results } = run(normalizePi, [
      ['agent_start'],
      ['tool_call', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'a?' }] } }],
      ['ui_prompt_start'],
      ['ui_prompt_end', { is_idle: false }],
      ['agent_end'],
    ])
    expect(states).toEqual(['working', 'blocked', 'waiting', 'working', 'done'])
    expect(JSON.parse(results[1]?.fields.question ?? 'null')).toEqual({ questions: [{ question: 'a?' }] })
  })

  test('ui_prompt_end with is_idle is done; ui_prompt_active marks any event waiting', () => {
    table(normalizePi, [['ui_prompt_end', { is_idle: true }]], ['done'])
    table(normalizePi, [['tool_call', { tool_name: 'bash', ui_prompt_active: true }]], ['waiting'])
  })

  test('SC-8 row: omp holds the approval through the tool start until it resolves', () => {
    const { states, results } = run(normalizeOmp, [
      ['agent_start'],
      ['tool_approval_requested', { tool_name: 'bash', reason: 'run rm' }],
      ['tool_execution_start', { tool_name: 'bash' }],
      ['tool_approval_resolved', { tool_name: 'bash' }],
      ['agent_end'],
    ])
    expect(states).toEqual(['working', 'blocked', 'none', 'working', 'done'])
    expect(results[1]?.fields).toMatchObject({ toolName: 'bash', toolInput: 'run rm' })
  })

  test('omp: a new turn releases an unresolved approval, and the ask tool is its own wait', () => {
    table(
      normalizeOmp,
      [
        ['tool_approval_requested', { tool_name: 'bash' }],
        ['tool_execution_end', { tool_name: 'bash' }],
        ['agent_start'],
        ['tool_call', { tool_name: 'ask', tool_input: { questions: [] } }],
        ['tool_execution_start', { tool_name: 'ask' }],
        ['tool_execution_end', { tool_name: 'ask' }],
      ],
      ['blocked', 'none', 'working', 'blocked', 'blocked', 'working'],
    )
  })

  test('pi: ask tool name matters per agent', () => {
    table(normalizePi, [['tool_call', { tool_name: 'ask' }]], ['working'])
    table(normalizeOmp, [['tool_call', { tool_name: 'AskUserQuestion' }]], ['working'])
    table(normalizePrimeAgent, [['tool_call', { tool_name: 'AskUserQuestion' }]], ['working'])
  })

  test('SC-8 row: prime-agent', () => {
    const { states, results } = run(normalizePrimeAgent, [['before_agent_start'], ['agent_end']])
    expect(states).toEqual(['working', 'done'])
    expect(results[0]?.newTurn).toBe(true)
  })

  test('session_start resets the cache; model_select and subagents_update carry no state', () => {
    expect(normalizePi({}, 'session_start', new Map())).toMatchObject({ state: null, cacheReset: true })
    expect(normalizePi({ model: 'm1' }, 'model_select', new Map())).toMatchObject({ state: null, fields: { model: 'm1' } })
    expect(normalizePi({}, 'model_select', new Map())).toBeNull()
    expect(normalizePi({ subagents: [] }, 'subagents_update', new Map())?.state).toBeNull()
  })

  test('agent_end with session_boundary is a boundary', () => {
    expect(normalizePi({ session_boundary: true }, 'agent_end', new Map())).toMatchObject({ state: 'done', sessionBoundary: true })
  })
})

describe('droid', () => {
  test('SC-8 row: high risk waits, the idle notification settles', () => {
    table(
      normalizeDroid,
      [
        ['UserPromptSubmit', { prompt: 'go' }],
        ['PreToolUse', { tool_name: 'Execute', riskLevel: 'high' }],
        ['Notification', { message: 'Droid is waiting for your input' }],
      ],
      ['working', 'waiting', 'done'],
    )
  })

  test('notification, ask-user and permission rules', () => {
    table(
      normalizeDroid,
      [
        ['PreToolUse', { tool_name: 'AskUser' }],
        ['PreToolUse', { tool_name: 'Read', tool_input: { risk_level: 'low' } }],
        ['PermissionRequest', { tool_name: 'Execute' }],
        ['Notification', { message: 'Needs approval to continue' }],
        ['Notification', { message: 'task confirmed' }],
        ['Stop'],
        ['SessionStart'],
      ],
      ['waiting', 'working', 'waiting', 'waiting', 'none', 'done', 'none'],
    )
    expect(normalizeDroid({}, 'SessionStart', new Map())?.cacheReset).toBe(true)
  })
})

describe('command-code', () => {
  test('SC-8 row', () => {
    const { states, results } = run(normalizeCommandCode, [
      ['PreToolUse', { tool_name: 'shell', tool_input: { command: 'ls' } }],
      ['Stop', { last_assistant_message: 'ok' }],
    ])
    expect(states).toEqual(['working', 'done'])
    expect(results[0]).toMatchObject({ newTurn: false, fields: { toolName: 'shell', toolInput: 'ls' } })
  })
})

describe('grok', () => {
  test('SC-8 row: ask_user_question waits, stop_cancelled is interrupted', () => {
    const { states, results } = run(normalizeGrok, [
      ['user_prompt_submit', { prompt: '<user_query>build</user_query>', promptId: 'p1' }],
      ['pre_tool_use', { toolName: 'ask_user_question', toolInput: { questions: [{ question: 'x' }] } }],
      ['stop_cancelled', { promptId: 'p1' }],
    ])
    expect(states).toEqual(['working', 'waiting', 'done'])
    expect(results[0]).toMatchObject({ newTurn: true, fields: { prompt: 'build' } })
    expect(results[2]).toMatchObject({ outcome: 'cancellation', interrupted: true })
  })

  test('event names are snake-cased', () => {
    table(normalizeGrok, [['UserPromptSubmit'], ['PreToolUse', { toolName: 'bash' }], ['Stop']], ['working', 'working', 'done'])
  })

  test('failure outcome and session boundaries', () => {
    expect(normalizeGrok({}, 'stop_failure', new Map())).toMatchObject({ state: 'done', outcome: 'failure' })
    expect(normalizeGrok({ reason: 'shutdown' }, 'stop', new Map())?.sessionBoundary).toBe(true)
    expect(normalizeGrok({ reason: 'end_turn' }, 'stop', new Map())?.sessionBoundary).toBeUndefined()
    expect(normalizeGrok({}, 'session_end', new Map())).toMatchObject({ state: 'done', sessionBoundary: true })
  })

  test('notifications: permission waits, idle_prompt settles, routine and task_complete are ignored', () => {
    table(
      normalizeGrok,
      [
        ['notification', { notificationType: 'permission_prompt', message: 'Needs your permission' }],
        ['notification', { notificationType: 'permission_prompt', message: 'Tool permission requested', level: 'info' }],
        ['notification', { notificationType: 'task_complete' }],
        ['notification', { notificationType: 'idle_prompt' }],
        ['notification', { notificationType: 'other', message: 'hello' }],
      ],
      ['waiting', 'none', 'none', 'done', 'none'],
    )
  })

  test('subagent events and session_start say nothing; session_start resets', () => {
    expect(normalizeGrok({ subagentType: 'explore' }, 'stop', new Map())).toBeNull()
    expect(normalizeGrok({}, 'session_start', new Map())).toMatchObject({ state: null, cacheReset: true })
  })

  test('SC-6: a stop listing a shell task reports it, a later stop listing none reports none', () => {
    const { results } = run(normalizeGrok, [
      ['user_prompt_submit', { promptId: 'p1' }],
      ['stop', { promptId: 'p1', backgroundTasks: [{ id: 'sh1', type: 'shell' }] }],
      ['stop', { promptId: 'p1', backgroundTasks: [] }],
    ])
    expect(results[1]?.state).toBe('done')
    expect(results[1]?.inventory).toEqual({ tasks: [{ id: 'sh1', kind: 'shell', running: true }], complete: true })
    expect(results[2]?.inventory).toEqual({ tasks: [], complete: true })
  })

  test('SC-6: subagent tasks are agents; monitors are left out', () => {
    const n = normalizeGrok(
      {
        background_tasks: [
          { id: 'a1', type: 'subagent' },
          { id: 'm1', type: 'monitor' },
          { id: 'sh1', type: 'shell' },
        ],
      },
      'stop',
      new Map(),
    )
    expect(n?.inventory?.tasks).toEqual([
      { id: 'a1', kind: 'agent', running: true },
      { id: 'sh1', kind: 'shell', running: true },
    ])
  })

  test('SC-6: an active stop hook holds the turn like a shell; a session boundary reports none', () => {
    const hook = normalizeGrok({ stopHookActive: true }, 'stop', new Map())
    expect(hook?.inventory?.tasks.map((t) => t.kind)).toEqual(['shell'])
    const shutdown = normalizeGrok({ reason: 'shutdown', backgroundTasks: [{ id: 's', type: 'shell' }] }, 'stop', new Map())
    expect(shutdown?.inventory).toEqual({ tasks: [], complete: true })
  })

  test('SC-10: a stop for an older prompt id is ignored', () => {
    const { states } = run(normalizeGrok, [
      ['user_prompt_submit', { promptId: 'p1' }],
      ['user_prompt_submit', { promptId: 'p2' }],
      ['stop', { promptId: 'p1' }],
      ['stop_failure', { promptId: 'p1' }],
      ['stop_cancelled', { promptId: 'p1' }],
      ['stop', { promptId: 'p2' }],
    ])
    expect(states).toEqual(['working', 'working', 'none', 'none', 'none', 'done'])
  })

  test('a stop without a prompt id, or with no recorded turn, applies', () => {
    table(normalizeGrok, [['user_prompt_submit', { promptId: 'p1' }], ['stop']], ['working', 'done'])
    table(normalizeGrok, [['stop', { promptId: 'p9' }]], ['done'])
  })

  test('an idle prompt restates the finished turn outcome', () => {
    const { results } = run(normalizeGrok, [
      ['stop_failure', {}],
      ['notification', { notificationType: 'idle_prompt' }],
    ])
    expect(results[1]).toMatchObject({ state: 'done', outcome: 'failure' })
  })
})

describe('copilot', () => {
  test('SC-8 row: permission_prompt blocks, ErrorOccurred depends on recoverable', () => {
    table(
      normalizeCopilot,
      [
        ['userPromptSubmitted', { prompt: 'go' }],
        ['notification', { notification_type: 'permission_prompt' }],
        ['errorOccurred', { recoverable: true }],
        ['errorOccurred', { recoverable: false }],
      ],
      ['working', 'blocked', 'working', 'done'],
    )
  })

  test('event names go through normalizeCopilotEventName', () => {
    const { states, results } = run(normalizeCopilot, [
      ['sessionStart', { initialPrompt: 'hi' }],
      ['preToolUse', { toolName: 'bash', toolArgs: { command: 'ls' } }],
      ['permissionRequest', { toolName: 'ask_user', toolArgs: { question: 'which?' } }],
      ['PermissionRequest', { toolName: 'bash' }],
      ['postToolUse'],
      ['agentStop', { last_assistant_message: 'bye' }],
      ['sessionEnd'],
    ])
    expect(states).toEqual(['working', 'working', 'blocked', 'working', 'working', 'done', 'done'])
    expect(results[0]).toMatchObject({ eventName: 'SessionStart', newTurn: true, fields: { prompt: 'hi' } })
    expect(results[1]?.fields).toMatchObject({ toolName: 'bash', toolInput: 'ls' })
    expect(results[5]?.fields.lastAssistantMessage).toBe('bye')
  })

  test('elicitation_dialog blocks; other notifications say nothing', () => {
    table(
      normalizeCopilot,
      [['Notification', { notificationType: 'elicitation_dialog' }], ['Notification', { notification_type: 'info' }]],
      ['blocked', 'none'],
    )
  })
})

describe('hermes', () => {
  test('SC-8 row', () => {
    const { states, results } = run(normalizeHermes, [
      ['on_session_start'],
      ['pre_llm_call', { prompt: 'go' }],
      ['pre_approval_request', { command: 'rm x' }],
      ['post_approval_response'],
      ['post_llm_call', { last_assistant_message: 'done' }],
    ])
    expect(states).toEqual(['done', 'working', 'waiting', 'working', 'done'])
    expect(results[0]).toMatchObject({ sessionBoundary: true, newTurn: true })
    expect(results[1]).toMatchObject({ newTurn: true, fields: { prompt: 'go' } })
    expect(results[2]?.fields).toMatchObject({ toolName: 'approval', toolInput: 'rm x' })
    expect(results[4]?.sessionBoundary).toBeUndefined()
  })

  test('session end events settle without a boundary', () => {
    table(normalizeHermes, [['on_session_end'], ['on_session_finalize'], ['on_session_reset'], ['pre_tool_call'], ['other']], ['done', 'done', 'done', 'working', 'none'])
  })
})

describe('devin', () => {
  test('SC-8 row: interrupt stop', () => {
    const { states, results } = run(normalizeDevin, [
      ['SessionStart'],
      ['UserPromptSubmit', { prompt: 'go' }],
      ['PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
      ['Stop', { is_interrupt: true }],
    ])
    expect(states).toEqual(['none', 'working', 'waiting', 'done'])
    expect(results[0]?.cacheReset).toBe(true)
    expect(results[3]?.interrupted).toBe(true)
  })

  test('PreToolUse, PostToolUse, PostCompaction work; SessionEnd settles', () => {
    table(normalizeDevin, [['PreToolUse'], ['PostToolUse'], ['PostCompaction'], ['SessionEnd']], ['working', 'working', 'working', 'done'])
  })
})

describe('kimi', () => {
  test('SC-8 row: StopFailure is a failed done', () => {
    const { states, results } = run(normalizeKimi, [
      ['UserPromptSubmit', { prompt: 'go' }],
      ['PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'q' }] } }],
      ['StopFailure'],
    ])
    expect(states).toEqual(['working', 'waiting', 'done'])
    expect(results[2]?.outcome).toBe('failure')
    expect(JSON.parse(results[1]?.fields.question ?? 'null')).toEqual({ questions: [{ question: 'q' }] })
  })

  test('a content-block prompt array is joined; compact continuation prompts are ignored', () => {
    const n = normalizeKimi({ prompt: [{ type: 'text', text: 'hello' }, { text: 'world' }] }, 'UserPromptSubmit', new Map())
    expect(n?.fields.prompt).toBe('hello world')
    expect(normalizeKimi({ prompt: 'This session is being continued from a previous conversation...' }, 'UserPromptSubmit', new Map())).toBeNull()
  })

  test('PermissionRequest waits; interrupt stop is interrupted', () => {
    const { states, results } = run(normalizeKimi, [['PermissionRequest'], ['Stop', { is_interrupt: true }]])
    expect(states).toEqual(['waiting', 'done'])
    expect(results[1]?.interrupted).toBe(true)
  })
})

describe('muse', () => {
  test('SC-8 row: PermissionRequest is remembered, the permission_prompt notification waits with its tool', () => {
    const { states, results } = run(normalizeMuse, [
      ['UserPromptSubmit', { prompt: 'go', session_id: 's1', turn_id: 't1' }],
      ['PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' }, session_id: 's1', turn_id: 't1' }],
      ['Notification', { notification_type: 'permission_prompt', message: 'dir - waiting', session_id: 's1', turn_id: 't1' }],
      ['Stop', { session_id: 's1', turn_id: 't1' }],
    ])
    expect(states).toEqual(['working', 'none', 'waiting', 'done'])
    expect(results[1]).toBeNull()
    expect(results[2]?.fields).toMatchObject({ toolName: 'Bash', toolInput: 'rm x' })
    expect(results[2]?.fields.prompt).toBeUndefined()
  })

  test('other notifications and PreToolUse AskUserQuestion', () => {
    table(
      normalizeMuse,
      [
        ['Notification', { notification_type: 'idle_prompt' }],
        ['PreToolUse', { tool_name: 'AskUserQuestion' }],
        ['PreToolUse', { tool_name: 'Bash' }],
      ],
      ['none', 'waiting', 'working'],
    )
  })

  test('events from child sessions are ignored, registered by SubagentStart or turn_id == session_id', () => {
    table(
      normalizeMuse,
      [
        ['SubagentStart', { child_session_id: 'c1', session_id: 'lead' }],
        ['PostToolUse', { session_id: 'c1', turn_id: 'x' }],
        ['Stop', { session_id: 'c2', turn_id: 'c2' }],
        ['PostToolUse', { session_id: 'lead', turn_id: 't' }],
      ],
      ['none', 'none', 'none', 'working'],
    )
  })

  test('StopFailure fails the turn', () => {
    expect(normalizeMuse({}, 'StopFailure', new Map())).toMatchObject({ state: 'done', outcome: 'failure' })
  })
})

describe('dsh', () => {
  test('SC-8 row', () => {
    const { states, results } = run(normalizeDsh, [
      ['SessionStart'],
      ['UserPromptSubmit', { prompt: 'go' }],
      ['PreToolUse', { tool_name: 'ask_user_question', tool_input: { questions: [] } }],
      ['Stop'],
    ])
    expect(states).toEqual(['done', 'working', 'waiting', 'done'])
    expect(results[0]).toMatchObject({ sessionBoundary: true, newTurn: true })
  })

  test('subagent events are ignored; an approval pause is just working', () => {
    table(normalizeDsh, [['SubagentStart'], ['SubagentStop'], ['PreToolUse', { tool_name: 'Bash' }], ['PostToolUse']], ['none', 'none', 'working', 'working'])
  })
})

describe('zcode', () => {
  test('SC-8 row', () => {
    const { states, results } = run(normalizeZcode, [
      ['SessionStart', { source: 'startup' }],
      ['UserPromptSubmit', { prompt: 'go' }],
      ['PermissionRequest', { tool_name: 'Bash' }],
      ['Stop'],
    ])
    expect(states).toEqual(['done', 'working', 'waiting', 'done'])
    expect(results[0]).toMatchObject({ sessionBoundary: true, newTurn: true })
  })

  test('only idle SessionStart sources count; AskUserQuestion waits', () => {
    table(
      normalizeZcode,
      [['SessionStart', { source: 'compact' }], ['SessionStart', { source: 'resume' }], ['PreToolUse', { tool_name: 'AskUserQuestion' }]],
      ['none', 'done', 'waiting'],
    )
  })
})

describe('jcode', () => {
  test('SC-8 row', () => {
    const { states, results } = run(normalizeJcode, [
      ['session_start', { model: 'm' }],
      ['turn_start', { model: 'm' }],
      ['pre_tool', { tool_name: 'request_permission', tool_input: '{"intent":"need access","path":"/x"}' }],
      ['turn_end', { last_assistant_text: 'finished' }],
    ])
    expect(states).toEqual(['none', 'working', 'waiting', 'done'])
    expect(results[0]?.cacheReset).toBe(true)
    expect(results[1]).toMatchObject({ newTurn: true, fields: { model: 'm' } })
    expect(JSON.parse(results[2]?.fields.question ?? 'null')).toEqual({ intent: 'need access', path: '/x' })
    expect(results[3]?.fields.lastAssistantMessage).toBe('finished')
  })

  test('tool input is parsed from its JSON string; session_end settles', () => {
    const { states, results } = run(normalizeJcode, [['pre_tool', { tool_name: 'read', tool_input: '{"file_path":"/a"}' }], ['post_tool', { tool_name: 'read' }], ['session_end']])
    expect(states).toEqual(['working', 'working', 'done'])
    expect(results[0]?.fields).toMatchObject({ toolName: 'read', toolInput: '/a' })
  })

  test('a failed turn reports its error', () => {
    const n = normalizeJcode({ status: 'error', error: 'boom' }, 'turn_end', new Map())
    expect(n?.fields.lastAssistantMessage).toBe('boom')
  })
})

describe('kiro', () => {
  test('SC-8 row', () => {
    const { states, results } = run(normalizeKiro, [
      ['agentSpawn'],
      ['userPromptSubmit', { prompt: 'go' }],
      ['preToolUse', { tool_name: 'execute_bash', tool_input: { command: 'ls' } }],
      ['stop', { assistant_response: 'all done' }],
    ])
    expect(states).toEqual(['done', 'working', 'working', 'done'])
    expect(results[0]).toMatchObject({ newTurn: true })
    expect(results[0]?.sessionBoundary).toBeUndefined()
    expect(results[3]?.fields.lastAssistantMessage).toBe('all done')
  })
})
