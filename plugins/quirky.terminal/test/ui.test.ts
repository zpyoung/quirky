import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { fakeContext, settle, type FakeContext } from '../../quirky.session/test/ui-fake'

const PANEL = 'panel:quirky.terminal/sessions'

type Row = {
  sessionId: string
  state: string
  pid: number
  cwd: string
  shellState: string
  worktreeId: string | null
  workspace: string
  tabTitle: string | null
  worktreeName: string | null
}

function row(
  sessionId: string,
  worktreeId: string | null,
  workspace: string,
  tabTitle: string | null = null,
  worktreeName: string | null = null,
  cwd = `/tmp/${workspace}`
): Row {
  return { sessionId, state: 'running', pid: 100, cwd, shellState: 'ready', worktreeId, workspace, tabTitle, worktreeName }
}

let activateModule: (context: FakeContext['context']) => void
let fake: FakeContext
let live: Row[]
let reports: unknown[]
let element: HTMLElement | null = null
let unmount: (() => void) | void = undefined

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ activate: activateModule } = await import('../src/ui'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(async () => {
  if (unmount) await act(async () => void (unmount as () => void)())
  unmount = undefined
  document.body.innerHTML = ''
  element = null
})

async function openPanel(sessions: Row[], extra: Record<string, (params: Record<string, any>) => unknown> = {}) {
  live = sessions
  reports = []
  fake = fakeContext({
    'quirky.terminal/sessions': () => ({ sessions: live }),
    'quirky.terminal/kill': (params) => {
      live = live.filter((entry) => entry.sessionId !== params.session)
      return { ok: true }
    },
    'quirky.terminal/killAll': () => {
      const killedSessionIds = live.map((entry) => entry.sessionId)
      live = []
      return { killedCount: killedSessionIds.length, remainingCount: 0, killedSessionIds }
    },
    'quirky.terminal/restartHost': () => {
      live = []
      return { pid: 4242 }
    },
    ...extra
  })
  activateModule(fake.context)
  element = document.createElement('div')
  document.body.appendChild(element)
  await act(async () => {
    unmount = fake.provided.get(PANEL)!(element!, { report: (state: unknown) => reports.push(state) })
  })
  await settle()
}

const button = (label: string) => element!.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
const click = (target: Element) => act(async () => void target.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const rows = () => [...element!.querySelectorAll('[data-session]')] as HTMLElement[]

const two = [
  row('s1', 'wt-main', 'w/api', 'Terminal 1', 'main', '/fake/alpha'),
  row('s2', 'wt-fix', 'api/fix-login', 'Feature login', 'fix-login', '/fake/fix-login')
]


describe('the Terminal Sessions panel', () => {
  test('shows tab and worktree labels without exposing IDs, while reports retain session IDs', async () => {
    await openPanel(two)
    expect(rows()).toHaveLength(2)
    expect(rows()[0]!.textContent).toContain('Terminal 1')
    expect(rows()[0]!.textContent).toContain('main')
    expect(rows()[1]!.textContent).toContain('Feature login')
    expect(rows()[1]!.textContent).toContain('fix-login')
    for (const entry of rows()) {
      expect(entry.textContent).not.toContain(entry.dataset.session)
      expect(entry.textContent).not.toContain('wt-main')
      expect(entry.textContent).not.toContain('wt-fix')
    }
    expect(reports[reports.length - 1]).toEqual({
      count: 2,
      rows: [
        { sessionId: 's1', workspace: 'w/api', state: 'running' },
        { sessionId: 's2', workspace: 'api/fix-login', state: 'running' }
      ]
    })
  })

  test('uses the full cwd when a live host session has no matching terminal tab', async () => {
    await openPanel([row('s_orphan', null, 'solo', null, null, '/private/solo/project')])
    expect(rows()[0]!.textContent).toContain('/private/solo/project')
    expect(rows()[0]!.textContent).not.toContain('s_orphan')
  })

  test('SC-26: clicking a row opens that session, clicking its kill button does not', async () => {
    await openPanel(two)
    await click(rows()[1]!)
    expect(fake.opened).toEqual([{ id: 'view:quirky.session/worktree', input: { worktree: 'wt-fix', session: 's2' } }])
    fake.state.confirmAnswer = false
    await click(button('Kill session s1'))
    expect(fake.opened).toHaveLength(1)
  })

  test('refreshes on Refresh, session events and terminal layout renames', async () => {
    await openPanel([row('s1', 'wt-main', 'w/api', 'Terminal 1', 'main', '/fake/alpha')])
    expect(fake.callsTo('quirky.terminal/sessions')).toHaveLength(1)
    live = two
    await click(button('Refresh'))
    expect(rows()).toHaveLength(2)

    live = [row('s1', 'wt-main', 'w/api', 'Renamed main', 'main', '/fake/alpha')]
    await fake.emit({ type: 'quirky.terminal/layout', data: { workspace: 'wt-main', revision: 2 } } as never)
    await settle()
    expect(rows()[0]!.textContent).toContain('Renamed main')

    live = [two[1]!]
    await fake.emit({ type: 'quirky.session/changed', data: {} } as never)
    await settle()
    expect(rows().map((entry) => entry.dataset.session)).toEqual(['s2'])
    live = []
    await fake.emit({ type: 'quirky.session/removed', data: { sessionId: 's2' } } as never)
    await settle()
    expect(rows()).toHaveLength(0)
  })

  test('SC-27: kill asks first, cancelling leaves the session, confirming removes its row', async () => {
    await openPanel(two)
    fake.state.confirmAnswer = false
    await click(button('Kill session s1'))
    expect(fake.confirms).toEqual([
      {
        title: 'Kill this session?',
        body: "Force-quits s1. Any unsaved work in that pane is lost. This can't be undone.",
        confirmLabel: 'Kill session'
      }
    ])
    expect(fake.callsTo('quirky.terminal/kill')).toEqual([])
    expect(rows().map((entry) => entry.dataset.session)).toEqual(['s1', 's2'])

    fake.state.confirmAnswer = true
    await click(button('Kill session s1'))
    await settle()
    expect(fake.callsTo('quirky.terminal/kill').map((call) => call.params)).toEqual([{ session: 's1', yes: true }])
    expect(rows().map((entry) => entry.dataset.session)).toEqual(['s2'])
    expect(fake.toasts.map((toast) => toast.title)).toContain('Killed session.')
  })

  test('SC-28: restart asks first, then the panel empties', async () => {
    await openPanel([row('s1', 'wt-main', 'w/api')])
    fake.state.confirmAnswer = false
    await click(button('Restart terminal host'))
    expect(fake.callsTo('quirky.terminal/restartHost')).toEqual([])

    fake.state.confirmAnswer = true
    await click(button('Restart terminal host'))
    await settle()
    expect(fake.confirms[1]).toEqual({
      title: 'Restart the terminal service?',
      body: 'Open terminals and agents will restart. Terminals on remote hosts are not affected.',
      confirmLabel: 'Restart'
    })
    expect(fake.callsTo('quirky.terminal/restartHost').map((call) => call.params)).toEqual([{ yes: true }])
    expect(rows()).toHaveLength(0)
    expect(fake.toasts.map((toast) => toast.title)).toContain('Terminal host restarted.')
  })

  test('a failed restart says so and keeps the list', async () => {
    await openPanel(two, {
      'quirky.terminal/restartHost': () => {
        throw new RpcError(RpcErrorCode.Internal, 'host did not come back')
      }
    })
    await click(button('Restart terminal host'))
    await settle()
    expect(rows()).toHaveLength(2)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]!.title).toBe('Restart failed — check logs.')
  })

  test('SC-29: with nothing to kill the panel says so and Kill all is disabled', async () => {
    await openPanel([])
    expect(rows()).toHaveLength(0)
    expect(button('Kill all sessions').disabled).toBe(true)
    expect(reports[reports.length - 1]).toEqual({ count: 0, rows: [] })
  })

  test('Kill all confirms, kills every session and reports the count', async () => {
    await openPanel(two)
    expect(button('Kill all sessions').disabled).toBe(false)
    await click(button('Kill all sessions'))
    await settle()
    expect(fake.confirms[0]).toEqual({ title: 'Kill all terminal sessions?', confirmLabel: 'Kill all' })
    expect(fake.callsTo('quirky.terminal/killAll').map((call) => call.params)).toEqual([{ yes: true }])
    expect(rows()).toHaveLength(0)
    expect(fake.toasts.map((toast) => toast.title)).toContain('Killed 2 sessions.')
  })
})
