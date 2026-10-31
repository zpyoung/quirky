import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { ActivityQuery, ActivityThread } from '../src/activity-types'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { newSession, startOf, startStatusE2E, waitFor, type StatusE2E } from './e2e/support'
import { Rig } from './support'

type ActivityResult = { threads: ActivityThread[] }
type AcknowledgeResult = { acknowledged: number }

let rig: Rig | undefined
let e2e: StatusE2E | undefined

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
  await e2e?.cleanup()
  e2e = undefined
  removeTempDirs()
})

const claude = (event: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event, ...extra })
const activity = (query: ActivityQuery = {}) =>
  rig!.client.callAny('quirky.agent-status/activity', query) as Promise<ActivityResult>
const acknowledge = (params: { session?: string; turn?: string; all?: boolean }) =>
  rig!.client.callAny('quirky.agent-status/acknowledge', params) as Promise<AcknowledgeResult>
const threadFor = (threads: ActivityThread[], sessionId: string) => threads.find((thread) => thread.sessionId === sessionId)

describe('Activity public API', () => {
  test.each(['opencode', 'opencode2'])('%s without a prompt publishes an idle session summary', async (agent) => {
    rig = await Rig.start({ sessions: [{ agent }] })
    await rig.hook(agent, { hook_event_name: 'SessionStart' })

    expect((await rig.session()).agentStatus).toMatchObject({ display: 'idle', label: 'Idle' })
    expect(await rig.row()).toMatchObject({ state: 'done', sessionBoundary: true, display: 'idle' })
  })

  test.each(['opencode', 'opencode2'])('%s boundaries are read, but actual work and completion are unread', async (agent) => {
    rig = await Rig.start({ sessions: [{ agent }] })
    await rig.hook(agent, { hook_event_name: 'SessionStart' })

    expect(threadFor((await activity()).threads, 's1')).toMatchObject({ display: 'idle', unread: false })
    expect((await activity({ unreadOnly: true })).threads).toEqual([])

    rig = await rig.restart()
    expect(threadFor((await activity()).threads, 's1')).toMatchObject({ display: 'idle', unread: false })

    await rig.hook(agent, { hook_event_name: 'MessagePart', role: 'user', text: 'Review this change' })
    expect(threadFor((await activity()).threads, 's1')).toMatchObject({ display: 'working', unread: true, prompt: 'Review this change' })
    await rig.hook(agent, { hook_event_name: 'SessionIdle' })
    expect((await rig.session()).agentStatus).toMatchObject({ display: 'done' })
    expect(threadFor((await activity({ unreadOnly: true })).threads, 's1')).toMatchObject({ display: 'done', unread: true })

    await rig.hook(agent, { hook_event_name: 'SessionStart' })
    expect(threadFor((await activity()).threads, 's1')).toMatchObject({ display: 'idle', unread: false, prompt: '' })
    expect((await activity({ unreadOnly: true })).threads).toEqual([])
    await rig.hook(agent, { hook_event_name: 'SessionBusy' })
    expect(threadFor((await activity({ unreadOnly: true })).threads, 's1')).toMatchObject({ display: 'working', unread: true })
  })

  test('manual compaction keeps live child work and permission requests unread', async () => {
    rig = await Rig.start()
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'Review this change' }))
    await rig.hook('claude', claude('SubagentStart', { agent_id: 'reviewer' }))
    await rig.hook('claude', claude('PostCompact', { trigger: 'manual' }))

    expect(await rig.row()).toMatchObject({ state: 'working', sessionBoundary: true })
    expect(threadFor((await activity({ unreadOnly: true })).threads, 's1')).toMatchObject({ display: 'working', unread: true })

    await rig.hook('claude', claude('PermissionRequest', {
      agent_id: 'reviewer',
      tool_name: 'Bash',
      tool_input: { command: 'git push' },
      tool_use_id: 'push'
    }))
    expect(threadFor((await activity({ unreadOnly: true })).threads, 's1')).toMatchObject({ display: 'waiting', unread: true })
  })

  test('filters injected task notifications without losing replies or later message prompts', async () => {
    rig = await Rig.start()
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'first human request' }))
    await rig.hook('claude', claude('Stop', { last_assistant_message: 'first response' }))
    await rig.hook(
      'claude',
      claude('UserPromptSubmit', {
        prompt: '<task-notification><task-id>task-qa</task-id><status>completed</status></task-notification>'
      })
    )
    await rig.hook('claude', claude('Stop', { last_assistant_message: 'OK' }))

    const completed = threadFor((await activity()).threads, 's1')!
    expect(completed.prompt).toBe('')
    expect(completed.prompt).not.toContain('<task-notification')
    expect(completed.detail).toBe('OK')
    expect(completed.display).toBe('done')

    await rig.hook('claude', claude('UserPromptSubmit', { message: 'second human request' }))
    const next = threadFor((await activity()).threads, 's1')!
    expect(next).toMatchObject({ prompt: 'second human request', display: 'working' })
  })

  test('queries attention-first threads, filters prompt/provider/workspace text, and preserves exact navigation identity', async () => {
    rig = await Rig.start({
      sessions: [
        { id: 's-wait', worktreeId: 'wt1', name: 'review', title: 'Review' },
        { id: 's-work', worktreeId: 'wt2', agent: 'codex', name: 'review', title: 'Review' },
        { id: 's-done', worktreeId: 'wt1', name: 'finished', title: 'Finished' }
      ]
    })

    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'release alpha checklist' }), { session: 's-wait' })
    await rig.hook('claude', claude('SubagentStart', { agent_id: 'reviewer-9', agent_type: 'reviewer' }), { session: 's-wait' })
    await rig.hook(
      'claude',
      claude('PreToolUse', {
        agent_id: 'reviewer-9',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which branch?' }] }
      }),
      { session: 's-wait' }
    )
    await rig.hook('codex', claude('UserPromptSubmit', { prompt: 'audit customer portal' }), { session: 's-work' })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'close old ticket' }), { session: 's-done' })
    await rig.hook('claude', claude('Stop', { last_assistant_message: 'closed' }), { session: 's-done' })

    const all = await activity()
    expect(all.threads.map((thread) => thread.sessionId)).toEqual(['s-wait', 's-work', 's-done'])
    expect(all.threads[0]).toMatchObject({
      sessionId: 's-wait',
      worktreeId: 'wt1',
      worktreeName: 'main',
      sessionName: 'review',
      display: 'waiting',
      prompt: 'release alpha checklist',
      unread: true,
      children: [{ id: 'reviewer-9', kind: 'agent', state: 'waiting' }]
    })
    expect(all.threads[1]).toMatchObject({
      sessionId: 's-work',
      worktreeId: 'wt2',
      worktreeName: 'feature',
      sessionName: 'review',
      agent: 'codex',
      prompt: 'audit customer portal'
    })

    expect((await activity({ worktree: 'wt2' })).threads.map((thread) => [thread.sessionId, thread.worktreeId])).toEqual([['s-work', 'wt2']])
    expect((await activity({ text: 'release alpha' })).threads.map((thread) => thread.sessionId)).toEqual(['s-wait'])
    expect((await activity({ text: 'codex' })).threads.map((thread) => thread.sessionId)).toEqual(['s-work'])
    expect((await activity({ text: 'feature' })).threads.map((thread) => thread.sessionId)).toEqual(['s-work'])
    expect((await activity({ text: 'no matching text' })).threads).toEqual([])
    expect(all.threads.filter((thread) => thread.sessionName === 'review').map((thread) => [thread.sessionId, thread.worktreeId])).toEqual([
      ['s-wait', 'wt1'],
      ['s-work', 'wt2']
    ])
  })

  test('hydrates a pre-existing status row when the Activity snapshot table is empty', async () => {
    rig = await Rig.start()
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'legacy status row' }))
    const legacyRow = (await rig.row())!
    const home = rig.h.home

    await rig.stop()
    const db = new Database(rig.storeFile())
    db.query('CREATE TABLE IF NOT EXISTS activity_threads (session_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)').run()
    db.query('DELETE FROM activity_threads').run()
    db.close()

    rig = await Rig.start({ home, sessions: [] })
    const imported = threadFor((await activity()).threads, 's1')!
    expect(imported).toMatchObject({
      sessionId: 's1',
      worktreeId: 'wt1',
      agent: 'claude',
      prompt: 'legacy status row',
      turnStartedAt: legacyRow.turnStartedAt,
      unread: true,
      live: true
    })
  })

  test('read receipts stay on their turn, reject a delayed old-turn ack, and survive restart', async () => {
    rig = await Rig.start()
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'first turn' }))

    const first = threadFor((await activity()).threads, 's1')!
    expect(first.unread).toBe(true)
    const firstTurn = first.turn
    expect(await acknowledge({ session: 's1', turn: firstTurn })).toEqual({ acknowledged: 1 })

    await rig.hook('claude', claude('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' } }))
    const afterTool = threadFor((await activity()).threads, 's1')!
    expect(afterTool.turn).toBe(firstTurn)
    expect(afterTool.unread).toBe(false)

    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'second turn' }))
    const second = threadFor((await activity()).threads, 's1')!
    expect(second.turn).not.toBe(firstTurn)
    expect(second.unread).toBe(true)
    expect(await acknowledge({ session: 's1', turn: firstTurn })).toEqual({ acknowledged: 0 })
    expect(threadFor((await activity({ unreadOnly: true })).threads, 's1')).toMatchObject({ turn: second.turn, unread: true })

    expect(await acknowledge({ session: 's1', turn: second.turn })).toEqual({ acknowledged: 1 })
    rig = await rig.restart()
    const afterRestart = threadFor((await activity()).threads, 's1')!
    expect(afterRestart).toMatchObject({ turn: second.turn, unread: false, prompt: 'second turn' })

    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'third turn after restart' }))
    const third = threadFor((await activity()).threads, 's1')!
    expect(third.turn).not.toBe(second.turn)
    expect(third.unread).toBe(true)
  })

  test('a pending query cannot overwrite the newer turn, receipt, or clear state', async () => {
    rig = await Rig.start()
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'first turn' }))

    expect(await rig.client.callAny('quirky.worktree/testHoldResolve', {})).toBe(true)
    const pendingQuery = activity()
    expect(await rig.client.callAny('quirky.worktree/testWaitResolve', {})).toBe(true)

    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'second turn' }))
    expect(await acknowledge({ all: true })).toEqual({ acknowledged: 1 })
    await rig.hook('claude', claude('Stop', { last_assistant_message: 'finished second turn' }))
    expect(await rig.client.callAny('quirky.agent-status/clearCompleted', {})).toEqual({ cleared: 1 })

    expect(await rig.client.callAny('quirky.worktree/testReleaseResolve', {})).toBe(true)
    const staleResult = await pendingQuery
    expect(threadFor(staleResult.threads, 's1')).toBeUndefined()
    expect((await activity()).threads).toEqual([])
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'third turn survives query' }))
    const current = threadFor((await activity()).threads, 's1')!
    expect(current).toMatchObject({ prompt: 'third turn survives query', display: 'working', unread: true, live: true })
  })

  test('acknowledge all reads only the current turns and unread-only hides them', async () => {
    rig = await Rig.start({ sessions: [{}, { id: 's2' }] })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'first' }), { session: 's1' })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'second' }), { session: 's2' })

    expect((await activity({ unreadOnly: true })).threads.map((thread) => thread.sessionId).sort()).toEqual(['s1', 's2'])
    expect(await acknowledge({ all: true })).toEqual({ acknowledged: 2 })
    expect((await activity({ unreadOnly: true })).threads).toEqual([])

    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'another turn' }), { session: 's1' })
    expect((await activity({ unreadOnly: true })).threads.map((thread) => thread.sessionId)).toEqual(['s1'])
  })

  test('clear-completed removes only terminal feed entries and preserves sessions, status, transcripts, and later turns', async () => {
    const transcriptPath = '/transcripts/keep-this.jsonl'
    rig = await Rig.start({
      sessions: [
        { id: 's-done', worktreeId: 'wt1', providerSession: { id: 'provider-done', transcriptPath } },
        { id: 's-work', worktreeId: 'wt2' },
        { id: 's-wait', worktreeId: 'wt1' },
        { id: 's-monitor', worktreeId: 'wt1' }
      ]
    })

    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'completed session first turn' }), { session: 's-done' })
    await rig.hook('claude', claude('Stop', { last_assistant_message: 'complete' }), { session: 's-done' })
    const clearedTurn = threadFor((await activity()).threads, 's-done')!.turn
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'keep running' }), { session: 's-work' })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'waiting for approval' }), { session: 's-wait' })
    await rig.hook('claude', claude('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }), { session: 's-wait' })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'monitor background work' }), { session: 's-monitor' })
    await rig.hook('claude', claude('Stop', { session_crons: [{ id: 'cron-1' }] }), { session: 's-monitor' })

    const beforeClear = await rig.statusCalls()
    expect(await rig.client.callAny('quirky.agent-status/clearCompleted', { worktree: 'wt1' })).toEqual({ cleared: 1 })
    const remaining = (await activity()).threads
    expect(remaining.map((thread) => thread.sessionId).sort()).toEqual(['s-monitor', 's-wait', 's-work'])
    expect(threadFor(remaining, 's-work')).toMatchObject({ display: 'working', live: true })
    expect(threadFor(remaining, 's-wait')).toMatchObject({ display: 'waiting', live: true })
    expect(threadFor(remaining, 's-monitor')).toMatchObject({ display: 'monitoring', live: true })
    expect(await rig.statusCalls()).toEqual(beforeClear)
    expect(await rig.row('s-done')).toMatchObject({ state: 'done' })
    expect(await rig.session('s-done')).toMatchObject({
      id: 's-done',
      status: 'done',
      providerSession: { id: 'provider-done', transcriptPath }
    })
    expect(await rig.session('s-work')).toMatchObject({ status: 'working' })
    expect(await rig.session('s-wait')).toMatchObject({ status: 'waiting' })
    expect(await rig.row('s-monitor')).toMatchObject({ workingMode: 'monitoring' })

    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'second turn after clear' }), { session: 's-done' })
    const resurrected = threadFor((await activity()).threads, 's-done')!
    expect(resurrected.turn).not.toBe(clearedTurn)
    expect(resurrected).toMatchObject({ prompt: 'second turn after clear', unread: true })
  })

  test('session exit removes the live row but retains its Activity snapshot across restart', async () => {
    rig = await Rig.start()
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'retain after terminal exit' }))
    const beforeExit = threadFor((await activity()).threads, 's1')!

    await rig.exit('s1')
    await rig.settle()
    expect(await rig.row('s1')).toBeNull()
    expect(threadFor((await activity()).threads, 's1')).toMatchObject({
      sessionId: 's1',
      worktreeId: 'wt1',
      turn: beforeExit.turn,
      prompt: 'retain after terminal exit',
      display: 'interrupted',
      live: false
    })

    rig = await rig.restart()
    expect(threadFor((await activity()).threads, 's1')).toMatchObject({
      sessionId: 's1',
      turn: beforeExit.turn,
      prompt: 'retain after terminal exit',
      display: 'interrupted',
      live: false
    })

    expect(await rig.client.callAny('quirky.agent-status/clearCompleted', {})).toEqual({ cleared: 1 })
    expect((await activity()).threads).toEqual([])
    expect(await rig.session('s1')).toMatchObject({ status: 'exited' })
  })
})

describe('Activity CLI', () => {
  test(
    'activity --text returns the same filtered thread query through the real CLI process',
    async () => {
      e2e = await startStatusE2E({ fakes: { claude: true } })
      const session = await newSession(e2e, 'claude')
      const agent = await startOf(e2e, 'claude', session.id)
      await e2e.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'activity cli marker' }), { pid: agent.pid })
      await waitFor(
        async () => ((await e2e!.call('quirky.agent-status/get', { session: session.id })) as { state?: string } | null)?.state === 'working' || undefined,
        10_000,
        'the agent status row'
      )

      const result = await e2e.cli(['agent-status', 'activity', '--text', 'marker', '--json'])
      expect(result.code, result.stderr || result.stdout).toBe(0)
      const fromCli = JSON.parse(result.stdout) as ActivityResult
      const fromApi = (await e2e.call('quirky.agent-status/activity', { text: 'marker' })) as ActivityResult
      expect(fromCli).toEqual(fromApi)
      expect(fromCli.threads.map((thread) => thread.sessionId)).toEqual([session.id])
    },
    60_000
  )
})
