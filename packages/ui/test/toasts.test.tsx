import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import type { Connection } from '../src/connection'
import { initialState, reduce, type AppState } from '../src/lib/state'
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
    const connection = {
      store,
      callAny: async () => [],
      onEvent: () => () => {},
      onConnected: () => () => {}
    }
    const shellPlugins = {
      ...plugins,
      getState: () => ({ layout: { view: null }, windowRoute: null }),
      subscribe: () => () => {},
      openTool: () => {}
    }
    const value = { store, connection: connection as unknown as Connection, plugins: shellPlugins as WindowPluginHost }
    await act(async () => {
      root!.render(react.createElement(context.AppContext.Provider, { value }, react.createElement(component.Toasts)))
    })
  }
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

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
    timers = timers.filter((timer) => timer.id !== id)
  }) as unknown as typeof clearTimeout
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
})

const notify = (extra: Record<string, unknown> = {}) =>
  ({ type: 'event', event: { type: 'notify', title: 'Title', body: 'Body', desktop: false, ...extra } }) as Parameters<typeof reduce>[1]

describe('toast state transitions', () => {
  test('a keyed toast replaces only its matching entry', () => {
    let state = reduce(initialState(), notify({ key: 'a', title: 'first' }))
    state = reduce(state, notify({ key: 'b', title: 'other' }))
    state = reduce(state, notify({ key: 'a', title: 'second' }))
    expect(state.toasts.map((toast) => [toast.key, toast.title, toast.id])).toEqual([
      ['a', 'second', 3],
      ['b', 'other', 2]
    ])
  })

  test('unkeyed toasts coexist and dismissing an absent toast preserves state identity', () => {
    let state = reduce(initialState(), notify())
    state = reduce(state, notify())
    expect(state.toasts).toHaveLength(2)
    const unchanged = reduce(state, { type: 'dismissToast', id: 99 })
    expect(unchanged).toBe(state)
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

const visibleToastText = () =>
  [...document.querySelectorAll('[role=\"status\"], [role=\"alert\"]')].map((element) => element.textContent ?? '')
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((element) => element.textContent === label || element.getAttribute('aria-label') === label) as HTMLElement
const click = (element: Element) => act(async () => void element.dispatchEvent(new MouseEvent('click', { bubbles: true })))

async function show(extra: Record<string, unknown> = {}, plugins = fakePlugins()) {
  const store = new Store()
  await mount(store, plugins)
  await act(async () => store.dispatch(notify(extra)))
  return { store, plugins }
}

describe('Toasts', () => {
  test('an eight-second timeout dismisses state and runs onDismiss once', async () => {
    const { store, plugins } = await show({ onDismiss: { command: 'command:a.b/gone', args: { n: 1 } } })
    expect(store.getState().toasts).toHaveLength(1)
    expect(visibleToastText().some((text) => text.includes('Title') && text.includes('Body'))).toBe(true)
    expect(timers.map((timer) => timer.ms)).toEqual([8000])

    await act(async () => timers[0]!.fn())
    expect(store.getState().toasts).toEqual([])
    expect(plugins.ran).toEqual([['command:a.b/gone', { n: 1 }]])
  })

  test('a persistent confirmation has no timeout and remains until dismissed', async () => {
    const { store } = await show({ persistent: true })
    expect(timers).toEqual([])
    expect(store.getState().toasts).toHaveLength(1)
    expect(visibleToastText().some((text) => text.includes('Title'))).toBe(true)
  })

  test('closing a persistent toast runs onDismiss once', async () => {
    const { store, plugins } = await show({ persistent: true, onDismiss: { command: 'command:a.b/gone' } })
    await click(button('Dismiss notification'))
    expect(store.getState().toasts).toEqual([])
    expect(plugins.ran).toEqual([['command:a.b/gone', undefined]])
  })

  test('a successful action dismisses without running onDismiss, while keepOpen preserves it', async () => {
    const first = await show({
      persistent: true,
      actions: [{ label: 'Resend', command: 'command:a.b/resend', args: { child: 'c1' } }],
      onDismiss: { command: 'command:a.b/gone' }
    })
    await click(button('Resend'))
    expect(first.plugins.ran).toEqual([['command:a.b/resend', { child: 'c1' }]])
    expect(first.store.getState().toasts).toEqual([])

    await act(async () => first.store.dispatch(notify({
      persistent: true,
      actions: [{ label: 'Peek', command: 'command:a.b/peek', keepOpen: true }]
    })))
    await click(button('Peek'))
    expect(first.plugins.ran.at(-1)).toEqual(['command:a.b/peek', undefined])
    expect(first.store.getState().toasts).toHaveLength(1)
  })

  test('an action failure retains its actionable toast and rearms its eight-second lifetime', async () => {
    const plugins = fakePlugins()
    plugins.fail.add('command:a.b/resend')
    const { store } = await show({
      actions: [{ label: 'Resend', command: 'command:a.b/resend' }],
      onDismiss: { command: 'command:a.b/gone' }
    }, plugins)
    await click(button('Resend'))
    expect(store.getState().toasts.map((toast) => toast.title)).toEqual([
      'Title', 'command:a.b/resend failed: kaboom'
    ])
    expect(visibleToastText().some((text) => text.includes('kaboom'))).toBe(true)
    expect(button('Resend')).toBeDefined()
    expect(timers.some((timer) => timer.ms === 8000)).toBe(true)
  })

  test('an in-flight action pauses expiration and a later failure leaves a fresh actionable lifetime', async () => {
    const plugins = fakePlugins()
    let releaseCommand: () => void = () => {}
    let commandStarted: () => void = () => {}
    const blocked = new Promise<void>((resolve) => { releaseCommand = resolve })
    const started = new Promise<void>((resolve) => { commandStarted = resolve })
    plugins.runCommandForResult = async (id, args) => {
      plugins.ran.push([id, args])
      commandStarted()
      await blocked
      throw new Error('late failure')
    }
    const { store } = await show({ actions: [{ label: 'Send', command: 'command:a.b/send' }] }, plugins)
    await click(button('Send'))
    await started
    expect(timers).toEqual([])

    let unsubscribe = () => {}
    const failed = new Promise<void>((resolve) => {
      unsubscribe = store.subscribe(() => {
        if (store.getState().toasts.some((toast) => toast.title === 'command:a.b/send failed: late failure')) {
          unsubscribe()
          resolve()
        }
      })
    })
    await act(async () => {
      releaseCommand()
      await failed
    })
    expect(store.getState().toasts.map((toast) => toast.title)).toContain('Title')
    expect(button('Send')).toBeDefined()
    expect(timers.some((timer) => timer.ms === 8000)).toBe(true)
  })

  test('a toast replaced by key does not run the replaced toast onDismiss', async () => {
    const { store, plugins } = await show({ key: 'k', persistent: true, onDismiss: { command: 'command:a.b/gone' } })
    await act(async () => store.dispatch(notify({ key: 'k', title: 'Replacement' })))
    expect(store.getState().toasts.map((toast) => toast.title)).toEqual(['Replacement'])
    expect(visibleToastText().some((text) => text.includes('Replacement'))).toBe(true)
    expect(plugins.ran).toEqual([])
  })

  test('an action that replaces its own toast by key leaves the replacement showing', async () => {
    const store = new Store()
    const plugins = fakePlugins()
    plugins.runCommandForResult = async () => void store.dispatch(notify({ key: 'k', title: 'Sent' }))
    await mount(store, plugins)
    await act(async () => store.dispatch(notify({ key: 'k', persistent: true, actions: [{ label: 'Send again', command: 'c' }], onDismiss: { command: 'gone' } })))
    await click(button('Send again'))
    expect(store.getState().toasts.map((toast) => toast.title)).toEqual(['Sent'])
    expect(visibleToastText().some((text) => text.includes('Sent'))).toBe(true)
  })

  test('dismissing after an action already dismissed the toast runs no onDismiss', async () => {
    const { store, plugins } = await show({ key: 'k', actions: [{ label: 'Go', command: 'c' }], onDismiss: { command: 'gone' } })
    const id = store.getState().toasts[0]!.id
    await click(button('Go'))
    await act(async () => {
      component.dismissToast({ store, plugins }, id)
      component.dismissToastByKey({ store, plugins }, 'k')
    })
    expect(plugins.ran.map(([command]) => command)).toEqual(['c'])
  })

  test('dismissing the same toast twice runs onDismiss once', async () => {
    const { store, plugins } = await show({ key: 'j', persistent: true, onDismiss: { command: 'gone' } })
    const id = store.getState().toasts[0]!.id
    await act(async () => {
      component.dismissToastByKey({ store, plugins }, 'j')
      component.dismissToastByKey({ store, plugins }, 'j')
      component.dismissToast({ store, plugins }, id)
    })
    expect(plugins.ran.map(([command]) => command)).toEqual(['gone'])
  })

  test('dismissing by an absent key leaves the toast actionable', async () => {
    const { store, plugins } = await show({ key: 'k', persistent: true })
    await act(async () => component.dismissToastByKey({ store, plugins }, 'other'))
    expect(store.getState().toasts).toHaveLength(1)
    expect(button('Dismiss notification')).toBeDefined()
  })

  test('opening a toast navigates through the host and then dismisses it', async () => {
    const { store, plugins } = await show({ open: { view: 'view:a.b/page', input: { n: 1 } } })
    const toast = document.querySelector('[role=\"status\"]')!
    await click(toast)
    expect(plugins.opened).toEqual([['view:a.b/page', { n: 1 }]])
    expect(store.getState().toasts).toEqual([])
  })

  test('clicking a persistent informational toast leaves it showing', async () => {
    const { store } = await show({ persistent: true })
    await click(document.querySelector('[role=\"status\"]')!)
    expect(store.getState().toasts).toHaveLength(1)
  })
})
