import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import type { Connection } from '../src/connection'
import { initialState, reduce, reportedToasts, type AppState } from '../src/lib/state'
import type { WindowPluginHost } from '../src/plugins/host'
import { Store } from '../src/store'

type Component = typeof import('../src/components/Toasts')
let component: Component
let act: typeof import('react').act
let mount: (store: Store, plugins: Pick<WindowPluginHost, 'runCommandForResult' | 'openView'>) => Promise<void>
let root: Root | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const [react, client, context] = await Promise.all([import('react'), import('react-dom/client'), import('../src/context')])
  component = await import('../src/components/Toasts')
  act = react.act
  mount = async (store, plugins) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = client.createRoot(container)
    const value = { store, connection: { store } as unknown as Connection, plugins: plugins as WindowPluginHost }
    await act(async () => {
      root!.render(react.createElement(context.AppContext.Provider, { value }, react.createElement(component.Toasts)))
    })
  }
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

const notify = (extra: Record<string, unknown> = {}) =>
  ({ type: 'event', event: { type: 'notify', title: 'Title', body: 'Body', desktop: false, ...extra } }) as Parameters<typeof reduce>[1]

describe('reducer', () => {
  test('a notify event without the new fields is an info toast with no extra properties', () => {
    const toast = reduce(initialState(), notify()).toasts[0]!
    expect(toast).toEqual({ id: 1, kind: 'info', title: 'Title', body: 'Body' })
  })

  test('a notify event copies kind, key, persistent, detail, actions and onDismiss', () => {
    const fields = {
      kind: 'warning' as const,
      key: 'k',
      persistent: true,
      detail: 'More',
      actions: [{ label: 'Go', command: 'command:a.b/go', args: { n: 1 }, keepOpen: true }],
      onDismiss: { command: 'command:a.b/gone', args: { n: 2 } }
    }
    expect(reduce(initialState(), notify(fields)).toasts[0]).toEqual({ id: 1, title: 'Title', body: 'Body', ...fields })
  })

  test('a toast with the key of a showing one replaces it in place under a new id', () => {
    let state = reduce(initialState(), notify({ key: 'a', title: 'first' }))
    state = reduce(state, notify({ key: 'b', title: 'other' }))
    state = reduce(state, notify({ key: 'a', title: 'second' }))
    expect(state.toasts.map((t) => [t.key, t.title, t.id])).toEqual([
      ['a', 'second', 3],
      ['b', 'other', 2]
    ])
  })

  test('toasts without a key never replace each other', () => {
    let state = reduce(initialState(), notify())
    state = reduce(state, notify())
    expect(state.toasts).toHaveLength(2)
  })

  test('dismissing a toast that is gone returns the same state', () => {
    const state = reduce(initialState(), notify())
    expect(reduce(state, { type: 'dismissToast', id: 99 })).toBe(state)
  })

  test('reportedToasts gives the shape ui.state shows and drops keepOpen', () => {
    const state: AppState = reduce(
      reduce(initialState(), notify()),
      notify({ kind: 'success', key: 'k', persistent: true, detail: 'd', actions: [{ label: 'Go', command: 'c', keepOpen: true }, { label: 'Two', command: 'c2', args: [1] }] })
    )
    expect(reportedToasts(state.toasts)).toEqual([
      { key: null, kind: 'info', title: 'Title', body: 'Body', detail: null, persistent: false, actions: [] },
      {
        key: 'k',
        kind: 'success',
        title: 'Title',
        body: 'Body',
        detail: 'd',
        persistent: true,
        actions: [{ label: 'Go', command: 'c' }, { label: 'Two', command: 'c2', args: [1] }]
      }
    ])
  })
})

type Plugins = { ran: [string, unknown][]; opened: [string, unknown][]; fail: Set<string> } & Pick<WindowPluginHost, 'runCommandForResult' | 'openView'>

function fakePlugins(): Plugins {
  const plugins: Plugins = {
    ran: [],
    opened: [],
    fail: new Set(),
    async runCommandForResult(id, args) {
      plugins.ran.push([id, args])
      if (plugins.fail.has(id)) throw new Error('kaboom')
      return null
    },
    openView(id, input) {
      plugins.opened.push([id, input])
    }
  }
  return plugins
}

let timers: { fn: () => void; ms: number | undefined; id: number }[] = []
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
beforeEach(() => {
  timers = []
  let next = 1
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = next++
    timers.push({ fn, ms, id })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    timers = timers.filter((t) => t.id !== id)
  }) as unknown as typeof clearTimeout
})
afterEach(() => {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
})

const titles = () => [...document.querySelectorAll('.toast-title')].map((el) => el.textContent)
const button = (label: string) => [...document.querySelectorAll('.toast button')].find((el) => el.textContent === label || el.getAttribute('aria-label') === label) as HTMLElement
const click = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))

async function show(extra: Record<string, unknown> = {}, plugins = fakePlugins()) {
  const store = new Store()
  await mount(store, plugins)
  await act(async () => store.dispatch(notify(extra)))
  return { store, plugins }
}

describe('Toasts', () => {
  test('a plain toast renders as before: info, title and body, no detail or actions, a 6 s timer', async () => {
    await show()
    const toast = document.querySelector('.toast')!
    expect(toast.className).toBe('toast toast-info')
    expect(toast.querySelector('.toast-body')?.textContent).toBe('Body')
    expect(toast.querySelector('.toast-detail')).toBeNull()
    expect(toast.querySelector('.toast-actions')).toBeNull()
    expect(timers.map((t) => t.ms)).toEqual([6000])
  })

  test('kind, detail and action buttons render', async () => {
    await show({ kind: 'success', detail: 'Second line', actions: [{ label: 'Open', command: 'c' }, { label: 'Again', command: 'd' }] })
    expect(document.querySelector('.toast')!.className).toBe('toast toast-success')
    expect(document.querySelector('.toast-detail')?.textContent).toBe('Second line')
    expect([...document.querySelectorAll('.toast-actions button')].map((b) => b.textContent)).toEqual(['Open', 'Again'])
  })

  test('the timer dismisses a toast and runs its onDismiss', async () => {
    const { plugins } = await show({ onDismiss: { command: 'command:a.b/gone', args: { n: 1 } } })
    await act(async () => timers[0]!.fn())
    expect(titles()).toEqual([])
    expect(plugins.ran).toEqual([['command:a.b/gone', { n: 1 }]])
  })

  test('a persistent toast has no timer and stays', async () => {
    await show({ persistent: true })
    expect(timers).toEqual([])
    expect(titles()).toEqual(['Title'])
  })

  test('the close button dismisses and runs onDismiss once', async () => {
    const { plugins } = await show({ persistent: true, onDismiss: { command: 'command:a.b/gone' } })
    await click(button('Dismiss'))
    expect(titles()).toEqual([])
    expect(plugins.ran).toEqual([['command:a.b/gone', undefined]])
  })

  test('an action runs its command with args and dismisses without running onDismiss', async () => {
    const { plugins } = await show({
      persistent: true,
      actions: [{ label: 'Resend', command: 'command:a.b/resend', args: { child: 'c1' } }],
      onDismiss: { command: 'command:a.b/gone' }
    })
    await click(button('Resend'))
    expect(plugins.ran).toEqual([['command:a.b/resend', { child: 'c1' }]])
    expect(titles()).toEqual([])
  })

  test('a keepOpen action leaves the toast showing', async () => {
    const { plugins } = await show({ persistent: true, actions: [{ label: 'Peek', command: 'command:a.b/peek', keepOpen: true }] })
    await click(button('Peek'))
    expect(plugins.ran).toHaveLength(1)
    expect(titles()).toEqual(['Title'])
  })

  test('an action whose command fails shows the error toast and keeps the original', async () => {
    const plugins = fakePlugins()
    plugins.fail.add('command:a.b/resend')
    await show({ persistent: true, actions: [{ label: 'Resend', command: 'command:a.b/resend' }], onDismiss: { command: 'command:a.b/gone' } }, plugins)
    await click(button('Resend'))
    expect(titles()).toEqual(['Title', 'command:a.b/resend failed: kaboom'])
    expect(document.querySelectorAll('.toast-error')).toHaveLength(1)
    expect(plugins.ran).toEqual([['command:a.b/resend', undefined]])
  })

  test('a toast replaced by key does not run the replaced toast onDismiss', async () => {
    const { store, plugins } = await show({ key: 'k', persistent: true, onDismiss: { command: 'command:a.b/gone' } })
    await act(async () => store.dispatch(notify({ key: 'k', title: 'Replacement' })))
    expect(titles()).toEqual(['Replacement'])
    expect(plugins.ran).toEqual([])
  })

  test('an action that replaces its own toast by key leaves the replacement showing', async () => {
    const store = new Store()
    const plugins = fakePlugins()
    plugins.runCommandForResult = async () => void store.dispatch(notify({ key: 'k', title: 'Sent' }))
    await mount(store, plugins)
    await act(async () => store.dispatch(notify({ key: 'k', persistent: true, actions: [{ label: 'Send again', command: 'c' }], onDismiss: { command: 'gone' } })))
    await click(button('Send again'))
    expect(titles()).toEqual(['Sent'])
  })

  test('dismissing after an action already dismissed the toast runs no onDismiss', async () => {
    const { store, plugins } = await show({ key: 'k', actions: [{ label: 'Go', command: 'c' }], onDismiss: { command: 'gone' } })
    const id = store.getState().toasts[0]!.id
    await click(button('Go'))
    await act(async () => {
      component.dismissToast({ store, plugins }, id)
      component.dismissToastByKey({ store, plugins }, 'k')
    })
    expect(plugins.ran.map(([c]) => c)).toEqual(['c'])
  })

  test('dismissing the same toast twice runs onDismiss once', async () => {
    const { store, plugins } = await show({ key: 'j', persistent: true, onDismiss: { command: 'gone' } })
    const id = store.getState().toasts[0]!.id
    await act(async () => {
      component.dismissToastByKey({ store, plugins }, 'j')
      component.dismissToastByKey({ store, plugins }, 'j')
      component.dismissToast({ store, plugins }, id)
    })
    expect(plugins.ran.map(([c]) => c)).toEqual(['gone'])
  })

  test('dismissing by a key no toast has does nothing', async () => {
    const { store, plugins } = await show({ key: 'k', persistent: true })
    await act(async () => component.dismissToastByKey({ store, plugins }, 'other'))
    expect(titles()).toEqual(['Title'])
  })

  test('clicking a toast that opens a view opens it and dismisses', async () => {
    const { plugins } = await show({ open: { view: 'view:a.b/page', input: { n: 1 } } })
    await click(document.querySelector('.toast')!)
    expect(plugins.opened).toEqual([['view:a.b/page', { n: 1 }]])
    expect(titles()).toEqual([])
  })

  test('clicking a persistent toast that opens no view leaves it showing', async () => {
    await show({ persistent: true })
    await click(document.querySelector('.toast')!)
    expect(titles()).toEqual(['Title'])
  })
})
