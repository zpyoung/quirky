import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { fakeContext, settle, type FakeContext } from '../../quirky.session/test/ui-fake'

const PANEL = 'panel:quirky.terminal/sessions'

type Row = { sessionId: string; state: string; pid: number; cwd: string; shellState: string; worktreeId: string | null; workspace: string }

function row(sessionId: string, worktreeId: string, workspace: string): Row {
  return { sessionId, state: 'running', pid: 100, cwd: `/tmp/${workspace}`, shellState: 'ready', worktreeId, workspace }
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

const two = [row('s1', 'wt-main', 'w/api'), row('s2', 'wt-fix', 'api/fix-login')]


describe('the Terminal Sessions panel', () => {
  test('SC-26: lists a row per live session with its workspace, id and kill button, and reports them', async () => {
    await openPanel(two)
    for (const label of ['Refresh', 'Kill all sessions', 'Restart terminal host']) expect(button(label)).not.toBeNull()
    expect(rows().map((entry) => [...entry.querySelectorAll('.sessions-workspace, .sessions-id')].map((cell) => cell.textContent))).toEqual([
      ['w/api', 's1'],
      ['api/fix-login', 's2']
    ])
    expect(button('Kill session s1')).not.toBeNull()
    expect(button('Kill session s2')).not.toBeNull()
    expect(reports[reports.length - 1]).toEqual({
      count: 2,
      rows: [
        { sessionId: 's1', workspace: 'w/api', state: 'running' },
        { sessionId: 's2', workspace: 'api/fix-login', state: 'running' }
      ]
    })
  })

  test('SC-26: clicking a row opens that session, clicking its kill button does not', async () => {
    await openPanel(two)
    await click(rows()[1]!)
    expect(fake.opened).toEqual([{ id: 'view:quirky.session/worktree', input: { worktree: 'wt-fix', session: 's2' } }])
    fake.state.confirmAnswer = false
    await click(button('Kill session s1'))
    expect(fake.opened).toHaveLength(1)
  })

  test('refreshes on Refresh and on session changed and removed events', async () => {
    await openPanel([row('s1', 'wt-main', 'w/api')])
    expect(fake.callsTo('quirky.terminal/sessions')).toHaveLength(1)
    live = two
    await click(button('Refresh'))
    expect(rows()).toHaveLength(2)
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
