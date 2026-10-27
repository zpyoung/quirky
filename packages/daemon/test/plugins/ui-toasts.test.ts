import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode, type QuirkyClient, type QuirkyEvent, type UiToastState } from '@quirky/protocol'
import { sendNotification } from '../../src/notify'
import { Connection } from '../../../ui/src/connection'
import { bootWindow, closeWindows, installUiPlugin } from '../../../ui/test/fixtures/window-env'
import { startHarness, waitForAsync, type Harness } from '../helpers'
import { removeTempDirs } from './fixtures'

const harnesses: Harness[] = []

afterEach(async () => {
  await closeWindows()
  for (const harness of harnesses.splice(0)) await harness.cleanup()
  delete (globalThis as { __ran?: unknown }).__ran
  removeTempDirs()
})

async function failure(call: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await call
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to reject')
}

type Request = Extract<QuirkyEvent, { type: 'ui.command.request' }>
type Window = { client: QuirkyClient; events: QuirkyEvent[]; requests: Request[] }

/** A subscribed `ui` client standing in for a window; it answers every routed request with a null result. */
async function openWindow(harness: Harness, name?: string): Promise<Window> {
  const client = await harness.connect('ui', name)
  const window: Window = { client, events: [], requests: [] }
  client.onEvent((event) => {
    window.events.push(event)
    if (event.type !== 'ui.command.request') return
    window.requests.push(event)
    client.call('ui.command.reply', { requestId: event.requestId, result: null }).catch(() => {})
  })
  await client.call('events.subscribe', {})
  return window
}

const toast = (key: string | null, title = 'Title'): UiToastState => ({
  key,
  kind: 'info',
  title,
  body: 'Body',
  detail: null,
  persistent: false,
  actions: []
})

async function start() {
  const harness = await startHarness({ builtinPluginsDir: null })
  harnesses.push(harness)
  return { harness, caller: await harness.connect('cli') }
}

describe('ui.shell.report', () => {
  test('ui.state lists the toasts a window reported and follows its later reports', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness)
    expect((await caller.call('ui.state', {})).toasts).toEqual([])

    const shown: UiToastState = {
      key: 'handoff',
      kind: 'warning',
      title: 'Brief delivery could not be confirmed.',
      body: 'Resend is available.',
      detail: 'Claude did not echo the brief.',
      persistent: true,
      actions: [{ label: 'Resend brief', command: 'command:quirky.handoff/resend', args: { child: 'c1' } }]
    }
    await window.client.call('ui.shell.report', { toasts: [shown] })
    expect((await caller.call('ui.state', {})).toasts).toEqual([shown])

    await window.client.call('ui.shell.report', { toasts: [] })
    expect((await caller.call('ui.state', {})).toasts).toEqual([])
  })

  test('the focused window wins, else the window that reported last, and a dropped window takes its list along', async () => {
    const { harness, caller } = await start()
    const first = await openWindow(harness, 'first')
    const second = await openWindow(harness, 'second')
    await first.client.call('ui.shell.report', { toasts: [toast('a')] })
    await second.client.call('ui.shell.report', { toasts: [toast('b')] })
    const keys = async () => (await caller.call('ui.state', {})).toasts.map((t) => t.key)

    expect(await keys()).toEqual(['b'])
    await first.client.call('ui.window.focused', { focused: true })
    expect(await keys()).toEqual(['a'])
    await first.client.call('ui.window.focused', { focused: false })
    expect(await keys()).toEqual(['b'])

    second.client.close()
    await waitForAsync(async () => (await keys()).join() === 'a')
  })

  test('a focused window that has not reported shows an empty list, not another window\'s', async () => {
    const { harness, caller } = await start()
    const reporting = await openWindow(harness, 'reporting')
    const silent = await openWindow(harness, 'silent')
    await reporting.client.call('ui.shell.report', { toasts: [toast('a')] })
    const keys = async () => (await caller.call('ui.state', {})).toasts.map((t) => t.key)

    expect(await keys()).toEqual(['a'])
    await silent.client.call('ui.window.focused', { focused: true })
    expect(await keys()).toEqual([])
  })

  test('only a window can report, and the list must be an array under 64 KiB', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness)

    expect((await failure(caller.call('ui.shell.report', { toasts: [] }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(window.client.callAny('ui.shell.report', { toasts: 'nope' }))).code).toBe(RpcErrorCode.InvalidParams)
    const huge = [toast('big', 'x'.repeat(65 * 1024))]
    expect((await failure(window.client.call('ui.shell.report', { toasts: huge }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await caller.call('ui.state', {})).toasts).toEqual([])
  })
})

describe('ui.toast.dismiss', () => {
  test('routes the dismissal to the window showing the toast', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness)
    await window.client.call('ui.shell.report', { toasts: [toast('handoff')] })

    expect(await caller.call('ui.toast.dismiss', { key: 'handoff' })).toEqual({ ok: true })
    expect(window.requests).toEqual([
      { type: 'ui.command.request', requestId: expect.any(String), id: 'ui.toast.dismiss', args: { key: 'handoff' } }
    ])
  })

  test('goes to the window whose list ui.state shows, not just the newest connection', async () => {
    const { harness, caller } = await start()
    const first = await openWindow(harness, 'first')
    const second = await openWindow(harness, 'second')
    await first.client.call('ui.shell.report', { toasts: [toast('mine')] })
    await first.client.call('ui.window.focused', { focused: true })
    await second.client.call('ui.shell.report', { toasts: [] })

    await caller.call('ui.toast.dismiss', { key: 'mine' })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(0)
  })

  test('a focused window that has not reported is the target: NotFound, and the background window gets nothing', async () => {
    const { harness, caller } = await start()
    const background = await openWindow(harness, 'background')
    const focused = await openWindow(harness, 'focused')
    await background.client.call('ui.shell.report', { toasts: [toast('theirs')] })
    await focused.client.call('ui.window.focused', { focused: true })

    expect(await failure(caller.call('ui.toast.dismiss', { key: 'theirs' }))).toMatchObject({ code: RpcErrorCode.NotFound })
    expect(background.requests).toEqual([])
    expect(focused.requests).toEqual([])
  })

  test('fails NotFound for a key no toast has and sends nothing', async () => {
    const { harness, caller } = await start()
    const window = await openWindow(harness)
    await window.client.call('ui.shell.report', { toasts: [toast('other'), toast(null)] })

    const error = await failure(caller.call('ui.toast.dismiss', { key: 'handoff' }))
    expect(error).toMatchObject({ code: RpcErrorCode.NotFound })
    expect(window.requests).toEqual([])
  })

  test('fails Conflict when no window is open', async () => {
    const { caller } = await start()
    const error = await failure(caller.call('ui.toast.dismiss', { key: 'handoff' }))
    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: 'no Quirky window is open' })
  })
})

describe('notify events', () => {
  test('carry the toast fields a plugin sets, and only those', () => {
    const notifies: QuirkyEvent[] = []
    const deps = { broadcast: (event: QuirkyEvent) => notifies.push(event), hasDesktopClient: () => true, notifier: () => {} }

    sendNotification(deps, { title: 't', body: 'b' })
    sendNotification(deps, {
      title: 't',
      body: 'b',
      kind: 'success',
      key: 'k',
      persistent: true,
      detail: 'd',
      actions: [{ label: 'Go', command: 'command:a.b/go', args: { n: 1 }, keepOpen: true }],
      onDismiss: { command: 'command:a.b/gone' }
    })

    expect(notifies[0]).toEqual({ type: 'notify', title: 't', body: 'b', desktop: true })
    expect(notifies[1]).toMatchObject({
      kind: 'success',
      key: 'k',
      persistent: true,
      detail: 'd',
      actions: [{ label: 'Go', command: 'command:a.b/go', args: { n: 1 }, keepOpen: true }],
      onDismiss: { command: 'command:a.b/gone' }
    })
  })
})

describe('a real window', () => {
  const SHOW = 'command:acme.toasts/show'
  const GONE = 'command:acme.toasts/gone'

  function writeToasts(installed: string): void {
    installUiPlugin(
      installed,
      'acme.toasts',
      { command: [{ id: 'show', title: 'Show' }, { id: 'gone', title: 'Gone' }] },
      [
        `context.provide(${JSON.stringify(SHOW)}, () => context.toast('Delivery', 'Not confirmed', {`,
        `  kind: 'warning', key: 'delivery', persistent: true, detail: 'Try again',`,
        `  actions: [{ label: 'Resend', command: ${JSON.stringify(GONE)}, args: { n: 1 }, keepOpen: true }],`,
        `  onDismiss: { command: ${JSON.stringify(GONE)}, args: { dismissed: true } }`,
        `}))`,
        `context.provide(${JSON.stringify(GONE)}, (args) => { (globalThis.__ran ??= []).push(args) })`
      ].join('\n')
    )
  }

  const ran = () => ((globalThis as { __ran?: unknown[] }).__ran ?? []) as unknown[]

  test('a window reports its empty toast list as soon as it connects', async () => {
    const reports: unknown[] = []
    const callAny = Connection.prototype.callAny
    Connection.prototype.callAny = function (this: Connection, method: string, params: Record<string, unknown>) {
      if (method === 'ui.shell.report') reports.push(params)
      return callAny.call(this, method, params)
    }
    try {
      await bootWindow(writeToasts)
      await waitForAsync(async () => reports.length > 0)
      expect(reports[0]).toEqual({ toasts: [] })
    } finally {
      Connection.prototype.callAny = callAny
    }
  })

  test('reports what the plugin showed, and ui.toast.dismiss dismisses it and runs onDismiss once', async () => {
    const { agent } = await bootWindow(writeToasts)
    await agent.callAny('ui.command.run', { id: SHOW })

    const shown = await waitForAsync(async () => {
      const { toasts } = await agent.call('ui.state', {})
      return toasts.length === 1 ? toasts : null
    })
    expect(shown).toEqual([
      {
        key: 'delivery',
        kind: 'warning',
        title: 'Delivery',
        body: 'Not confirmed',
        detail: 'Try again',
        persistent: true,
        actions: [{ label: 'Resend', command: GONE, args: { n: 1 } }]
      }
    ])

    await agent.call('ui.toast.dismiss', { key: 'delivery' })
    await waitForAsync(async () => (await agent.call('ui.state', {})).toasts.length === 0)
    expect(ran()).toEqual([{ dismissed: true }])
    expect((await failure(agent.call('ui.toast.dismiss', { key: 'delivery' }))).code).toBe(RpcErrorCode.NotFound)
  })
})
