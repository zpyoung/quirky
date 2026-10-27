import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { HOOK_TOKEN_HEADER } from '@quirky/protocol'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { makeTempHome, Rig, startOf, waitFor } from './support'

const NOTIFICATIONS = 'setting:quirky.agent-status/notifications'

let rig: Rig

afterEach(async () => {
  await rig?.cleanup()
  removeTempDirs()
})

const claude = (name: string, payload: Record<string, unknown> = {}) => ({ hook_event_name: name, ...payload })
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra })
const ask = { questions: [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }] }

/** Sends events to a Claude session one after another. */
async function play(events: [string, Record<string, unknown>?][], session = 's1') {
  for (const [name, payload] of events) await rig.hook('claude', claude(name, payload), { session })
}

describe('SC-1: a Claude turn', () => {
  test('moves through boundary, working, waiting and done with the coarse status in step', async () => {
    rig = await Rig.start()
    const seen: { state: string | null; status: string; row: Awaited<ReturnType<Rig['row']>> }[] = []
    const step = async (name: string, payload: Record<string, unknown> = {}) => {
      await rig.hook('claude', claude(name, payload))
      const row = await rig.row()
      seen.push({ state: row?.state ?? null, status: (await rig.session()).status, row })
    }
    await step('SessionStart', { source: 'startup', session_id: 'abc' })
    await step('UserPromptSubmit', { prompt: 'fix the tests' })
    await step('PreToolUse', bash('npm test', { tool_use_id: 't1' }))
    await step('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_use_id: 't2' })
    await step('PermissionRequest', bash('npm test', { tool_use_id: 't1' }))
    await step('PostToolUse', bash('npm test', { tool_use_id: 't1' }))
    await step('Stop', { last_assistant_message: 'All green' })

    expect(seen.map((s) => s.state)).toEqual(['done', 'working', 'working', 'working', 'waiting', 'working', 'done'])
    expect(seen.map((s) => s.status)).toEqual(['done', 'working', 'working', 'working', 'waiting', 'working', 'done'])
    expect(seen[0]!.row).toMatchObject({ sessionBoundary: true, agent: 'claude' })
    expect(seen[1]!.row).toMatchObject({ prompt: 'fix the tests' })
    expect(seen[3]!.row).toMatchObject({ toolName: 'Read', stateStartedAt: seen[1]!.row!.stateStartedAt })
    expect(seen[2]!.row).toMatchObject({ toolName: 'Bash', stateStartedAt: seen[1]!.row!.stateStartedAt })
    expect(seen[4]!.row).toMatchObject({ detail: 'Bash: npm test', display: 'waiting' })
    expect(seen[6]!.row).toMatchObject({ outcome: 'success', lastAssistantMessage: 'All green', display: 'done', detail: 'All green' })

    await rig.waitForNotifies(2)
    await rig.settle()
    expect(rig.notifies().map((n) => (n as { body: string }).body)).toEqual(['Claude needs input', 'Claude finished'])
  })

  test('each row change reaches the session as a summary, and the summary tracks the row', async () => {
    rig = await Rig.start()
    await play([['UserPromptSubmit', { prompt: 'go' }]])
    const row = (await rig.row())!
    expect((await rig.session()).agentStatus).toMatchObject({
      state: 'working',
      display: 'working',
      label: 'Working',
      stateStartedAt: row.stateStartedAt,
      evidenceAt: row.evidenceAt,
      restoredUnconfirmed: false
    })
    const events = rig.events.filter((e) => e.type === 'quirky.agent-status/changed')
    expect(events.at(-1)).toMatchObject({ data: { sessionId: 's1', row: { state: 'working', prompt: 'go' } } })
  })
})

describe('SC-2: the permission hold', () => {
  async function waitingOn(session: string) {
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'go' }), { session })
    await rig.hook('claude', claude('PermissionRequest', bash('npm test', { tool_use_id: 't1' })), { session })
    expect(await rig.state(session)).toBe('waiting')
  }

  test('an unrelated tool keeps it waiting, the approved tool resuming releases it, and so does a prompt', async () => {
    rig = await Rig.start({ sessions: [{}, { id: 's2' }, { id: 's3' }] })
    await waitingOn('s1')
    await waitingOn('s2')
    await waitingOn('s3')

    await rig.hook('claude', claude('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_use_id: 'r1' }), { session: 's1' })
    expect(await rig.row('s1')).toMatchObject({ state: 'waiting', detail: 'Bash: npm test' })

    await rig.hook('claude', claude('PreToolUse', bash('npm test', { tool_use_id: 't1' })), { session: 's2' })
    expect(await rig.state('s2')).toBe('working')

    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'never mind' }), { session: 's3' })
    expect(await rig.row('s3')).toMatchObject({ state: 'working', prompt: 'never mind' })
  })

  test('a child tool of the same name and input under another id leaves the hold, and the approved id still releases it', async () => {
    rig = await Rig.start()
    await play([['UserPromptSubmit', { prompt: 'go' }], ['SubagentStart', { agent_id: 'a1' }]])
    await rig.hook('claude', claude('PermissionRequest', bash('ls', { agent_id: 'a1', tool_use_id: 't1' })))
    await rig.hook('claude', claude('PreToolUse', bash('ls', { agent_id: 'a1', tool_use_id: 't2' })))
    expect(await rig.state()).toBe('waiting')
    await rig.hook('claude', claude('PostToolUse', bash('ls', { agent_id: 'a1', tool_use_id: 't1' })))
    expect(await rig.state()).toBe('working')
  })
})

describe('SC-3: a Claude question', () => {
  test('waits with the question as its detail', async () => {
    rig = await Rig.start()
    await play([['UserPromptSubmit', { prompt: 'go' }], ['PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ask, tool_use_id: 'q1' }]])
    const row = (await rig.row())!
    expect(row).toMatchObject({ state: 'waiting', detail: 'Which branch?' })
    expect(JSON.parse(row.question!)).toEqual(ask)
    expect((await rig.session()).status).toBe('waiting')
  })
})

describe('SC-4: failures and interrupts', () => {
  test('StopFailure is failed and an interrupted Stop is interrupted', async () => {
    rig = await Rig.start({ sessions: [{}, { id: 's2' }] })
    for (const session of ['s1', 's2']) await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'go' }), { session })
    await rig.hook('claude', claude('StopFailure'), { session: 's1' })
    await rig.hook('claude', claude('Stop', { is_interrupt: true }), { session: 's2' })
    expect(await rig.row('s1')).toMatchObject({ state: 'done', outcome: 'failure', display: 'failed', label: 'Failed' })
    expect(await rig.row('s2')).toMatchObject({ state: 'done', interrupted: true, display: 'interrupted', label: 'Interrupted' })
  })
})

describe('SC-5: the fold', () => {
  test('a finished lead stays working while a subagent lives, and a child question waits', async () => {
    rig = await Rig.start()
    await play([['UserPromptSubmit', { prompt: 'go' }], ['SubagentStart', { agent_id: 'a1' }]])
    await rig.hook('claude', claude('Stop', { last_assistant_message: 'started it' }))
    expect(await rig.row()).toMatchObject({ state: 'working', outcome: 'success', children: [{ id: 'a1', kind: 'agent', state: 'working' }] })

    await rig.hook('claude', claude('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ask, agent_id: 'a1' }))
    expect(await rig.row()).toMatchObject({ state: 'waiting', outcome: 'success', detail: 'Which branch?' })

    await rig.hook('claude', claude('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.ts' }, agent_id: 'a1' }))
    expect(await rig.row()).toMatchObject({ state: 'working', outcome: 'success' })

    await rig.hook('claude', claude('SubagentStop', { agent_id: 'a1' }))
    expect(await rig.row()).toMatchObject({ state: 'done', outcome: 'success', children: [] })
    await rig.waitForNotifies(2)
    expect(rig.notifies().map((n) => (n as { body: string }).body)).toEqual(['Claude needs input', 'Claude finished'])
  })
})

describe('SC-6: monitoring', () => {
  test('a stop listing only a shell reads as monitoring; a later empty stop is done', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'grok' }] })
    const grok = (name: string, payload: Record<string, unknown> = {}) => rig.hook('grok', { hook_event_name: name, promptId: 'p1', ...payload })
    await grok('user_prompt_submit', { prompt: 'build' })
    await grok('stop', { backgroundTasks: [{ id: 'sh1', type: 'shell' }] })
    expect(await rig.row()).toMatchObject({ state: 'working', workingMode: 'monitoring', display: 'monitoring', label: 'Monitoring background tasks' })
    await grok('stop', { backgroundTasks: [] })
    expect(await rig.row()).toMatchObject({ state: 'done', display: 'done' })

    await grok('user_prompt_submit', { prompt: 'again' })
    await grok('stop', { backgroundTasks: [{ id: 'a1', type: 'subagent' }] })
    expect(await rig.row()).toMatchObject({ state: 'working', display: 'working' })
  })
})

describe('SC-7: Codex', () => {
  test('SessionStart works, auto-reviewed approvals stay working, others wait, Interrupt cancels, notify finishes', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'codex', title: 'Codex' }, { id: 's2', agent: 'codex', title: 'Codex' }] })
    const codex = (payload: Record<string, unknown>, session = 's1') => rig.hook('codex', payload, { session })
    await codex(claude('SessionStart', { source: 'startup', session_id: 'th1' }))
    expect(await rig.row()).toMatchObject({ state: 'working', agent: 'codex' })

    await codex(claude('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, approvals_reviewer: 'auto_review' }))
    expect(await rig.state()).toBe('working')
    await codex(claude('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }))
    expect(await rig.state()).toBe('waiting')
    await codex(claude('Interrupt'))
    expect(await rig.row()).toMatchObject({ state: 'done', outcome: 'cancellation', display: 'interrupted' })

    await codex({ type: 'agent-turn-complete', 'thread-id': 'th2', 'last-assistant-message': 'all set' }, 's2')
    expect(await rig.row('s2')).toMatchObject({ state: 'done', detail: 'all set' })
    expect((await rig.session('s2')).status).toBe('done')
  })
})

describe('SC-9: repeated working events', () => {
  test('keep the state clock while the evidence clock moves', async () => {
    rig = await Rig.start()
    await play([['UserPromptSubmit', { prompt: 'go' }]])
    const first = (await rig.row())!
    await Bun.sleep(15)
    await play([['PreToolUse', bash('ls')]])
    await Bun.sleep(15)
    await play([['PreToolUse', bash('pwd')]])
    const last = (await rig.row())!
    expect(last.stateStartedAt).toBe(first.stateStartedAt)
    expect(last.evidenceAt).toBeGreaterThan(first.evidenceAt)
    expect(last.turnStartedAt).toBe(first.turnStartedAt)
  })
})

describe('SC-11: malformed hooks', () => {
  test('change nothing and are answered at once', async () => {
    rig = await Rig.start()
    const url = `http://127.0.0.1:${rig.h.runtime.port}/hook`
    const headers = { [HOOK_TOKEN_HEADER]: rig.h.runtime.hookToken }
    const notJson = await fetch(`${url}/claude?session=s1`, { method: 'POST', headers, body: 'not json' })
    expect(notJson.status).toBe(400)
    expect((await rig.post('no-such-agent', claude('Stop'))).status).toBe(200)
    expect((await rig.post('claude', claude('Stop'), { session: 's_missing' })).status).toBe(200)
    expect((await rig.post('claude', {})).status).toBe(200)
    expect((await rig.post('claude', null)).status).toBe(200)
    await rig.settle()
    expect(await rig.list()).toEqual([])
    expect(await rig.statusCalls()).toEqual([])
    expect(rig.notifies()).toHaveLength(0)
  })

  test('a wrong hook token is refused and changes nothing', async () => {
    rig = await Rig.start()
    const response = await fetch(`http://127.0.0.1:${rig.h.runtime.port}/hook/claude?session=s1`, {
      method: 'POST',
      headers: { [HOOK_TOKEN_HEADER]: 'wrong' },
      body: JSON.stringify(claude('Stop'))
    })
    expect(response.status).toBe(401)
    await rig.settle()
    expect(await rig.statusCalls()).toEqual([])
  })

  test('exited and structured sessions ignore hooks', async () => {
    rig = await Rig.start({ sessions: [{ status: 'exited' }, { id: 's2', kind: 'structured' }] })
    await rig.post('claude', claude('Stop'))
    await rig.post('claude', claude('Stop'), { session: 's2' })
    await rig.settle()
    expect(await rig.statusCalls()).toEqual([])
    expect(rig.notifies()).toHaveLength(0)
  })

  test('an event that says nothing about status leaves the row and the session alone', async () => {
    rig = await Rig.start()
    await rig.hook('claude', claude('Notification', { notification_type: 'idle_prompt' }))
    await rig.hook('claude', claude('SomethingElse'))
    expect(await rig.row()).toBeNull()
    expect(await rig.statusCalls()).toEqual([])
  })
})

describe('SC-12: provider capture', () => {
  test('SessionStart stores the id and transcript once; a Stop carrying the same changes nothing', async () => {
    rig = await Rig.start()
    await play([
      ['SessionStart', { source: 'startup', session_id: 'abc', transcript_path: '/tmp/t/abc.jsonl' }],
      ['UserPromptSubmit', { prompt: 'go', session_id: 'abc', transcript_path: '/tmp/t/abc.jsonl' }],
      ['Stop', { session_id: 'abc', transcript_path: '/tmp/t/abc.jsonl' }]
    ])
    expect(await rig.providerCalls()).toEqual([{ session: 's1', id: 'abc', transcriptPath: '/tmp/t/abc.jsonl' }])
    expect((await rig.session()).providerSession).toEqual({ id: 'abc', transcriptPath: '/tmp/t/abc.jsonl' })
  })

  test.each([
    ['cursor', { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conv-1', prompt: 'go' }, 'conv-1', undefined],
    ['opencode', { hook_event_name: 'SessionBusy', sessionID: 'oc-1' }, 'oc-1', undefined],
    ['antigravity', { hook_event_name: 'PreInvocation', conversationId: 'ag-1' }, 'ag-1', undefined],
    ['pi', { hook_event_name: 'agent_start', session_id: 'pi-1', session_file: '/tmp/pi/1.jsonl' }, 'pi-1', '/tmp/pi/1.jsonl']
  ] as const)('%s captures its id', async (agent, payload, id, transcriptPath) => {
    rig = await Rig.start({ sessions: [{ agent }] })
    await rig.hook(agent, payload)
    expect(await rig.providerCalls()).toEqual([{ session: 's1', id, ...(transcriptPath ? { transcriptPath } : {}) }])
  })

  test.each([
    ['amp', { hook_event_name: 'agent.start', threadId: 'T1', message: 'go' }],
    ['command-code', { hook_event_name: 'PreToolUse', tool_name: 'shell', session_id: 'x' }],
    ['hermes', { hook_event_name: 'pre_llm_call', prompt: 'go', session_id: 'x' }]
  ] as const)('%s captures nothing', async (agent, payload) => {
    rig = await Rig.start({ sessions: [{ agent }] })
    await rig.hook(agent, payload)
    expect(await rig.state()).toBe('working')
    expect(await rig.providerCalls()).toEqual([])
  })

  test('an accepted hook that makes no row still stores the id', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'jcode' }] })
    await rig.hook('jcode', { session_id: 'j1' }, { event: 'session_start' })
    expect(await rig.row()).toBeNull()
    expect(await rig.providerCalls()).toEqual([{ session: 's1', id: 'j1' }])
  })

  test('an accepted hook that cannot replace a dead lead still stores the successor id', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'jcode' }] })
    const sleeper = Bun.spawn(['sleep', '30'])
    const identity = { pid: sleeper.pid, pstart: startOf(sleeper.pid) }
    await rig.hook('jcode', { session_id: 'old' }, { event: 'turn_start', ...identity })
    expect(await rig.row()).toMatchObject({ lead: { providerSession: 'old' } })
    sleeper.kill()
    await sleeper.exited
    await rig.hook('jcode', { session_id: 'new' }, { event: 'session_start' })
    expect((await rig.providerCalls()).map((c) => c.id)).toEqual(['old', 'new'])
    expect(await rig.row()).toMatchObject({ lead: { providerSession: 'old' } })
  })

  test('an id that fails the stored-id rules is not stored', async () => {
    rig = await Rig.start()
    await play([['SessionStart', { source: 'startup', session_id: '--evil' }]])
    expect(await rig.providerCalls()).toEqual([])
    expect(await rig.state()).toBe('done')
  })
})

describe('SC-13: a helper agent in the session', () => {
  const lead = () => ({ pid: process.pid, pstart: startOf(process.pid) })

  async function leadFinished(): Promise<number> {
    const identity = lead()
    await rig.hook('claude', claude('SessionStart', { source: 'startup', session_id: 'abc' }), identity)
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'fix the tests', session_id: 'abc' }), identity)
    await rig.hook('claude', claude('Stop', { session_id: 'abc', last_assistant_message: 'ok' }), identity)
    await rig.waitForNotifies(1)
    return (await rig.statusCalls()).length
  }

  const helper = async (options: { pid?: number; pstart?: string } = {}) => {
    await rig.hook('claude', claude('SessionStart', { source: 'startup', session_id: 'zzz' }), options)
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: '=== Transcript of a conversation...', session_id: 'zzz' }), options)
    await rig.hook('claude', claude('Stop', { session_id: 'zzz' }), options)
  }

  test('cannot take over the row while the lead process lives', async () => {
    rig = await Rig.start()
    const callsBefore = await leadFinished()
    await helper()
    expect(await rig.row()).toMatchObject({ state: 'done', prompt: 'fix the tests', lead: { providerSession: 'abc' } })
    expect((await rig.providerCalls()).map((c) => c.id)).toEqual(['abc'])
    expect((await rig.session()).providerSession?.id).toBe('abc')
    expect(rig.notifies()).toHaveLength(1)
    expect(await rig.statusCalls()).toHaveLength(callsBefore)
  })

  test('the helper learns nothing the lead keeps: its prompt never reaches a later lead event', async () => {
    rig = await Rig.start()
    await leadFinished()
    await helper()
    await rig.hook('claude', claude('Stop', { session_id: 'abc' }), lead())
    expect((await rig.row())!.prompt).toBe('fix the tests')
  })

  test('takes the row once the lead process is gone', async () => {
    rig = await Rig.start()
    const sleeper = Bun.spawn(['sleep', '30'])
    const identity = { pid: sleeper.pid, pstart: startOf(sleeper.pid) }
    await rig.hook('claude', claude('SessionStart', { source: 'startup', session_id: 'abc' }), identity)
    await rig.hook('claude', claude('Stop', { session_id: 'abc' }), identity)
    sleeper.kill()
    await sleeper.exited
    await helper()
    expect(await rig.row()).toMatchObject({ lead: { providerSession: 'zzz' } })
  })

  test('a lead pid reused by another process (different start time) does not hold the row', async () => {
    rig = await Rig.start()
    const identity = { pid: process.pid, pstart: 'Thu Jan  1 00:00:00 1970' }
    await rig.hook('claude', claude('SessionStart', { source: 'startup', session_id: 'abc' }), identity)
    await helper()
    expect(await rig.row()).toMatchObject({ lead: { providerSession: 'zzz' } })
  })
})

describe('SC-14: moving the lead', () => {
  test('a clear SessionStart makes the new session the lead and the row a done boundary', async () => {
    rig = await Rig.start()
    await play([
      ['SessionStart', { source: 'startup', session_id: 'abc' }],
      ['UserPromptSubmit', { prompt: 'go', session_id: 'abc' }],
      ['SessionStart', { source: 'clear', session_id: 'def' }]
    ])
    expect(await rig.row()).toMatchObject({ state: 'done', sessionBoundary: true, prompt: '', lead: { providerSession: 'def' } })
    expect((await rig.providerCalls()).map((c) => c.id)).toEqual(['abc', 'def'])
  })

  test('SessionEnd ends the row, and the next startup becomes the lead', async () => {
    rig = await Rig.start()
    await play([
      ['SessionStart', { source: 'startup', session_id: 'abc' }],
      ['UserPromptSubmit', { prompt: 'go', session_id: 'abc' }],
      ['SessionEnd', { reason: 'prompt_input_exit', session_id: 'abc' }]
    ])
    expect(await rig.row()).toBeNull()
    expect(await rig.session()).toMatchObject({ status: 'running', agentStatus: null })
    await play([['SessionStart', { source: 'startup', session_id: 'ghi' }]])
    expect(await rig.row()).toMatchObject({ state: 'done', lead: { providerSession: 'ghi' } })
  })

  test('a SessionEnd from a helper does not end the lead row', async () => {
    rig = await Rig.start()
    await play([['UserPromptSubmit', { prompt: 'go', session_id: 'abc' }], ['SessionEnd', { reason: 'other', session_id: 'zzz' }]])
    expect(await rig.state()).toBe('working')
  })
})

describe('SC-15: a different agent in the session', () => {
  test('is ignored while the claude row is unfinished and takes the row once it is done', async () => {
    rig = await Rig.start()
    await play([['UserPromptSubmit', { prompt: 'go' }]])
    await rig.hook('gemini', { hook_event_name: 'BeforeAgent', prompt: 'other' })
    expect(await rig.row()).toMatchObject({ agent: 'claude', state: 'working', prompt: 'go' })

    await play([['Stop']])
    await rig.hook('gemini', { hook_event_name: 'BeforeAgent', prompt: 'other' })
    expect(await rig.row()).toMatchObject({ agent: 'gemini', state: 'working', prompt: 'other' })
  })

  test('a done row yields even when its process still runs', async () => {
    rig = await Rig.start()
    const identity = { pid: process.pid, pstart: startOf(process.pid) }
    await rig.hook('claude', claude('Stop'), identity)
    await rig.hook('gemini', { hook_event_name: 'BeforeAgent', prompt: 'other' })
    expect(await rig.row()).toMatchObject({ agent: 'gemini', state: 'working' })
  })
})

describe('SC-32: readable details', () => {
  test('a permission request reads as the tool and its command, never JSON', async () => {
    rig = await Rig.start()
    await play([['UserPromptSubmit', { prompt: 'go' }], ['PermissionRequest', bash("printf 'x' >> README.md")]])
    expect((await rig.row())!.detail).toBe("Bash: printf 'x' >> README.md")
    for (const entry of await rig.list()) expect(String(entry.detail).trim().startsWith('{')).toBe(false)
  })

  test('a tool input that is only an object never becomes the detail', async () => {
    rig = await Rig.start()
    await play([['UserPromptSubmit', { prompt: 'go' }], ['PermissionRequest', { tool_name: 'Weird', tool_input: { nested: { a: 1 } } }]])
    expect((await rig.row())!.detail).toBe('Weird')
  })
})

describe('notifications', () => {
  test('waiting and done open the session, name the worktree and run the OS notifier without a desktop client', async () => {
    rig = await Rig.start()
    await play([['UserPromptSubmit', { prompt: 'go' }], ['PermissionRequest', bash('ls')]])
    await rig.waitForNotifies(1)
    await play([['Stop']])
    await rig.waitForNotifies(2)
    const open = { view: 'view:quirky.session/worktree', input: { worktree: 'wt1', session: 's1' } }
    expect(rig.notifies()).toEqual([
      { type: 'notify', title: 'main', body: 'Claude needs input', sessionId: 's1', worktreeId: 'wt1', open, desktop: true },
      { type: 'notify', title: 'main', body: 'Claude finished', sessionId: 's1', worktreeId: 'wt1', open, desktop: true }
    ])
    expect(rig.h.notifications).toEqual([
      { title: 'main', body: 'Claude needs input' },
      { title: 'main', body: 'Claude finished' }
    ])
  })

  test('the title is the session worktree name and the body uses the session title', async () => {
    rig = await Rig.start({ sessions: [{ worktreeId: 'wt2', title: 'Claude 2' }] })
    await play([['Stop']])
    await rig.waitForNotifies(1)
    expect(rig.notifies()[0]).toMatchObject({ title: 'feature', body: 'Claude 2 finished', worktreeId: 'wt2' })
  })

  test('working does not notify, and a repeated Stop notifies once', async () => {
    rig = await Rig.start()
    await play([['UserPromptSubmit', { prompt: 'go' }], ['Stop'], ['Stop']])
    await rig.settle()
    expect(rig.notifies()).toHaveLength(1)
  })

  test('a session boundary does not notify', async () => {
    rig = await Rig.start()
    await play([['SessionStart', { source: 'startup' }]])
    await rig.settle()
    expect(rig.notifies()).toHaveLength(0)
  })

  test('blocked reads as needing input', async () => {
    rig = await Rig.start({ sessions: [{ agent: 'copilot', title: 'Copilot' }] })
    await rig.hook('copilot', { prompt: 'go' }, { event: 'userPromptSubmitted' })
    await rig.hook('copilot', { notification_type: 'permission_prompt' }, { event: 'notification' })
    expect(await rig.state()).toBe('blocked')
    await rig.waitForNotifies(1)
    expect(rig.notifies()[0]).toMatchObject({ body: 'Copilot needs input' })
  })

  test('SC-25: it is a boolean setting that defaults to true', async () => {
    rig = await Rig.start()
    const info = (await rig.client.callAny('setting.get', { id: NOTIFICATIONS })) as Record<string, unknown>
    expect(info).toMatchObject({ type: 'boolean', title: 'Notify when agents finish', default: true, value: true })
  })

  test('off keeps the toast but suppresses the OS notification', async () => {
    rig = await Rig.start()
    await rig.client.callAny('setting.set', { id: NOTIFICATIONS, value: false })
    await play([['Stop']])
    await rig.waitForNotifies(1)
    expect(rig.notifies()[0]).toMatchObject({ desktop: false })
    await rig.settle()
    expect(rig.h.notifications).toEqual([])
  })

  test('a connected desktop client suppresses the daemon notifier', async () => {
    rig = await Rig.start()
    await rig.h.connect('desktop')
    await play([['Stop']])
    await rig.waitForNotifies(1)
    expect(rig.notifies()[0]).toMatchObject({ desktop: true })
    await rig.settle()
    expect(rig.h.notifications).toEqual([])
  })

  test("a v1 home's notifications value carries over once", async () => {
    const home = makeTempHome('qas-h-')
    const v1 = new Database(join(home, 'quirky.db'))
    v1.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    v1.query('INSERT INTO settings (key, value) VALUES (?, ?)').run('notifications', 'false')
    v1.close()
    rig = await Rig.start({ home })
    expect(((await rig.client.callAny('setting.get', { id: NOTIFICATIONS })) as { value: unknown }).value).toBe(false)

    await rig.client.callAny('setting.set', { id: NOTIFICATIONS, value: true })
    rig = await rig.restart()
    expect(((await rig.client.callAny('setting.get', { id: NOTIFICATIONS })) as { value: unknown }).value).toBe(true)
  })
})

describe('rows and sessions', () => {
  test('an exited session loses its row and a removed session does too', async () => {
    rig = await Rig.start({ sessions: [{}, { id: 's2' }] })
    for (const session of ['s1', 's2']) await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'go' }), { session })
    await rig.client.callAny('quirky.session/setStatus', { session: 's1', status: 'exited' })
    await rig.client.callAny('quirky.session/remove', { session: 's2' })
    await rig.settle()
    expect(await rig.row('s1')).toBeNull()
    expect(await rig.row('s2')).toBeNull()
    expect(await rig.list()).toEqual([])
  })

  test('list returns the summary of each session that has a row, narrowed by worktree', async () => {
    rig = await Rig.start({ sessions: [{}, { id: 's2', agent: 'shell' }, { id: 's3', worktreeId: 'wt2' }] })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'go' }), { session: 's1' })
    await rig.hook('claude', claude('Stop', { last_assistant_message: 'bye' }), { session: 's3' })
    const all = await rig.list()
    expect(all.map((e) => e.sessionId).sort()).toEqual(['s1', 's3'])
    expect(all.find((e) => e.sessionId === 's1')).toMatchObject({
      agent: 'claude',
      state: 'working',
      display: 'working',
      label: 'Working',
      detail: 'go'
    })
    expect(all.find((e) => e.sessionId === 's3')).toMatchObject({ state: 'done', detail: 'bye' })
    expect((await rig.list({ worktree: 'wt2' })).map((e) => e.sessionId)).toEqual(['s3'])
    expect(await rig.row('s2')).toBeNull()
  })

  test('get returns the whole row with its display, and null for a session without one', async () => {
    rig = await Rig.start({ sessions: [{}, { id: 's2', agent: 'shell' }] })
    await play([['UserPromptSubmit', { prompt: 'go' }]])
    expect(await rig.row()).toMatchObject({ sessionId: 's1', agent: 'claude', state: 'working', display: 'working', label: 'Working', children: [], source: 'hook' })
    expect(await rig.row('s2')).toBeNull()
  })
})

describe('launch hook', () => {
  function settingsFrom(args: string[]): { hooks: Record<string, unknown[]> } {
    const at = args.indexOf('--settings')
    expect(at).toBeGreaterThanOrEqual(0)
    const value = args[at + 1]
    if (value === undefined) throw new Error('launch omitted the --settings value')
    return JSON.parse(value) as { hooks: Record<string, unknown[]> }
  }

  const eventsIn = (args: string[]) => Object.keys(settingsFrom(args).hooks).sort()

  test('SC-28: Claude gets one inline settings object with the events its version knows', async () => {
    rig = await Rig.start()
    const full = [
      'PermissionRequest',
      'PostCompact',
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'StopFailure',
      'SubagentStart',
      'SubagentStop',
      'TeammateIdle',
      'UserPromptSubmit'
    ]
    const core = ['PostToolUse', 'PreToolUse', 'Stop', 'SubagentStop', 'UserPromptSubmit']
    const cases: [string | null, string[]][] = [
      ['1.0.60', core],
      ['2.1.300 (Claude Code)', full],
      [null, [...core, 'SessionStart'].sort()]
    ]
    for (const [version, events] of cases) {
      await rig.fakeClaude(version ?? 'no version here', version === null ? 1 : 0)
      const args = await rig.launchArgs('claude')
      expect(args.filter((argument) => argument === '--settings')).toHaveLength(1)
      expect(args[0]).toBe('--settings')
      expect(eventsIn(args)).toEqual(events)
    }
  })

  test('the inline settings hooks run the quirky-hook shim for claude', async () => {
    rig = await Rig.start()
    await rig.fakeClaude('2.1.300')
    const settings = settingsFrom(await rig.launchArgs('claude'))
    expect((settings.hooks.PreToolUse![0] as { matcher: string }).matcher).toBe('*')
    expect(((settings.hooks.Stop![0] as { hooks: { command: string }[] }).hooks[0]!).command).toContain('/bin/quirky-hook" claude')
  })

  test('claude-agent-teams gets the same settings as claude', async () => {
    rig = await Rig.start()
    await rig.fakeClaude('2.1.300')
    expect(await rig.launchArgs('claude-agent-teams')).toEqual(await rig.launchArgs('claude'))
  })

  test('Codex gets a notify config naming the hook script', async () => {
    rig = await Rig.start()
    expect(await rig.launchArgs('codex')).toEqual(['-c', `notify=["${join(rig.h.home, 'bin', 'quirky-hook')}","codex"]`])
  })

  test('other agents get no arguments from this hook', async () => {
    rig = await Rig.start()
    expect(await rig.launchArgs('gemini')).toEqual([])
  })

  test('a missing quirky.agents leaves Claude on the default event set', async () => {
    rig = await Rig.start()
    const args = await rig.launchArgs('claude')
    expect(eventsIn(args)).toContain('SessionStart')
    expect(eventsIn(args)).not.toContain('SessionEnd')
  })
})
