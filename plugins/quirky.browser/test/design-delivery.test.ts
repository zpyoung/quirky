import { expect, test } from 'bun:test'
import { DesignService } from '../src/design/service'
import type { PluginContext } from '@quirky/protocol'
import type { PaneTab } from '../src/pane-contract'
import type { DesignPayload } from '../src/design-contract'

const samplePayload: DesignPayload = {
  page: { sanitizedUrl: 'https://example.test/', title: 'Fixture', viewportWidth: 800, viewportHeight: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1, capturedAt: '2026-10-27T00:00:00.000Z' },
  target: {
    tagName: 'P', selector: 'p', elementPath: 'p', fullPath: 'html > body > p', cssClasses: '', nearbyElements: [],
    selectedText: null, isFixed: false, reactComponents: null, sourceFile: null, textSnippet: 'paragraph', htmlSnippet: '<p>paragraph</p>', attributes: {},
    accessibility: { role: '', accessibleName: '', ariaLabel: '', ariaLabelledBy: '' }, rectViewport: { x: 0, y: 0, width: 1, height: 1 },
    rectPage: { x: 0, y: 0, width: 1, height: 1 }, computedStyles: {}
  },
  nearbyText: [], ancestorPath: [], screenshot: null
}

function pane(worktreeId: string): PaneTab {
  return {
    id: 'pane-one', worktreeId, profileId: 'default', partition: 'default', mode: 'watch', page: 'browser-page-one',
    url: 'https://example.test/', title: 'Fixture', loading: false, error: null, canGoBack: false, canGoForward: false,
    zoom: 0, viewport: 'default', command: null, find: { text: '', current: 0, total: 0 }, prompts: [], downloads: []
  }
}

type AgentStateSnapshot = { status: string; display: string; state: 'working' | 'waiting' | 'blocked' | 'done' }
const READY: AgentStateSnapshot = { status: 'running', display: 'idle', state: 'working' }

function serviceHarness(selectedWorktree: string, listed = READY, current = listed) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const sessionRecord = (state: AgentStateSnapshot) => ({
    id: 'session-one', kind: 'terminal', agent: 'claude', worktreeId: selectedWorktree, cwd: '/tmp/one', title: 'Claude',
    status: state.status, lastActivityAt: 1, agentStatus: { display: state.display, label: state.display, state: state.state }
  })
  const context = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params })
      if (method === 'quirky.worktree/list') return [
        { id: 'worktree-one', name: 'One', path: '/tmp/one', branch: null },
        { id: 'worktree-two', name: 'Two', path: '/tmp/two', branch: null }
      ]
      if (method === 'quirky.session/list') return [sessionRecord(listed)]
      if (method === 'quirky.terminal/sessions') return { sessions: [{ sessionId: 'session-one', state: 'running', worktreeId: selectedWorktree, cwd: '/tmp/one' }] }
      if (method === 'quirky.agents/list') return { agents: [{ id: 'claude', label: 'Claude', installed: true, enabled: true }] }
      if (method === 'quirky.session/get') return sessionRecord(current)
      throw new Error(`unexpected public API call: ${method}`)
    }
  } as unknown as PluginContext
  const design = new DesignService(context, {} as never, () => [pane('worktree-one')], (id) => {
    if (id !== 'browser-page-one') throw new Error('unexpected page')
    return { browserPageId: id, worktreeId: 'worktree-one', profileId: 'default', index: 0, active: true, url: 'https://example.test/', title: 'Fixture', loadError: null } as never
  })
  return { design, calls }
}

const note = [{ id: 'note', revision: 1, browserPageId: 'browser-page-one', payload: samplePayload, intent: 'change' as const, comment: 'Fix this' }]

test('designSend rejects sessions assigned to another pane worktree', async () => {
  const { design, calls } = serviceHarness('worktree-two')
  await expect(design.designSend({ pane: 'pane-one', annotations: note, session: 'session-one' })).rejects.toThrow('selected session is not a running target in this pane worktree')
  expect(calls.some((call) => call.method === 'quirky.agents/deliver')).toBe(false)
})

test('designTargets disables starting, waiting, blocked, and permission-gated sessions', async () => {
  const states: AgentStateSnapshot[] = [
    { status: 'starting', display: 'idle', state: 'working' },
    { status: 'waiting', display: 'waiting', state: 'waiting' },
    { status: 'running', display: 'waiting', state: 'waiting' },
    { status: 'running', display: 'blocked', state: 'blocked' },
    { status: 'running', display: 'permission', state: 'waiting' }
  ]
  for (const state of states) {
    const { design } = serviceHarness('worktree-one', state)
    const targets = await design.designTargets({ pane: 'pane-one' })
    expect(targets.sessions[0]?.sendable).toBe(false)
  }
})

test('designSend rechecks a newly waiting or permission-gated session before delivery', async () => {
  const transitions: AgentStateSnapshot[] = [
    { status: 'starting', display: 'idle', state: 'working' },
    { status: 'waiting', display: 'waiting', state: 'waiting' },
    { status: 'running', display: 'permission', state: 'waiting' },
    { status: 'running', display: 'blocked', state: 'blocked' }
  ]
  for (const current of transitions) {
    const { design, calls } = serviceHarness('worktree-one', READY, current)
    await expect(design.designSend({ pane: 'pane-one', annotations: note, session: 'session-one' })).rejects.toBeInstanceOf(Error)
    expect(calls.some((call) => call.method === 'quirky.session/get')).toBe(true)
    expect(calls.some((call) => call.method === 'quirky.agents/deliver')).toBe(false)
  }
})
