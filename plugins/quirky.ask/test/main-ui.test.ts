import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskSpec, PluginCaller, PluginContext, PluginStore, StoreMigration, UiState } from '@quirky/protocol'
import { activate, deactivate } from '../main'
import { memoryStore } from './support'

const WORKTREE_VIEW = 'view:quirky.session/worktree'
const OTHER_PANEL = 'panel:other'
const spec: AskSpec = { questions: [{ id: 'go', type: 'confirm', question: 'Go?' }] }

type TestStore = PluginStore & { db: Database }
type Method = (params: Record<string, unknown>, caller: PluginCaller) => Promise<unknown>

let home: string | undefined
let store: TestStore | undefined

afterEach(() => {
  deactivate()
  store?.db.close()
  store = undefined
  if (home) rmSync(home, { recursive: true, force: true })
  home = undefined
})

function state(activeSession: string, panel: string | null = null): UiState {
  return {
    windows: [{ connId: 1, focused: true, inputAt: 1, present: true }],
    layout: { view: { id: WORKTREE_VIEW, input: { worktree: 'wt_1' } }, panel, sidebar: true, focus: 'view' },
    slots: [{
      id: WORKTREE_VIEW,
      kind: 'view',
      plugin: 'quirky.session',
      title: 'Session',
      shown: true,
      report: { worktree: 'wt_1', active: activeSession, visibleSessions: [activeSession] }
    }],
    toasts: []
  }
}


function start(activeSession: string, panel: string | null = null) {
  const testHome = mkdtempSync(join(tmpdir(), 'qa-ui-main-'))
  home = testHome
  store = memoryStore()
  let currentState = state(activeSession, panel)
  const methods = new Map<string, Method>()
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const events: { event: string; data: unknown }[] = []
  const context = {
    pluginId: 'quirky.ask',
    home: testHome,
    log() {},
    openStore(migrations: StoreMigration[]) {
      for (const migration of migrations) {
        if (typeof migration === 'string') store!.exec(migration)
        else migration(store!)
      }
      return store
    },
    provide(id: string, implementation: unknown) {
      methods.set(id, implementation as Method)
    },
    emit(event: string, data: unknown) {
      events.push({ event, data })
      return true
    },
    subscribe() {
      return () => {}
    },
    error(_kind: string, message: string) {
      return new Error(message)
    },
    async call(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params })
      if (method === 'ui.state') return currentState
      if (method === 'ui.panel.open') {
        currentState = { ...currentState, layout: { ...currentState.layout, panel: params?.id as string } }
        return currentState.layout
      }
      if (method === 'plugin.list') return []
      throw new Error(`unexpected method ${method}`)
    }
  } as unknown as PluginContext
  activate(context)
  return {
    calls,
    events,
    state: () => currentState,
    setState(next: UiState) {
      currentState = next
    },
    async call(id: string, params: Record<string, unknown> = {}, caller: PluginCaller = { role: 'cli', sessionId: 's1', worktreeId: 'wt_1' }) {
      const method = methods.get(`method:quirky.ask/${id}`)
      if (!method) throw new Error(`missing method ${id}`)
      return method(params, caller)
    }
  }
}

describe('focused-session Questions reveal', () => {
  test('only a surfaced ask for the exact active session reveals the panel without moving terminal focus', async () => {
    const app = start('sess_other')

    const first = await app.call('create', { spec, session: 'sess_asked', worktree: 'wt_1' }) as { askId: string }
    expect(app.calls.filter((call) => call.method === 'ui.panel.open')).toEqual([])
    await app.call('cancel', { askId: first.askId })

    app.setState(state('sess_asked'))
    await app.call('create', { spec, session: 'sess_asked', worktree: 'wt_1' })

    expect(app.calls.filter((call) => call.method === 'ui.panel.open')).toEqual([
      { method: 'ui.panel.open', params: { id: 'panel:quirky.ask/questions' } }
    ])
    expect(app.state().layout).toMatchObject({ panel: 'panel:quirky.ask/questions', focus: 'view' })
  })

  test('a user-selected panel stays selected when the surfaced head changes', async () => {
    const app = start('sess_asked')
    const first = await app.call('create', { spec, session: 'sess_asked', worktree: 'wt_1' }) as { askId: string }
    const second = await app.call('create', { spec, session: 'sess_asked', worktree: 'wt_1' }) as { askId: string }
    expect(app.calls.filter((call) => call.method === 'ui.panel.open')).toHaveLength(1)

    app.setState(state('sess_asked', OTHER_PANEL))
    await app.call('cancel', { askId: first.askId })

    expect(app.events.filter((event) => event.event === 'surfaced')).toHaveLength(1)
    const pending = await app.call('list', { pendingOnly: true }) as { id: string; queued: boolean }[]
    expect(pending.map((ask) => [ask.id, ask.queued])).toEqual([[second.askId, false]])
    expect(app.calls.filter((call) => call.method === 'ui.panel.open')).toHaveLength(1)
    expect(app.state().layout).toMatchObject({ panel: OTHER_PANEL, focus: 'view' })
  })
})
