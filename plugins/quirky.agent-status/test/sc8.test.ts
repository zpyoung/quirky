import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { Rig } from './support'

type State = 'working' | 'waiting' | 'blocked' | 'done' | null
/** What the row shows after an event; flags are checked only when named. */
type Expect = State | [State, { boundary?: true; interrupted?: true; failed?: true }]
/** How the event name travels: in the payload's own name field, in the shim's `event` query, or as jcode's `event` key. */
type Via = 'name' | 'query' | 'key'
type Step = [event: string, payload?: Record<string, unknown>]
type Row = { agent: string; via?: Via; steps: Step[]; expect: Expect[]; shownAs?: string }

const ask = { questions: [{ question: 'a?' }] }
const boundary = { boundary: true } as const
const interrupted = { interrupted: true } as const

const TABLE: Row[] = [
  ...(['qoder', 'qoder-cn'] as const).map(
    (agent): Row => ({
      agent,
      steps: [
        ['SessionStart', { source: 'new', session_id: 'q1', transcript_path: '/q.jsonl' }],
        ['UserPromptSubmit', { prompt: 'refactor' }],
        ['Notification', { notification_type: 'permission_prompt', message: 'needs permission' }],
        ['PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/a.ts' } }],
        ['Notification', { notification_type: 'idle_prompt' }]
      ],
      expect: [['done', boundary], 'working', 'waiting', 'working', 'done']
    })
  ),
  {
    agent: 'codebuddy',
    steps: [['SessionStart', { source: 'startup' }], ['UserPromptSubmit', { prompt: 'build' }], ['PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ask }], ['Stop']],
    expect: [null, 'working', 'working', 'done']
  },
  {
    agent: 'qwen-code',
    steps: [['UserPromptSubmit', { prompt: 'go' }], ['PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }], ['Stop']],
    expect: ['working', 'waiting', 'done']
  },
  {
    agent: 'openclaude',
    steps: [['UserPromptSubmit', { prompt: 'go' }], ['PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ask }], ['Stop']],
    expect: ['working', 'waiting', 'done']
  },
  {
    agent: 'gemini',
    steps: [['BeforeAgent', { prompt: 'fix it' }], ['BeforeTool', { tool_name: 'run_shell_command', tool_input: { command: 'ls' } }], ['AfterAgent', { prompt_response: 'done!' }]],
    expect: ['working', 'working', 'done']
  },
  {
    agent: 'antigravity',
    via: 'query',
    steps: [
      ['PreInvocation'],
      ['PreToolUse', { toolCall: { name: 'ask_permission', args: { Action: 'rm', Target: '/x' } } }],
      ['Stop', { fullyIdle: false }],
      ['Stop'],
      ['PostToolUse', { toolCall: { name: 'ls' } }]
    ],
    expect: ['working', 'waiting', 'working', 'done', 'done']
  },
  {
    agent: 'amp',
    steps: [
      ['agent.start', { threadId: 'T1', message: 'hello' }],
      ['tool.call', { threadId: 'T1', tool: 'Bash', input: { command: 'ls' } }],
      ['agent.end', { threadId: 'T1', status: 'cancelled' }],
      ['tool.result', { threadId: 'T1', tool: 'Bash' }]
    ],
    expect: ['working', 'working', ['done', interrupted], ['done', interrupted]]
  },
  ...(['opencode', 'opencode2'] as const).map(
    (agent): Row => ({
      agent,
      steps: [['SessionStart'], ['SessionBusy'], ['PermissionRequest', { permission: 'bash', metadata: { command: 'rm -rf x' } }], ['SessionIdle']],
      expect: [['done', boundary], 'working', 'waiting', 'done']
    })
  ),
  {
    agent: 'mimo-code',
    steps: [['SessionStart'], ['SessionBusy'], ['AskUserQuestion', { questions: [{ question: 'ok?' }] }], ['SessionIdle']],
    expect: [null, 'working', 'waiting', 'done']
  },
  {
    agent: 'cursor',
    via: 'query',
    steps: [['beforeSubmitPrompt', { prompt: 'go' }], ['beforeShellExecution', { command: 'ls' }], ['stop', { status: 'aborted' }], ['afterAgentResponse', { text: 'final text' }]],
    expect: ['working', 'working', ['done', interrupted], ['done', interrupted]]
  },
  {
    agent: 'pi',
    steps: [['agent_start'], ['tool_call', { tool_name: 'AskUserQuestion', tool_input: ask }], ['ui_prompt_start'], ['ui_prompt_end', { is_idle: false }], ['agent_end']],
    expect: ['working', 'blocked', 'waiting', 'working', 'done']
  },
  {
    agent: 'omp',
    steps: [
      ['agent_start'],
      ['tool_approval_requested', { tool_name: 'bash', reason: 'run rm' }],
      ['tool_execution_start', { tool_name: 'bash' }],
      ['tool_approval_resolved', { tool_name: 'bash' }],
      ['agent_end']
    ],
    expect: ['working', 'blocked', 'blocked', 'working', 'done']
  },
  { agent: 'prime-agent', steps: [['before_agent_start'], ['agent_end']], expect: ['working', 'done'] },
  {
    agent: 'droid',
    steps: [
      ['UserPromptSubmit', { prompt: 'go' }],
      ['PreToolUse', { tool_name: 'Execute', riskLevel: 'high' }],
      ['Notification', { message: 'Droid is waiting for your input' }]
    ],
    expect: ['working', 'waiting', 'done']
  },
  {
    agent: 'command-code',
    steps: [['PreToolUse', { tool_name: 'shell', tool_input: { command: 'ls' } }], ['Stop', { last_assistant_message: 'ok' }]],
    expect: ['working', 'done']
  },
  {
    agent: 'grok',
    steps: [
      ['user_prompt_submit', { prompt: '<user_query>build</user_query>', promptId: 'p1' }],
      ['pre_tool_use', { toolName: 'ask_user_question', toolInput: { questions: [{ question: 'x' }] } }],
      ['stop_cancelled', { promptId: 'p1' }]
    ],
    expect: ['working', 'waiting', ['done', interrupted]]
  },
  {
    agent: 'copilot',
    via: 'query',
    steps: [
      ['userPromptSubmitted', { prompt: 'go' }],
      ['notification', { notification_type: 'permission_prompt' }],
      ['errorOccurred', { recoverable: true }],
      ['errorOccurred', { recoverable: false }]
    ],
    expect: ['working', 'blocked', 'working', 'done']
  },
  {
    agent: 'hermes',
    steps: [
      ['on_session_start'],
      ['pre_llm_call', { prompt: 'go' }],
      ['pre_approval_request', { command: 'rm x' }],
      ['post_approval_response'],
      ['post_llm_call', { last_assistant_message: 'done' }]
    ],
    expect: [['done', boundary], 'working', 'waiting', 'working', 'done']
  },
  {
    agent: 'devin',
    steps: [
      ['SessionStart'],
      ['UserPromptSubmit', { prompt: 'go' }],
      ['PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }],
      ['Stop', { is_interrupt: true }]
    ],
    expect: [null, 'working', 'waiting', ['done', interrupted]]
  },
  {
    agent: 'kimi',
    steps: [['UserPromptSubmit', { prompt: 'go' }], ['PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ask }], ['StopFailure']],
    expect: ['working', 'waiting', ['done', { failed: true }]]
  },
  {
    agent: 'muse',
    steps: [
      ['UserPromptSubmit', { prompt: 'go', session_id: 'm1', turn_id: 't1' }],
      ['PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' }, session_id: 'm1', turn_id: 't1' }],
      ['Notification', { notification_type: 'permission_prompt', message: 'dir - waiting', session_id: 'm1', turn_id: 't1' }],
      ['Stop', { session_id: 'm1', turn_id: 't1' }]
    ],
    expect: ['working', 'working', 'waiting', 'done']
  },
  {
    agent: 'dsh',
    steps: [['SessionStart'], ['UserPromptSubmit', { prompt: 'go' }], ['PreToolUse', { tool_name: 'ask_user_question', tool_input: { questions: [] } }], ['Stop']],
    expect: [['done', boundary], 'working', 'waiting', 'done']
  },
  {
    agent: 'zcode',
    steps: [['SessionStart', { source: 'startup' }], ['UserPromptSubmit', { prompt: 'go' }], ['PermissionRequest', { tool_name: 'Bash' }], ['Stop']],
    expect: [['done', boundary], 'working', 'waiting', 'done']
  },
  {
    agent: 'jcode',
    via: 'key',
    steps: [
      ['session_start', { model: 'm' }],
      ['turn_start', { model: 'm' }],
      ['pre_tool', { tool_name: 'request_permission', tool_input: '{"intent":"need access","path":"/x"}' }],
      ['turn_end', { last_assistant_text: 'finished' }]
    ],
    expect: [null, 'working', 'waiting', 'done']
  },
  {
    agent: 'kiro',
    steps: [['agentSpawn'], ['userPromptSubmit', { prompt: 'go' }], ['preToolUse', { tool_name: 'execute_bash', tool_input: { command: 'ls' } }], ['stop', { assistant_response: 'all done' }]],
    expect: ['done', 'working', 'working', 'done']
  }
]

const COARSE = { working: 'working', waiting: 'waiting', blocked: 'waiting', done: 'done' } as const

let rig: Rig
const sessionOf = (index: number) => `s${index}`

beforeAll(async () => {
  rig = await Rig.start({ sessions: TABLE.map((row, index) => ({ id: sessionOf(index), agent: row.agent })) })
})

afterAll(async () => {
  await rig.cleanup()
  removeTempDirs()
})

describe('SC-8: every agent maps its events as Orca does', () => {
  TABLE.forEach((row, index) => {
    test(`${row.agent}: ${row.steps.map(([event]) => event).join(', ')}`, async () => {
      const session = sessionOf(index)
      for (const [at, [event, payload = {}]] of row.steps.entries()) {
        const via = row.via ?? 'name'
        const body = via === 'name' ? { hook_event_name: event, ...payload } : via === 'key' ? { event, ...payload } : payload
        await rig.hook(row.agent, body, { session, ...(via === 'query' ? { event } : {}) })

        const wanted = row.expect[at]!
        const [state, flags] = Array.isArray(wanted) ? wanted : [wanted, {}]
        const found = await rig.row(session)
        expect(found?.state ?? null, `${row.agent} step ${at + 1} (${event})`).toBe(state)
        if (found) expect(found.agent).toBe(row.agent)
        expect((await rig.session(session)).status, `${row.agent} step ${at + 1} coarse status`).toBe(state === null ? 'running' : COARSE[state])
        if (flags?.boundary) expect(found?.sessionBoundary).toBe(true)
        if (flags?.interrupted) expect(found).toMatchObject({ interrupted: true, display: 'interrupted' })
        if (flags?.failed) expect(found).toMatchObject({ outcome: 'failure', display: 'failed' })
      }
    })
  })
})
