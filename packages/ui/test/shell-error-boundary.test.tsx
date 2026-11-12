import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h, useLayoutEffect } from 'react'
import type { ComponentType, Context, ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import type { App as AppExport } from '../src/App'
import { initialState, type AppState } from '../src/lib/state'
import type { AppContextValue } from '../src/context'
import { Store } from '../src/store'
import type { HostState, WindowPluginHost } from '../src/plugins/host'

type AppComponent = typeof AppExport
type ShellBoundaryComponent = ComponentType<{ children: ReactNode }>

type MountedRoot = { root: Root; container: HTMLDivElement }
type ContextFixture = {
  value: AppContextValue
  store: Store
  initialStoreState: AppState
  get dispatchCalls(): number
  get connectionStopCalls(): number
  get hostStopCalls(): number
}

const FALLBACK_MESSAGE = "This window couldn't render. Close and reopen the window. If it happens again, check the developer console."
const BOUNDARY_LOG_MARKER = 'Shell render failed'

let App: AppComponent
let AppContext: Context<AppContextValue | null>
let createRoot: (container: HTMLElement) => Root
let hadActEnvironment = false
let oldActEnvironment: unknown
const mountedRoots: MountedRoot[] = []

beforeAll(async () => {
  hadActEnvironment = Object.hasOwn(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  oldActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT
  GlobalRegistrator.register({ url: 'about:blank' })
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  // App's shell imports ReactDOM-dependent UI modules, so load it only after Happy DOM is active.
  const [client, app, context] = await Promise.all([
    import('react-dom/client'),
    import('../src/App'),
    import('../src/context')
  ])
  createRoot = client.createRoot
  App = app.App
  AppContext = context.AppContext
})
async function loadShellErrorBoundary(): Promise<ShellBoundaryComponent> {
  // Keep this import test-local so the real App missing-provider regression can run before the boundary exists.
  const boundary = await import('../src/components/ShellErrorBoundary')
  return boundary.ShellErrorBoundary
}

afterAll(async () => {
  try {
    await GlobalRegistrator.unregister()
  } finally {
    if (hadActEnvironment) {
      ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT = oldActEnvironment
    } else {
      Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    }
  }
})

afterEach(async () => {
  try {
    for (const mounted of [...mountedRoots].reverse()) {
      await act(async () => mounted.root.unmount())
    }
  } finally {
    mountedRoots.length = 0
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.cssText = ''
  }
})

function mountRoot(): MountedRoot {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const mounted = { root: createRoot(container), container }
  mountedRoots.push(mounted)
  return mounted
}

async function unmountRoot(mounted: MountedRoot): Promise<void> {
  await act(async () => mounted.root.unmount())
  const index = mountedRoots.indexOf(mounted)
  if (index !== -1) mountedRoots.splice(index, 1)
  mounted.container.remove()
}

async function captureConsoleErrors(run: (calls: unknown[][]) => Promise<void>): Promise<unknown[][]> {
  const original = console.error
  const calls: unknown[][] = []
  console.error = ((...args: unknown[]) => calls.push(args)) as typeof console.error
  try {
    await run(calls)
    return calls
  } finally {
    console.error = original
  }
}

function expectOneBoundaryReport(calls: unknown[][], error: Error): void {
  // React's development diagnostic is not the boundary report: count only the explicit marker,
  // original error object, and component-stack argument emitted by componentDidCatch.
  const reports = calls.filter((args) => args[0] === BOUNDARY_LOG_MARKER && args[1] === error)
  expect(reports).toHaveLength(1)
  const componentStack = reports[0]?.[2]
  expect(typeof componentStack).toBe('string')
  expect(componentStack as string).toMatch(/(?:^|\n)\s*at\s+\S+/)
}

function expectFallback(container: HTMLElement, rawError: string): void {
  const alerts = container.querySelectorAll('[role="alert"]')
  expect(alerts).toHaveLength(1)
  const alert = alerts[0]!
  expect(alert.getAttribute('aria-label')).toBe('Window error')
  expect(alert.textContent).toBe(FALLBACK_MESSAGE)
  expect(container.querySelectorAll('button, [role="button"]')).toHaveLength(0)
  expect(container.textContent).not.toContain(rawError)
  expect(container.textContent).not.toMatch(/(?:^|\n)\s*at\s+\S+/)
}

function createContextFixture(connectionStatus: AppState['connection'], hostError?: Error): ContextFixture {
  const store = new Store({ ...initialState(), connection: connectionStatus })
  const initialStoreState = store.getState()
  let dispatchCalls = 0
  let connectionStopCalls = 0
  let hostStopCalls = 0
  const hostState = {
    model: null,
    layout: {},
    windowRoute: null,
    themeVariables: {}
  } as HostState
  const plugins = {
    getState: () => {
      if (hostError) throw hostError
      return hostState
    },
    subscribe: (_listener: () => void) => () => {},
    handleKey: () => false,
    setPalette: () => {},
    stop: () => { hostStopCalls += 1 }
  } as unknown as WindowPluginHost
  const value = {
    store: {
      getState: store.getState,
      subscribe: store.subscribe,
      dispatch: (...args: Parameters<Store['dispatch']>) => {
        dispatchCalls += 1
        store.dispatch(...args)
      }
    } as Store,
    connection: { stop: () => { connectionStopCalls += 1 } },
    plugins
  } as unknown as AppContextValue

  return {
    value,
    store,
    initialStoreState,
    get dispatchCalls() { return dispatchCalls },
    get connectionStopCalls() { return connectionStopCalls },
    get hostStopCalls() { return hostStopCalls }
  }
}

function installReloadSpy(): { readonly calls: number; restore(): void } {
  const location = window.location
  const previous = Object.getOwnPropertyDescriptor(location, 'reload')
  let calls = 0
  Object.defineProperty(location, 'reload', {
    configurable: true,
    enumerable: previous?.enumerable ?? false,
    writable: true,
    value: () => { calls += 1 }
  })
  return {
    get calls() { return calls },
    restore() {
      if (previous) Object.defineProperty(location, 'reload', previous)
      else Reflect.deleteProperty(location, 'reload')
    }
  }
}


test('contains the real App missing-provider error in both themes and keeps its fallback sticky', async () => {
  const mounted = mountRoot()
  const calls = await captureConsoleErrors(async (errors) => {
    for (const theme of ['light', 'dark']) {
      document.documentElement.dataset.theme = theme
      await act(async () => mounted.root.render(h(App)))
      expect(document.documentElement.dataset.theme).toBe(theme)
      expectFallback(mounted.container, 'AppContext is missing')
    }

    const reports = errors.filter((args) => args[0] === BOUNDARY_LOG_MARKER)
    expect(reports).toHaveLength(1)
    const error = reports[0]?.[1]
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('AppContext is missing')
    expectOneBoundaryReport(errors, error as Error)
  })

  expect(calls.filter((args) => args[0] === BOUNDARY_LOG_MARKER)).toHaveLength(1)
})

test('contains an update-render failure without retrying the failed child', async () => {
  const mounted = mountRoot()
  const ShellErrorBoundary = await loadShellErrorBoundary()
  const failure = new Error('private update diagnostic')
  let childRenders = 0
  function UpdateFailure({ broken }: { broken: boolean }) {
    childRenders += 1
    if (broken) throw failure
    return h('p', null, 'Updated healthy child')
  }

  const calls = await captureConsoleErrors(async (errors) => {
    await act(async () => mounted.root.render(h(ShellErrorBoundary, null, h(UpdateFailure, { broken: false }))))
    expect(mounted.container.textContent).toBe('Updated healthy child')

    await act(async () => mounted.root.render(h(ShellErrorBoundary, null, h(UpdateFailure, { broken: true }))))
    expectFallback(mounted.container, failure.message)
    expectOneBoundaryReport(errors, failure)
    const failedRenders = childRenders

    await act(async () => mounted.root.render(h(ShellErrorBoundary, null, h(UpdateFailure, { broken: false }))))
    expectFallback(mounted.container, failure.message)
    expect(childRenders).toBe(failedRenders)
    expectOneBoundaryReport(errors, failure)
  })

  expect(calls.filter((args) => args[0] === BOUNDARY_LOG_MARKER)).toHaveLength(1)
})

test('contains descendant layout-effect failures and logs their component stack once', async () => {
  const mounted = mountRoot()
  const ShellErrorBoundary = await loadShellErrorBoundary()
  const failure = new Error('private layout-effect diagnostic')
  let effectRuns = 0
  function LayoutEffectFailure() {
    useLayoutEffect(() => {
      effectRuns += 1
      throw failure
    }, [])
    return h('p', null, 'This child fails after commit')
  }

  const calls = await captureConsoleErrors(async (errors) => {
    await act(async () => mounted.root.render(h(ShellErrorBoundary, null, h(LayoutEffectFailure))))
    expectFallback(mounted.container, failure.message)
    expect(effectRuns).toBe(1)
    expectOneBoundaryReport(errors, failure)
  })

  expect(calls.filter((args) => args[0] === BOUNDARY_LOG_MARKER)).toHaveLength(1)
})

test('keeps healthy children and a normal no-token App isolated from another root failure', async () => {
  const hostFailure = new Error('private host diagnostic')
  const failing = createContextFixture('connecting', hostFailure)
  const noToken = createContextFixture('no-token')
  const ShellErrorBoundary = await loadShellErrorBoundary()
  const healthyBoundary = mountRoot()
  const failedApp = mountRoot()
  const noTokenApp = mountRoot()
  const reload = installReloadSpy()

  try {
    const calls = await captureConsoleErrors(async (errors) => {
      await act(async () => healthyBoundary.root.render(h(ShellErrorBoundary, null, h('p', null, 'Healthy boundary child'))))
      expect(healthyBoundary.container.textContent).toBe('Healthy boundary child')
      expect(healthyBoundary.container.querySelector('[role="alert"]')).toBeNull()

      await act(async () => failedApp.root.render(h(AppContext.Provider, { value: failing.value }, h(App))))
      expectFallback(failedApp.container, 'private host diagnostic')
      expectOneBoundaryReport(errors, hostFailure)

      await act(async () => noTokenApp.root.render(h(AppContext.Provider, { value: noToken.value }, h(App))))
      expect(noTokenApp.container.querySelector('[role="alert"]')).toBeNull()
      expect(noTokenApp.container.querySelector('h1')?.textContent).toBe('Not connected')
      expect(noTokenApp.container.querySelector('p')?.textContent).toContain('This page needs an access token.')
      expect(noTokenApp.container.querySelector('code')?.textContent).toBe('#token=…')
      expect(noTokenApp.container.querySelectorAll('button, [role="button"]')).toHaveLength(0)
      expectFallback(failedApp.container, 'private host diagnostic')

      expectOneBoundaryReport(errors, hostFailure)
    })

    expect(calls.filter((args) => args[0] === BOUNDARY_LOG_MARKER)).toHaveLength(1)
    await unmountRoot(failedApp)
    await unmountRoot(noTokenApp)
    await unmountRoot(healthyBoundary)

    for (const fixture of [failing, noToken]) {
      expect(fixture.store.getState()).toBe(fixture.initialStoreState)
      expect(fixture.dispatchCalls).toBe(0)
      expect(fixture.connectionStopCalls).toBe(0)
      expect(fixture.hostStopCalls).toBe(0)
    }
    expect(reload.calls).toBe(0)
  } finally {
    reload.restore()
  }
})
