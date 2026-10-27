import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { conceptualWorkspace, fakeDaemon, loadWorkspace, mountFixture, session, simpleWorkspace, startRecording, stopRecording, unloadWorkspace, type MountedWorkspace } from './workspace-support'

let mounted: MountedWorkspace | null = null

beforeAll(loadWorkspace)
afterAll(unloadWorkspace)
beforeEach(startRecording)
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  stopRecording()
  document.body.innerHTML = ''
})

const sessionsWith = (over: Record<string, Partial<Session>>) => ['s-1', 's-2', 's-3', 's-4', 's-5'].map((id) => session(id, over[id] ?? {}))

describe('the tab strip draws the unread bell', () => {
  const reasons: [NonNullable<Session['unread']>, string][] = [
    ['agent', 'Unread agent completion'],
    ['bell', 'Unread bell'],
    ['notification', 'Unread notification']
  ]
  for (const [reason, label] of reasons) {
    test(`${reason} draws glyph-unread labelled "${label}" in place of the status glyph`, async () => {
      mounted = await mountFixture(fakeDaemon(simpleWorkspace(), { sessions: [session('s-1', { unread: reason, status: 'working' })] }))
      const bell = mounted.q('.qt-tab .glyph-unread')!
      expect(bell.getAttribute('role')).toBe('img')
      expect(bell.getAttribute('aria-label')).toBe(label)
      expect(bell.className).toBe('glyph glyph-unread')
      expect(mounted.qa('.qt-tab .glyph, .qt-tab .qt-dot')).toHaveLength(1)
    })
  }

  test('a session that is not unread keeps its status glyph', async () => {
    mounted = await mountFixture(fakeDaemon(simpleWorkspace(), { sessions: [session('s-1', { unread: null })] }))
    expect(mounted.q('.qt-tab .glyph-unread')).toBeNull()
    expect(mounted.q('.qt-tab .qt-dot')).not.toBeNull()
  })

  test('an unread session in a pane that is not the lead marks the tab', async () => {
    mounted = await mountFixture(fakeDaemon(conceptualWorkspace(), { sessions: sessionsWith({ 's-4': { unread: 'bell' } }) }))
    const tabs = mounted.qa('.qt-tab')
    expect(tabs.map((tab) => tab.querySelector('.glyph-unread')?.getAttribute('aria-label') ?? null)).toEqual([null, 'Unread bell', null])
  })

  test('the first unread session of the tab names the reason', async () => {
    mounted = await mountFixture(fakeDaemon(conceptualWorkspace(), { sessions: sessionsWith({ 's-2': { unread: 'notification' }, 's-4': { unread: 'agent' } }) }))
    expect(mounted.qa('.qt-tab')[1]!.querySelector('.glyph-unread')!.getAttribute('aria-label')).toBe('Unread notification')
  })
})

describe('the worktree view reports the sessions on screen', () => {
  test('visibleSessions lists every pane of the active tab of every group, and not an inactive tab', async () => {
    mounted = await mountFixture(fakeDaemon(conceptualWorkspace()))
    expect(mounted.last().visibleSessions).toEqual(['s-2', 's-3', 's-4', 's-5'])
  })

  test('an expanded pane hides its siblings', async () => {
    const ws = conceptualWorkspace()
    ;(ws.root as any).first.tabs[1].expandedPane = 'pane-3'
    mounted = await mountFixture(fakeDaemon(ws))
    expect(mounted.last().visibleSessions).toEqual(['s-3', 's-5'])
  })

  test('a workspace with one tab reports its session', async () => {
    mounted = await mountFixture(fakeDaemon(simpleWorkspace()))
    expect(mounted.last().visibleSessions).toEqual(['s-1'])
  })
})
