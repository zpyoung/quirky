import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import type { ActivityQuery, ActivityThread } from '../src/activity-types'
import type { DashboardQuery, DashboardSnapshot } from '../src/dashboard-types'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { Rig } from './support'

let rig: Rig | undefined

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
  removeTempDirs()
})

const claude = (event: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event, ...extra })
const activity = (query: ActivityQuery = {}) => rig!.client.callAny('quirky.agent-status/activity', query) as Promise<{ threads: ActivityThread[] }>
const dashboard = (query: DashboardQuery = {}) => rig!.client.callAny('quirky.agent-status/dashboard', query) as Promise<DashboardSnapshot>
const acknowledge = (session: string, turn: string) => rig!.client.callAny('quirky.agent-status/acknowledge', { session, turn })
const ids = (snapshot: DashboardSnapshot) => snapshot.cards.map(({ thread }) => thread.sessionId)

describe('Agent Dashboard public API', () => {
  test('counts every matching retained Activity thread and keeps an acknowledged completion in Done', async () => {
    rig = await Rig.start({
      sessions: [
        { id: 's-wait', worktreeId: 'wt1', name: 'question' },
        { id: 's-work', worktreeId: 'wt2', agent: 'codex', name: 'working' },
        { id: 's-done', worktreeId: 'wt1', name: 'finished' },
        { id: 's-idle', worktreeId: 'wt1', name: 'idle' }
      ]
    })

    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'release checklist' }), { session: 's-wait' })
    await rig.hook('claude', claude('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which branch?' }] } }), { session: 's-wait' })
    await rig.hook('codex', claude('UserPromptSubmit', { prompt: 'audit portal' }), { session: 's-work' })
    await rig.hook('claude', claude('SessionStart', { source: 'startup' }), { session: 's-idle' })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'finish release' }), { session: 's-done' })
    await rig.hook('claude', claude('Stop', { last_assistant_message: 'Release complete' }), { session: 's-done' })

    const completed = (await activity()).threads.find((thread) => thread.sessionId === 's-done')!
    expect(await acknowledge('s-done', completed.turn)).toEqual({ acknowledged: 1 })

    const snapshot = await dashboard()
    expect(snapshot.total).toBe(4)
    expect(snapshot.hiddenIdle).toBe(1)
    expect(ids(snapshot)).toEqual(['s-wait', 's-work', 's-done'])
    expect(snapshot.cards.map(({ bucket }) => bucket)).toEqual(['attention', 'working', 'done'])
    expect(snapshot.cards.find(({ thread }) => thread.sessionId === 's-done')?.thread).toMatchObject({ display: 'done', unread: false })
    const revealed = await dashboard({ showIdle: true })
    expect(revealed.total).toBe(4)
    expect(revealed.hiddenIdle).toBe(0)
    expect(ids(revealed)).toEqual(['s-wait', 's-work', 's-done', 's-idle'])
    expect(revealed.cards.at(-1)).toMatchObject({ bucket: 'idle', thread: { display: 'idle' } })
    const detail = snapshot.cards.find(({ thread }) => thread.sessionId === 's-wait')?.thread.detail ?? ''
    expect(detail).toContain('Which branch?')
    expect(detail).not.toMatch(/^\s*\{/)
  })

  test('filters the shared Activity projection by text, project, workspace status and real review lookup', async () => {
    rig = await Rig.start({
      sessions: [
        { id: 's-alpha', worktreeId: 'wt1', name: 'alpha' },
        { id: 's-beta', worktreeId: 'wt2', name: 'beta' },
        { id: 's-unavailable', worktreeId: 'wt3', name: 'unavailable' }
      ]
    })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'release alpha' }), { session: 's-alpha' })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'release beta' }), { session: 's-beta' })
    await rig.hook('claude', claude('UserPromptSubmit', { prompt: 'ticket gamma' }), { session: 's-unavailable' })

    expect(ids(await dashboard({ text: 'alpha' }))).toEqual(['s-alpha'])
    expect(ids(await dashboard({ project: 'repo-a' }))).toEqual(['s-alpha'])
    expect(ids(await dashboard({ workspaceStatus: 'in-review' }))).toEqual(['s-beta'])
    expect(ids(await dashboard({ reviewStatus: 'open' }))).toEqual(['s-alpha'])
    expect(ids(await dashboard({ reviewStatus: 'no-review' }))).toEqual(['s-beta'])

    const unavailable = await dashboard({ project: 'repo-c', reviewStatus: 'open' })
    expect(unavailable.cards).toEqual([])
    expect(unavailable.unavailable).toContain('GitHub review status is unavailable for wt3: authentication unavailable')
  })

  test('rejects invalid filter values instead of silently returning a misleading board', async () => {
    rig = await Rig.start()
    const invalidStatus = dashboard({ workspaceStatus: 'doing' } as DashboardQuery)
    await expect(invalidStatus).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    const invalidReview = dashboard({ reviewStatus: 'pending' } as DashboardQuery)
    await expect(invalidReview).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    const invalidIdle = dashboard({ showIdle: 'yes' } as unknown as DashboardQuery)
    await expect(invalidIdle).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  })
})
