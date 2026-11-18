import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h, type ComponentType, type Context, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import type { AppContextValue } from '../src/context'
import type { Store as StoreInstance } from '../src/store'
import type { DesktopShellBridge, DesktopWindowSummary, FolderListing, Methods, QuirkyEvent } from '@quirky/protocol'
import { createBrowserHost, type BrowserHostCall, type BrowserHostController } from '../src/browser-host'
import { answerDesktopShellRequest } from '../src/shell'
import { WindowPluginHost } from '../src/plugins/host'

let createRoot: (container: HTMLElement) => Root
let FolderDialog: ComponentType<{ controller: BrowserHostController | null }>
let App: ComponentType<{ browserHost?: BrowserHostController | null }>
let AppContext: Context<AppContextValue | null>
let Store: new () => StoreInstance
let container: HTMLDivElement | null = null
let root: Root | null = null

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'about:blank' })
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const [client, dialog, app, context, store] = await Promise.all([
    import('react-dom/client'),
    import('../src/browser-host/FolderDialog'),
    import('../src/App'),
    import('../src/context'),
    import('../src/store')
  ])
  createRoot = client.createRoot
  FolderDialog = dialog.FolderDialog
  App = app.App
  AppContext = context.AppContext
  Store = store.Store
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function mount(node: ReactNode): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(node))
  return container
}

type ControlParams = Methods['ui.browserHost.control']['params']
type Rpc = BrowserHostCall

function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

function settle(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve())
}

function listing(path: string, entries: FolderListing['entries'] = [], extra: Partial<FolderListing> = {}): FolderListing {
  return {
    path,
    parent: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
    entries,
    offset: 0,
    limit: 100,
    hasMore: false,
    ...extra
  }
}

function popup() {
  return {
    closed: false,
    closeCount: 0,
    location: {
      href: 'about:blank',
      replace(url: string) { this.href = url }
    },
    close() {
      this.closeCount += 1
      this.closed = true
    },
    focus() {}
  }
}

function summary(windowId: string, ownerShell: DesktopWindowSummary['ownerShell'] = { connId: 17, name: 'quirky-ui' }): DesktopWindowSummary {
  return { windowId, view: 'view:quirky.agent-status/dashboard', ownerShell, attached: false }
}

type HarnessOptions = {
  list?: (params: Record<string, unknown>) => Promise<unknown> | unknown
  openResults?: Array<ReturnType<typeof popup> | null>
  currentUrl?: string
  connId?: number
  focusOwner?: () => Promise<boolean> | boolean
}

function harness(options: HarnessOptions = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const opens: Array<{ url: string; target: string }> = []
  const handles: Array<ReturnType<typeof popup>> = []
  let routes: DesktopWindowSummary[] = []
  let clock = 0
  let timerId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let hook: ((method: string, params: Record<string, unknown>, fallback: () => Promise<unknown>) => Promise<unknown> | undefined) | undefined
  const rpc: Rpc = async (method, params) => {
    calls.push({ method, params })
    const fallback = async (): Promise<unknown> => {
      if (method === 'ui.window.self') return { connId: options.connId ?? 17 }
      if (method === 'ui.folder.list') {
        return options.list?.(params) ?? listing(String(params.path ?? '/daemon-home'), [], {
          offset: Number(params.offset ?? 0),
          limit: Number(params.limit ?? 100)
        })
      }
      if (method === 'desktop.window.list') return routes
      if (method === 'desktop.window.close') {
        const windowId = String(params.windowId)
        routes = routes.filter((route) => route.windowId !== windowId)
        return { closed: true }
      }
      return {}
    }
    const result = hook?.(method, params, fallback)
    return result === undefined ? fallback() : result
  }
  const controller: BrowserHostController = createBrowserHost({
    openWindow(url, target) {
      opens.push({ url, target })
      const result = options.openResults?.shift() ?? null
      if (result) handles.push(result)
      return result
    },
    currentUrl: () => options.currentUrl ?? 'http://127.0.0.1:6768/#token=local',
    randomUUID: () => `00000000-0000-4000-8000-${String(handles.length + 1).padStart(12, '0')}`,
    now: () => clock,
    setTimer(callback, delay) {
      const id = ++timerId
      timers.set(id, { at: clock + delay, callback })
      return id
    },
    clearTimer(id) {
      timers.delete(id as number)
    },
    focusOwner: options.focusOwner
  })
  return {
    controller,
    calls,
    opens,
    handles,
    rpc,
    get routes() { return routes },
    setRoutes(value: DesktopWindowSummary[]) { routes = value },
    setHook(value: typeof hook) { hook = value },
    advance(ms: number) {
      clock += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > clock) continue
        timers.delete(id)
        timer.callback()
      }
    }
  }
}

function folderEvent(requestId: string, request: { title?: string; startingFolder?: string; multiple?: boolean } = {}, connId = 17) {
  return {
    type: 'desktop.shell.request' as const,
    requestId,
    action: { kind: 'folder-picker' as const, request },
    ownerShell: { connId }
  }
}

function windowEvent(requestId: string, request: { view: string; input?: unknown; title?: string } = {
  view: 'view:quirky.agent-status/dashboard'
}, connId = 17) {
  return {
    type: 'desktop.shell.request' as const,
    requestId,
    action: { kind: 'window-open' as const, request },
    ownerShell: { connId, name: 'quirky-ui' }
  }
}

function control(
  host: ReturnType<typeof harness>,
  action: ControlParams['action'],
  requestId: string | undefined,
  extra: Partial<Pick<ControlParams, 'path' | 'selected' | 'offset'>> = {},
  connId = 17
) {
  return host.controller.control({
    connId,
    action,
    ...(requestId === undefined ? {} : { requestId }),
    ...extra
  }, host.rpc)
}

test('cancelling a folder picker invalidates its in-flight listing before it can publish', async () => {
  const listingRead = deferred<unknown>()
  const host = harness({ list: () => listingRead.promise })
  const result = host.controller.handleShellRequest(folderEvent('folder-request-1', {
    title: 'Choose project',
    startingFolder: '/fixture/root'
  }), host.rpc)

  await settle()
  expect(host.controller.getSnapshot()).toMatchObject({
    requestId: 'folder-request-1',
    kind: 'folder-picker',
    title: 'Choose project',
    draftPath: '/fixture/root',
    busy: true
  })

  await control(host, 'cancel', 'folder-request-1')
  await expect(result).resolves.toEqual({ cancelled: true, paths: [] })
  listingRead.resolve(listing('/fixture/root'))
  await settle()
  expect(host.controller.getSnapshot()).toBeNull()
  expect(host.opens).toHaveLength(0)
})

test('folder errors clear stale selection, name failures, and a valid retry can confirm one canonical folder', async () => {
  const host = harness({
    list: (params) => {
      const path = String(params.path ?? '/root')
      if (path === '') throw new Error('InvalidParams: path must not be empty')
      if (path === '/missing') throw new Error('NotFound: directory does not exist')
      if (path === 'relative') throw new Error('InvalidParams: path must be absolute')
      if (path.includes('\0')) throw new Error('InvalidParams: path must not contain NUL')
      if (path === '/locked') throw new Error('Conflict: permission denied')
      if (path === '/not-directory') throw new Error('InvalidParams: path is not a directory')
      if (path === '/root') return listing(path, [{ name: 'project', path: '/root/project' }])
      return listing(path)
    }
  })
  const result = host.controller.handleShellRequest(folderEvent('folder-errors', { startingFolder: '/root' }), host.rpc)
  await settle()
  await control(host, 'select', 'folder-errors', { path: '/root/project', selected: true })
  expect(host.controller.getSnapshot()?.selectedPaths).toEqual(['/root/project'])

  for (const [path, message] of [
    ['/missing', 'NotFound'],
    ['', 'empty'],
    ['/not-directory', 'not a directory'],
    ['relative', 'InvalidParams'],
    ['/bad\0path', 'NUL'],
    ['/locked', 'permission denied']
  ] as const) {
    await control(host, 'set-path', 'folder-errors', { path })
    await control(host, 'navigate', 'folder-errors', { path })
    expect(host.controller.getSnapshot()?.error).toContain(message)
    expect(host.controller.getSnapshot()?.selectedPaths).toEqual([])
    await expect(control(host, 'select', 'folder-errors', { path: '/root/project', selected: true })).rejects.toThrow()
  }

  await control(host, 'set-path', 'folder-errors', { path: '/root/project' })
  await control(host, 'navigate', 'folder-errors', { path: '/root/project' })
  expect(host.controller.getSnapshot()).toMatchObject({
    draftPath: '/root/project',
    directory: { path: '/root/project', entries: [] },
    error: null
  })
  await expect(control(host, 'confirm', 'folder-errors')).rejects.toThrow(/folder/i)
  await control(host, 'select', 'folder-errors', { path: '/root/project', selected: true })
  await control(host, 'confirm', 'folder-errors')
  await expect(result).resolves.toEqual({ cancelled: false, paths: ['/root/project'] })
  expect(host.controller.getSnapshot()).toBeNull()
})

test('pagination stays explicit and invalid offsets are rejected instead of clamped', async () => {
  const host = harness({
    list: (params) => {
      const offset = Number(params.offset ?? 0)
      return listing('/root', [{ name: `dir-${offset}`, path: `/root/dir-${offset}` }], {
        offset,
        limit: Number(params.limit ?? 100),
        hasMore: offset === 0
      })
    }
  })
  const result = host.controller.handleShellRequest(folderEvent('folder-pages', { startingFolder: '/root' }), host.rpc)
  await settle()
  expect(host.controller.getSnapshot()?.directory).toMatchObject({ offset: 0, limit: 100, hasMore: true })
  await control(host, 'navigate', 'folder-pages', { path: '/root', offset: 100 })
  expect(host.controller.getSnapshot()?.directory).toMatchObject({ offset: 100, limit: 100, hasMore: false })
  expect(host.calls.findLast((call) => call.method === 'ui.folder.list')?.params).toEqual({
    path: '/root', offset: 100, limit: 100
  })
  await expect(control(host, 'navigate', 'folder-pages', { path: '/root', offset: -1 })).rejects.toThrow(/offset|InvalidParams/i)
  expect(host.calls.filter((call) => call.method === 'ui.folder.list')).toHaveLength(2)
  await control(host, 'cancel', 'folder-pages')
  await result
})

test('multiple selection is ordered, explicit, deduplicated and revalidated to canonical paths', async () => {
  const host = harness({
    list: (params) => {
      const path = String(params.path ?? '/root')
      if (path === '/root') return listing('/root', [
        { name: 'alias', path: '/root/alias' },
        { name: 'alpha', path: '/root/alpha' },
        { name: 'beta', path: '/root/beta' }
      ])
      if (path === '/root/alias') return listing('/root/alpha')
      return listing(path)
    }
  })
  const result = host.controller.handleShellRequest(folderEvent('folder-multiple', {
    startingFolder: '/root',
    multiple: true
  }), host.rpc)
  await settle()
  await control(host, 'select', 'folder-multiple', { path: '/root/alias', selected: true })
  await control(host, 'select', 'folder-multiple', { path: '/root/alpha', selected: true })
  await control(host, 'select', 'folder-multiple', { path: '/root/alias', selected: true })
  await control(host, 'select', 'folder-multiple', { path: '/root/beta', selected: true })
  await control(host, 'select', 'folder-multiple', { path: '/root/alpha', selected: false })
  await control(host, 'select', 'folder-multiple', { path: '/root/alpha', selected: true })
  expect(host.controller.getSnapshot()?.selectedPaths).toEqual(['/root/alias', '/root/beta', '/root/alpha'])
  await control(host, 'navigate', 'folder-multiple', { path: '/other' })
  expect(host.controller.getSnapshot()?.selectedPaths).toEqual(['/root/alias', '/root/beta', '/root/alpha'])
  await control(host, 'select', 'folder-multiple', { path: '/root/alias', selected: false })
  expect(host.controller.getSnapshot()?.selectedPaths).toEqual(['/root/beta', '/root/alpha'])
  await control(host, 'navigate', 'folder-multiple', { path: '/root' })
  await control(host, 'select', 'folder-multiple', { path: '/root/alias', selected: true })
  expect(host.controller.getSnapshot()?.selectedPaths).toEqual(['/root/beta', '/root/alpha', '/root/alias'])

  await control(host, 'confirm', 'folder-multiple')
  await expect(result).resolves.toEqual({ cancelled: false, paths: ['/root/beta', '/root/alpha'] })

})
test('confirmation refuses a selected directory that disappeared and supports removing it after recovery', async () => {
  let goneReads = 0
  const host = harness({
    list: (params) => {
      const path = String(params.path ?? '/root')
      if (path === '/root') return listing('/root', [
        { name: 'alpha', path: '/root/alpha' },
        { name: 'gone', path: '/root/gone' }
      ])
      if (path === '/root/gone' && goneReads++ === 0) throw new Error('NotFound: selected directory disappeared')
      return listing(path)
    }
  })
  const result = host.controller.handleShellRequest(folderEvent('missing-selection', {
    startingFolder: '/root',
    multiple: true
  }), host.rpc)
  await settle()
  await control(host, 'select', 'missing-selection', { path: '/root/alpha', selected: true })
  await control(host, 'select', 'missing-selection', { path: '/root/gone', selected: true })
  await control(host, 'confirm', 'missing-selection')
  expect(host.controller.getSnapshot()?.error).toContain('NotFound')
  expect(host.controller.getSnapshot()?.selectedPaths).toEqual(['/root/alpha', '/root/gone'])

  await control(host, 'navigate', 'missing-selection', { path: '/root' })
  await control(host, 'select', 'missing-selection', { path: '/root/gone', selected: false })
  await control(host, 'confirm', 'missing-selection')
  await expect(result).resolves.toEqual({ cancelled: false, paths: ['/root/alpha'] })
})


test('late confirmation reads cannot settle a cancelled request or overwrite its successor', async () => {
  const confirmRead = deferred<unknown>()
  let delayConfirm = false
  const host = harness({
    list: (params) => {
      if (delayConfirm && params.path === '/root/alpha') return confirmRead.promise
      const path = String(params.path ?? '/root')
      if (path === '/root') return listing('/root', [{ name: 'alpha', path: '/root/alpha' }])
      return listing(path)
    }
  })
  const first = host.controller.handleShellRequest(folderEvent('first-picker', { startingFolder: '/root' }), host.rpc)
  await settle()
  await control(host, 'select', 'first-picker', { path: '/root/alpha', selected: true })
  delayConfirm = true
  const confirm = control(host, 'confirm', 'first-picker')
  await expect(control(host, 'confirm', 'first-picker')).rejects.toThrow(/working/)
  await settle()
  await control(host, 'cancel', 'first-picker')
  await expect(first).resolves.toEqual({ cancelled: true, paths: [] })
  const second = host.controller.handleShellRequest(folderEvent('second-picker', { startingFolder: '/second' }), host.rpc)
  await settle()
  confirmRead.resolve(listing('/root/alpha'))
  await expect(confirm).rejects.toThrow(/no longer active/)
  await settle()
  expect(host.controller.getSnapshot()).toMatchObject({ requestId: 'second-picker', draftPath: '/second' })
  await control(host, 'cancel', 'second-picker')
  await second
})

test('controller instances are isolated, stale identities refuse, and each picker expires at its fixed 25-second lease', async () => {
  const left = harness({ connId: 17 })
  const right = harness({ connId: 29 })
  const leftResult = left.controller.handleShellRequest(folderEvent('left-request', { startingFolder: '/left' }, 17), left.rpc)
  const rightResult = right.controller.handleShellRequest(folderEvent('right-request', { startingFolder: '/right' }, 29), right.rpc)
  await settle()
  expect(left.controller.getSnapshot()?.requestId).toBe('left-request')
  expect(right.controller.getSnapshot()?.requestId).toBe('right-request')
  await expect(left.controller.handleShellRequest(folderEvent('second-left'), left.rpc)).rejects.toThrow('another browser host request is already open')
  await expect(control(left, 'cancel', 'stale-request')).rejects.toThrow()
  await expect(control(left, 'cancel', 'left-request', {}, 29)).rejects.toThrow()

  left.advance(24_999)
  expect(left.controller.getSnapshot()?.requestId).toBe('left-request')
  left.advance(1)
  await expect(leftResult).resolves.toEqual({ cancelled: true, paths: [] })
  expect(left.controller.getSnapshot()).toBeNull()
  expect(right.controller.getSnapshot()?.requestId).toBe('right-request')
  right.advance(25_000)
  await expect(rightResult).resolves.toEqual({ cancelled: true, paths: [] })
})

test('scripted popup retries remain pending when the browser blocks and stale cancellation forbids later opens', async () => {
  const host = harness({ openResults: [null, null, null] })
  const result = host.controller.handleShellRequest(windowEvent('open-popup'), host.rpc)
  expect(host.controller.getSnapshot()).toMatchObject({
    requestId: 'open-popup',
    kind: 'window-open',
    title: 'Open tab',
    error: expect.stringMatching(/blocked/i)
  })
  await host.controller.controlRouted({ action: 'open-popup', requestId: 'open-popup' }, host.rpc)
  await host.controller.controlRouted({ action: 'open-popup', requestId: 'open-popup' }, host.rpc)
  expect(host.opens).toHaveLength(3)
  expect(host.handles).toHaveLength(0)
  expect(host.controller.getSnapshot()?.error).toMatch(/blocked/i)

  await control(host, 'cancel', 'open-popup')
  await expect(result).rejects.toThrow('browser tab opening cancelled')
  await expect(control(host, 'open-popup', 'open-popup')).rejects.toThrow()
  expect(host.opens).toHaveLength(3)
})

test('an expired popup prompt disappears and late retry controls cannot create a tab', async () => {
  const expired = harness({ openResults: [null] })
  const expiredRequest = expired.controller.handleShellRequest(windowEvent('expired-open'), expired.rpc)
  expired.advance(25_000)
  await expect(expiredRequest).rejects.toThrow('browser tab opening expired')
  expect(expired.controller.getSnapshot()).toBeNull()
  await expect(control(expired, 'open-popup', 'expired-open')).rejects.toThrow()
  expect(expired.opens).toHaveLength(1)
  expect(expired.handles).toHaveLength(0)
})

test('expired popup retries are inert and duplicate retry controls create at most one real child', async () => {
  const child = popup()
  const expired = harness({ openResults: [null] })
  const expiredRequest = expired.controller.handleShellRequest(windowEvent('expired-open'), expired.rpc)
  expired.advance(25_000)
  await expect(expiredRequest).rejects.toThrow('browser tab opening expired')
  expect(expired.controller.getSnapshot()).toBeNull()
  await expect(control(expired, 'open-popup', 'expired-open')).rejects.toThrow()
  expect(expired.opens).toHaveLength(1)

  const duplicate = harness({ openResults: [null, child] })
  const opened = duplicate.controller.handleShellRequest(windowEvent('duplicate-open'), duplicate.rpc)
  const firstClick = control(duplicate, 'open-popup', 'duplicate-open')
  const secondClick = control(duplicate, 'open-popup', 'duplicate-open')
  expect(duplicate.opens).toHaveLength(2)
  await Promise.all([firstClick, secondClick])
  const result = await opened as { windowId: string }
  expect(duplicate.handles).toHaveLength(1)
  expect(result.windowId).toMatch(/^[0-9a-f-]{36}$/i)
  await duplicate.controller.discardWindowOpen(result.windowId, duplicate.rpc, false)
})

test('a browser open remains blank until reply acknowledgement and exact route verification', async () => {
  const child = popup()
  const host = harness({
    openResults: [child],
    currentUrl: 'http://127.0.0.1:6768/ui?keep=a%20b&quirkyWindowId=old&quirkyWindowId=older&quirkyOwnerShellConnId=2&quirkyOwnerShellName=old&quirkyView=old&quirkyInput=old&quirkyTitle=old#token=secret'
  })
  let blankAtReply = false
  let blankAtList = false
  host.setHook(async (method, params, fallback) => {
    if (method === 'desktop.shell.reply') {
      blankAtReply = child.location.href === 'about:blank'
      const result = params.result as { windowId: string }
      host.setRoutes([summary(result.windowId, { connId: 17, name: 'quirky-ui' })])
      return {}
    }
    if (method === 'desktop.window.list') {
      blankAtList = child.location.href === 'about:blank'
      return fallback()
    }
    return undefined
  })
  const event = windowEvent('routed-open', {
    view: 'view:quirky.agent-status/dashboard',
    input: { nested: ['quote\"', '#/% & Ω'], flags: { ready: true } },
    title: 'Review & plan'
  })
  const connection = { callAny: host.rpc } as never
  await answerDesktopShellRequest(connection, null, event, () => {}, host.controller)
  expect(blankAtReply).toBe(true)
  expect(blankAtList).toBe(true)
  expect(host.calls.map((call) => call.method).filter((method) => ['desktop.shell.reply', 'desktop.window.list'].includes(method)))
    .toEqual(['desktop.shell.reply', 'desktop.window.list'])
  const routed = new URL(child.location.href)
  expect(routed.origin).toBe('http://127.0.0.1:6768')
  expect(routed.pathname).toBe('/ui')
  expect(routed.hash).toBe('#token=secret')
  expect(routed.searchParams.get('keep')).toBe('a b')
  expect(routed.searchParams.getAll('quirkyWindowId')).toEqual([host.routes[0]!.windowId])
  expect(routed.searchParams.getAll('quirkyOwnerShellConnId')).toEqual(['17'])
  expect(routed.searchParams.getAll('quirkyOwnerShellName')).toEqual(['quirky-ui'])
  expect(routed.searchParams.getAll('quirkyView')).toEqual(['view:quirky.agent-status/dashboard'])
  expect(JSON.parse(routed.searchParams.get('quirkyInput')!)).toEqual(event.action.request.input)
  expect(routed.searchParams.get('quirkyTitle')).toBe('Review & plan')
})

test('ignored replies, closed children, and disconnect during route verification never navigate and clean registered routes', async () => {
  const ignoredChild = popup()
  const ignored = harness({ openResults: [ignoredChild] })
  ignored.setHook(async (method, _params, fallback) => method === 'desktop.shell.reply' ? {} : fallback())
  await answerDesktopShellRequest({ callAny: ignored.rpc } as never, null, windowEvent('ignored'), () => {}, ignored.controller)
  expect(ignoredChild.location.href).toBe('about:blank')
  expect(ignoredChild.closed).toBe(true)
  expect(ignored.calls.some((call) => call.method === 'desktop.window.close')).toBe(false)

  const closedChild = popup()
  const closed = harness({ openResults: [closedChild] })
  closed.setHook(async (method, params, fallback) => {
    if (method === 'desktop.shell.reply') {
      const result = params.result as { windowId: string }
      closed.setRoutes([summary(result.windowId)])
      closedChild.closed = true
      return {}
    }
    return fallback()
  })
  await answerDesktopShellRequest({ callAny: closed.rpc } as never, null, windowEvent('closed-before-commit'), () => {}, closed.controller)
  expect(closedChild.location.href).toBe('about:blank')
  expect(closed.calls.some((call) => call.method === 'desktop.window.close')).toBe(true)
  expect(closed.routes).toEqual([])

  const disconnectChild = popup()
  const disconnect = harness({ openResults: [disconnectChild] })
  const listResponse = deferred<unknown>()
  const listingStarted = deferred<void>()
  disconnect.setHook(async (method, params, fallback) => {
    if (method === 'desktop.shell.reply') {
      const result = params.result as { windowId: string }
      disconnect.setRoutes([summary(result.windowId)])
      return {}
    }
    if (method === 'desktop.window.list') {
      listingStarted.resolve()
      return listResponse.promise
    }
    return fallback()
  })
  const answer = answerDesktopShellRequest({ callAny: disconnect.rpc } as never, null, windowEvent('disconnect-during-verify'), () => {}, disconnect.controller)
  await listingStarted.promise
  expect(disconnect.calls.some((call) => call.method === 'desktop.window.list')).toBe(true)
  disconnect.controller.disconnect()
  listResponse.resolve(disconnect.routes)
  await answer
  expect(disconnectChild.location.href).toBe('about:blank')
  expect(disconnect.calls.some((call) => call.method === 'desktop.window.close')).toBe(true)
  expect(disconnect.routes).toEqual([])
})

test('failed acknowledgement removes any registered route, while unregistered replies only discard the blank handle', async () => {
  const child = popup()
  const host = harness({ openResults: [child] })
  host.setHook(async (method, params, fallback) => {
    if (method === 'desktop.shell.reply') {
      const result = params.result as { windowId: string }
      host.setRoutes([summary(result.windowId)])
      throw new Error('reply acknowledgement failed')
    }
    return fallback()
  })
  await answerDesktopShellRequest({ callAny: host.rpc } as never, null, windowEvent('failed-ack'), () => {}, host.controller)
  expect(child.location.href).toBe('about:blank')
  expect(child.closed).toBe(true)
  expect(host.calls.some((call) => call.method === 'desktop.window.close')).toBe(true)
  expect(host.routes).toEqual([])
})

test('browser host refuses native-only reveal and reports focus only when the owner actually receives focus', async () => {
  const host = harness({ focusOwner: () => false })
  const capabilities = host.controller.capabilities
  expect(capabilities).toEqual({
    directoryPicker: true,
    auxiliaryWindows: true,
    revealItem: false,
    notifications: { permission: false, click: false, dismiss: false }
  })
  await expect(host.controller.handleShellRequest({
    type: 'desktop.shell.request',
    requestId: 'reveal',
    action: { kind: 'reveal-item', request: { path: '/root/file' } },
    ownerShell: { connId: 17 }
  }, host.rpc)).rejects.toThrow(/reveal/i)
  const auxiliary = harness({ focusOwner: () => false })
  const controller = createBrowserHost({
    openWindow: () => null,
    currentUrl: () => 'http://127.0.0.1:6768/?quirkyWindowId=child&quirkyOwnerShellConnId=17&quirkyView=view%3Ax',
    windowRoute: { windowId: 'child', ownerShellConnId: 17, view: 'view:x', attached: true },
    focusOwner: () => false
  })
  await expect(controller.handleShellRequest({
    type: 'desktop.shell.request',
    requestId: 'focus',
    action: { kind: 'window-activate-owner', request: { windowId: 'child' } },
    ownerShell: { connId: 17 }
  }, auxiliary.rpc)).rejects.toThrow(/focus/i)
  expect(auxiliary.calls).toEqual([])
})

test('native bridge retains precedence over an explicitly supplied browser host', async () => {
  const host = harness()
  let nativeCalls = 0
  const bridge = {
    capabilities: {
      directoryPicker: true,
      auxiliaryWindows: true,
      revealItem: true,
      notifications: { permission: false, click: false, dismiss: false }
    },
    readClipboardText: async () => '',
    pickFolder: async () => { nativeCalls += 1; return { cancelled: false, paths: ['/native'] } },
    openWindow: async () => ({ windowId: 'native-window' }),
    closeWindow: async () => ({ closed: true }),
    revealItem: async () => ({ requested: true }),
    activateOwner: async () => ({ activated: true }),
    nativeDropPaths: async () => null
  } satisfies DesktopShellBridge
  await answerDesktopShellRequest(
    { callAny: host.rpc } as never,
    bridge,
    folderEvent('native-picker'),
    () => {},
    host.controller
  )
  expect(nativeCalls).toBe(1)
  expect(host.calls.some((call) => call.method === 'ui.folder.list')).toBe(false)
})
test('the folder dialog browses, selects the canonical current folder, and confirms through the shared controls', async () => {
  const host = harness({
    list: (params) => {
      const path = String(params.path ?? '/home')
      return path === '/root'
        ? listing('/root', [{ name: 'project', path: '/root/project' }])
        : listing(path)
    }
  })
  const result = host.controller.handleShellRequest(folderEvent('dialog-browse', { startingFolder: '/root' }), host.rpc)
  await settle()
  const view = mount(h(FolderDialog, { controller: host.controller }))
  expect(view.querySelector('[role="dialog"]')).not.toBeNull()
  expect(view.querySelector('label')?.textContent).toBe('Folder path')

  const openProject = view.querySelector<HTMLButtonElement>('[aria-label="Open project"]')!
  await act(async () => {
    openProject.click()
    await settle()
  })
  expect(view.querySelector<HTMLInputElement>('input')?.value).toBe('/root/project')
  const selectCurrent = [...view.querySelectorAll('button')].find((button) => button.textContent === 'Select this folder')!
  await act(async () => selectCurrent.click())
  expect(host.controller.getSnapshot()?.selectedPaths).toEqual(['/root/project'])
  const confirm = [...view.querySelectorAll('button')].find((button) => button.textContent === 'Choose folder')!
  await act(async () => confirm.click())
  await expect(result).resolves.toEqual({ cancelled: false, paths: ['/root/project'] })
})

test('dialog retry recovers named folder errors and Escape cancels without disturbing the caller', async () => {
  let missingReads = 0
  const host = harness({
    list: (params) => {
      const path = String(params.path ?? '/root')
      if (path === '/missing' && missingReads++ === 0) throw new Error('NotFound: directory does not exist')
      return listing(path)
    }
  })
  const result = host.controller.handleShellRequest(folderEvent('dialog-retry', { startingFolder: '/root' }), host.rpc)
  await settle()
  const view = mount(h(FolderDialog, { controller: host.controller }))
  await act(async () => {
    await host.controller.controlCurrent('dialog-retry', 'set-path', { path: '/missing' })
    await host.controller.controlCurrent('dialog-retry', 'navigate', { path: '/missing' })
  })
  expect(view.querySelector('[role="alert"]')?.textContent).toContain('NotFound')
  expect(view.textContent).not.toContain('No folders here.')
  const retry = [...view.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!
  await act(async () => {
    retry.click()
    await settle()
  })
  expect(host.controller.getSnapshot()).toMatchObject({
    draftPath: '/missing',
    directory: { path: '/missing', entries: [] },
    error: null
  })
  expect(view.textContent).toContain('No folders here.')
  const dialog = view.querySelector<HTMLElement>('[role="dialog"]')!
  await act(async () => {
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
  })
  await expect(result).resolves.toEqual({ cancelled: true, paths: [] })
})

test('the shared Open tab modal retries synchronously and duplicate clicks create one child', async () => {
  const child = popup()
  const host = harness({ openResults: [null, child] })
  const result = host.controller.handleShellRequest(windowEvent('dialog-popup'), host.rpc)
  const view = mount(h(FolderDialog, { controller: host.controller }))
  expect(view.textContent).toContain('The browser blocked the new tab.')
  const retry = [...view.querySelectorAll('button')].find((button) => button.textContent === 'Open tab')!
  await act(async () => {
    retry.click()
    retry.click()
    await settle()
  })
  expect(host.opens).toEqual([{ url: '', target: '_blank' }, { url: '', target: '_blank' }])
  expect(host.handles).toHaveLength(1)
  const opened = await result as { windowId: string }
  expect(view.querySelector('[role="dialog"]')).toBeNull()
  await host.controller.discardWindowOpen(opened.windowId, host.rpc, false)
})

test('the no-token screen directs browser users to the usable CLI URL command', () => {
  const store = new Store()
  store.dispatch({ type: 'connection', status: 'no-token' })
  const pluginState = {
    model: null,
    settings: [],
    plugins: {},
    slots: {},
    layout: { view: null, panel: null, sidebar: true, focus: null },
    openView: null,
    windowRoute: null,
    openPanel: null,
    badges: {},
    badgeTitles: {},
    badgeTones: {},
    themeVariables: {}
  }
  const plugins = {
    subscribe: () => () => {},
    getState: () => pluginState,
    handleKey: () => false,
    setPalette: () => {}
  }
  mount(h(AppContext.Provider, {
    value: { store, connection: {} as never, plugins: plugins as never }
  }, h(App, { browserHost: null })))
  expect(container?.textContent).toContain('quirky ui url')
  expect(container?.textContent).toContain('daemon host')
  expect(container?.textContent).not.toContain('the URL the daemon prints')
})

test('the reserved browser control request bypasses contributed command lookup and replies to its exact source', async () => {
  let emit!: (event: QuirkyEvent) => void
  const reply = deferred<Record<string, unknown>>()
  let received: unknown
  new WindowPluginHost({
    call: async (method, params) => {
      if (method === 'ui.command.reply') reply.resolve(params)
      return {}
    },
    onEvent(listener) {
      emit = listener
      return () => {}
    },
    onStream: () => () => {},
    onConnection: () => () => {},
    importModule: async () => ({}),
    confirm: async () => false,
    toast: () => {},
    browserHostControl: async (params) => {
      received = params
      return { active: null }
    },
    log: () => {}
  })
  const params = { connId: 17, action: 'state' }
  emit({ type: 'ui.command.request', requestId: 'control-command', id: 'ui.browserHost.control', args: params })
  await expect(reply.promise).resolves.toEqual({ requestId: 'control-command', result: { active: null } })
  expect(received).toEqual(params)
})
test('a pending folder read uses the shared working state and an empty directory has its own empty state', async () => {
  const read = deferred<unknown>()
  const host = harness({ list: () => read.promise })
  const result = host.controller.handleShellRequest(folderEvent('working-folder', { startingFolder: '/root' }), host.rpc)
  await settle()
  const view = mount(h(FolderDialog, { controller: host.controller }))
  expect(view.textContent).toContain('Reading daemon folders')
  expect(view.querySelector('[aria-label="Reading daemon folders"]')).not.toBeNull()
  read.resolve(listing('/root'))
  await act(async () => settle())
  expect(view.textContent).toContain('No folders here.')
  const cancel = [...view.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!
  await act(async () => cancel.click())
  await expect(result).resolves.toEqual({ cancelled: true, paths: [] })
})

test('control validates identities, action-specific fields and exact connection targets', async () => {
  const read = deferred<unknown>()
  const host = harness({ list: () => read.promise })
  const result = host.controller.handleShellRequest(folderEvent('strict-controls', { startingFolder: '/root' }), host.rpc)
  await settle()
  expect(await control(host, 'state', undefined)).toMatchObject({
    active: { requestId: 'strict-controls', kind: 'folder-picker' }
  })
  await expect(host.controller.control({
    connId: 17,
    action: 'navigate',
    path: '/root'
  } as ControlParams, host.rpc)).rejects.toThrow(/requestId/)
  await expect(host.controller.control({
    connId: 17,
    action: 'select',
    requestId: 'strict-controls',
    path: '/root',
    selected: 'yes'
  } as unknown as ControlParams, host.rpc)).rejects.toThrow(/selected/)
  await expect(control(host, 'open-popup', 'strict-controls')).rejects.toThrow(/not valid/)
  await expect(control(host, 'cancel', 'strict-controls', {}, 29)).rejects.toThrow(/different UI connection/)
  await expect(host.controller.control({
    connId: 17,
    action: 'erase'
  } as unknown as ControlParams, host.rpc)).rejects.toThrow(/unknown browser host action/)
  await control(host, 'cancel', 'strict-controls')
  await expect(result).resolves.toEqual({ cancelled: true, paths: [] })
  read.resolve(listing('/root'))
  await settle()

  const idle = harness({ connId: 17 })
  await expect(idle.controller.control({ connId: 29, action: 'state' }, idle.rpc)).rejects.toThrow(/not connected/)
  await expect(idle.controller.control({ connId: 17, action: 'state' }, idle.rpc)).resolves.toEqual({ active: null })
})
test('routes opened from an auxiliary URL remove stale optional fields when the new request omits them', async () => {
  const child = popup()
  const host = harness({
    openResults: [child],
    currentUrl: 'http://127.0.0.1:6768/ui?quirkyWindowId=stale&quirkyOwnerShellConnId=3&quirkyOwnerShellName=old&quirkyView=view%3Aold&quirkyInput=%7B%22old%22%3Atrue%7D&quirkyTitle=Old#token=local'
  })
  host.setHook(async (method, params, fallback) => {
    if (method === 'desktop.shell.reply') {
      const result = params.result as { windowId: string }
      host.setRoutes([{ ...summary(result.windowId), view: 'view:fresh' }])
      return {}
    }
    return fallback()
  })
  await answerDesktopShellRequest(
    { callAny: host.rpc } as never,
    null,
    windowEvent('fresh-route', { view: 'view:fresh' }),
    () => {},
    host.controller
  )
  const route = new URL(child.location.href)
  expect(route.searchParams.getAll('quirkyWindowId')).toEqual([host.routes[0]!.windowId])
  expect(route.searchParams.getAll('quirkyOwnerShellConnId')).toEqual(['17'])
  expect(route.searchParams.getAll('quirkyView')).toEqual(['view:fresh'])
  expect(route.searchParams.getAll('quirkyInput')).toEqual([])
  expect(route.searchParams.getAll('quirkyTitle')).toEqual([])
  expect(route.hash).toBe('#token=local')
})

test('browser close answers only for owned handles and recognizes a child closed manually', async () => {
  const child = popup()
  child.close = () => {}
  const host = harness({ openResults: [child] })
  host.setHook(async (method, params, fallback) => {
    if (method === 'desktop.shell.reply') {
      const result = params.result as { windowId: string }
      host.setRoutes([summary(result.windowId)])
      return {}
    }
    return fallback()
  })
  await answerDesktopShellRequest({ callAny: host.rpc } as never, null, windowEvent('owned-child'), () => {}, host.controller)
  const windowId = host.routes[0]!.windowId
  const closeRequest = () => ({
    type: 'desktop.shell.request' as const,
    requestId: 'close-child',
    action: { kind: 'window-close' as const, request: { windowId } },
    ownerShell: { connId: 17, name: 'quirky-ui' }
  })
  await expect(host.controller.handleShellRequest(closeRequest(), host.rpc)).resolves.toEqual({ closed: false })
  child.closed = true
  await expect(host.controller.handleShellRequest(closeRequest(), host.rpc)).resolves.toEqual({ closed: true })
  await expect(host.controller.handleShellRequest(closeRequest(), host.rpc)).resolves.toEqual({ closed: true })
  await expect(host.controller.handleShellRequest({
    ...closeRequest(),
    requestId: 'close-not-owned',
    action: { kind: 'window-close', request: { windowId: 'foreign-tab' } }
  }, host.rpc)).rejects.toThrow(/not owned/)
})
test('routed control restores its exact target and a stale awaited mutation cannot reach a successor', async () => {
  const identity = deferred<unknown>()
  const host = harness()
  let delayIdentity = false
  host.setHook((method, _params, fallback) =>
    method === 'ui.window.self' && delayIdentity ? identity.promise : fallback()
  )
  const first = host.controller.handleShellRequest(folderEvent('routed-first', { startingFolder: '/first' }), host.rpc)
  await settle()
  delayIdentity = true
  const staleCancel = host.controller.controlRouted({ action: 'cancel', requestId: 'routed-first' }, host.rpc)
  await settle()
  await control(host, 'cancel', 'routed-first')
  await expect(first).resolves.toEqual({ cancelled: true, paths: [] })

  const second = host.controller.handleShellRequest(folderEvent('routed-second', { startingFolder: '/second' }), host.rpc)
  await settle()
  identity.resolve({ connId: 17 })
  await expect(staleCancel).rejects.toThrow(/no longer active/)
  expect(host.controller.getSnapshot()?.requestId).toBe('routed-second')
  delayIdentity = false
  await host.controller.controlRouted({ action: 'cancel', requestId: 'routed-second' }, host.rpc)
  await expect(second).resolves.toEqual({ cancelled: true, paths: [] })
})
test('typing in the folder path updates the controlled draft instead of reverting', async () => {
  const host = harness({ list: (params) => listing(String(params.path ?? '/root')) })
  const result = host.controller.handleShellRequest(folderEvent('typed-path', { startingFolder: '/root' }), host.rpc)
  await settle()
  const view = mount(h(FolderDialog, { controller: host.controller }))
  const input = view.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '/root/project')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  })
  expect(host.controller.getSnapshot()?.draftPath).toBe('/root/project')
  expect(input.value).toBe('/root/project')
  await act(async () => { await control(host, 'cancel', 'typed-path') })
  await expect(result).resolves.toEqual({ cancelled: true, paths: [] })
})

test('multi-select false is idempotent and never adds a path that was not selected', async () => {
  const host = harness({
    list: () => listing('/root', [
      { name: 'alpha', path: '/root/alpha' },
      { name: 'beta', path: '/root/beta' }
    ])
  })
  const result = host.controller.handleShellRequest(folderEvent('explicit-selection', {
    startingFolder: '/root',
    multiple: true
  }), host.rpc)
  await settle()
  await control(host, 'select', 'explicit-selection', { path: '/root/alpha', selected: false })
  expect(host.controller.getSnapshot()?.selectedPaths).toEqual([])
  await control(host, 'select', 'explicit-selection', { path: '/root/alpha', selected: true })
  await control(host, 'select', 'explicit-selection', { path: '/root/beta', selected: false })
  expect(host.controller.getSnapshot()?.selectedPaths).toEqual(['/root/alpha'])
  await control(host, 'select', 'explicit-selection', { path: '/root/alpha', selected: false })
  await control(host, 'select', 'explicit-selection', { path: '/root/alpha', selected: false })
  expect(host.controller.getSnapshot()?.selectedPaths).toEqual([])
  await control(host, 'cancel', 'explicit-selection')
  await result
})

test('navigation cannot replace a folder selection while confirmation is revalidating it', async () => {
  const confirmationRead = deferred<unknown>()
  const host = harness({
    list: (params) => {
      const path = String(params.path ?? '/root')
      if (path === '/root') return listing('/root', [
        { name: 'alpha', path: '/root/alpha' },
        { name: 'beta', path: '/root/beta' }
      ])
      if (path === '/root/alpha') return confirmationRead.promise
      return listing(path)
    }
  })
  const result = host.controller.handleShellRequest(folderEvent('confirm-navigation', { startingFolder: '/root' }), host.rpc)
  await settle()
  await control(host, 'select', 'confirm-navigation', { path: '/root/alpha', selected: true })
  const confirmation = control(host, 'confirm', 'confirm-navigation')
  await settle()
  await expect(control(host, 'navigate', 'confirm-navigation', { path: '/root/beta' })).rejects.toThrow(/working|confirm/i)
  expect(host.controller.getSnapshot()).toMatchObject({
    busy: true,
    draftPath: '/root',
    selectedPaths: ['/root/alpha']
  })
  expect(host.calls.some((call) => call.method === 'ui.folder.list' && call.params.path === '/root/beta')).toBe(false)
  confirmationRead.resolve(listing('/root/alpha'))
  await confirmation
  await expect(result).resolves.toEqual({ cancelled: false, paths: ['/root/alpha'] })
})

test('dispose permits only the owned window-close round trip needed to remove a registered route', async () => {
  const child = popup()
  const host = harness({ openResults: [child] })
  const closeReply = deferred<{ closed: boolean }>()
  host.setHook(async (method, params, fallback) => {
    if (method === 'desktop.shell.reply') {
      const result = params.result as { windowId: string }
      host.setRoutes([summary(result.windowId)])
      return {}
    }
    if (method === 'desktop.window.close') {
      const windowId = String(params.windowId)
      let result: { closed: boolean }
      try {
        result = await host.controller.handleShellRequest({
          type: 'desktop.shell.request',
          requestId: 'dispose-close',
          action: { kind: 'window-close', request: { windowId } },
          ownerShell: { connId: 17, name: 'quirky-ui' }
        }, host.rpc) as { closed: boolean }
      } catch (error) {
        closeReply.reject(error)
        throw error
      }
      if (result.closed) host.setRoutes(host.routes.filter((route) => route.windowId !== windowId))
      closeReply.resolve(result)
      return result
    }
    return fallback()
  })
  await answerDesktopShellRequest(
    { callAny: host.rpc } as never,
    null,
    windowEvent('dispose-owned-window'),
    () => {},
    host.controller
  )
  expect(host.routes).toHaveLength(1)
  host.controller.dispose()
  await expect(closeReply.promise).resolves.toEqual({ closed: true })
  expect(child.closed).toBe(true)
  expect(host.routes).toEqual([])
  await expect(host.controller.handleShellRequest(folderEvent('after-dispose'), host.rpc)).rejects.toThrow(/unavailable/)
})
