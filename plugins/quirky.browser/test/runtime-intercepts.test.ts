import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { BrowserStore, type BrowserPage } from '../src/profiles/store'
import { CdpTimeoutError, type CdpEvent } from '../src/runtime/cdp'
import { BrowserRuntime, type PageCdp, type PaneWatchCallbacks, type RuntimePageState } from '../src/runtime/driver'
import { BrowserExtraActions } from '../src/runtime/extras-actions'
import { InterceptLedger } from '../src/runtime/intercept'

type Command = { method: string; params: Record<string, unknown>; sessionId?: string; timeoutMs?: number }

function deferred<T = unknown>() {
  return Promise.withResolvers<T>()
}

type HelperServer = { close(): Promise<void> }
async function helperServer(
  socketPath: string,
  onAction: (action: { id: string; action: string; [key: string]: unknown }) => void = () => {}
) {
  const server = createServer((socket) => {
    let frame = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      frame += chunk
      const boundary = frame.indexOf('\n')
      if (boundary < 0) return
      const request = JSON.parse(frame.slice(0, boundary)) as { id: string; action: string; [key: string]: unknown }
      onAction(request)
      const data = request.action === 'tab_switch'
        ? { tabId: request.tabId }
        : request.action === 'tab_new' ? { tabId: 'restored-tab' } : {}
      socket.end(`${JSON.stringify({ id: request.id, success: true, data })}\n`)
    })
  })
  const ready = deferred<void>()
  server.once('error', ready.reject)
  server.listen(socketPath, ready.resolve)
  await ready.promise
  return {
    async close() {
      const closed = deferred<void>()
      server.close((error) => error ? closed.reject(error) : closed.resolve())
      await closed.promise
    }
  }
}

function releaseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-intercept-release-'))
  const store = new BrowserStore(root)
  const page = store.addPage({ profileId: 'default', worktreeId: null, url: 'about:blank', title: '' })
  const invalidated: string[] = []
  let spawns = 0
  const runtime = new BrowserRuntime(store, {
    runtimeRoot: root,
    process: {
      run: async () => { throw new Error('a refused continuation must not run a command') },
      spawn: () => { spawns++; throw new Error('a refused continuation must not start another browser') }
    },
    spawn: () => { spawns++; throw new Error('a refused continuation must not start another browser') }
  }, (id) => { invalidated.push(id) })
  const commands: Command[] = []
  const refusals: string[] = []
  const teardown: string[] = []
  const listeners = new Map<string, Set<(event: CdpEvent) => void>>()
  const gates = new Map<string, Promise<unknown>>()
  const hooks = new Map<string, (command: Command) => void>()
  const responses = new Map<string, (command: Command) => unknown>()
  const sendPromises = new Map<string, Promise<unknown>>()
  const cdp: PageCdp & { close(): void } = {
    send(method, params = {}, sessionId, timeoutMs) {
      const command = { method, params, sessionId, timeoutMs }
      commands.push(command)
      const requestKey = method === 'Fetch.failRequest' ? `${method}:${String(params.requestId)}` : method
      const hook = hooks.get(requestKey) ?? hooks.get(method)
      if (hook) {
        hooks.delete(requestKey)
        hooks.delete(method)
        hook(command)
      }
      const pending = (async () => {
        const gate = gates.get(requestKey) ?? gates.get(method)
        if (gate) return await gate
        const response = responses.get(requestKey) ?? responses.get(method)
        if (response) return response(command)
        if (method === 'Fetch.continueRequest' && params.requestId === 'refused-request') {
          refusals.push(String(params.requestId))
          throw new Error('Fetch.continueRequest: Invalid InterceptionId.')
        }
        if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'epoch remains usable' } }
        return {}
      })()
      sendPromises.set(requestKey, pending)
      return pending
    },
    subscribe(method, listener) {
      const subscribers = listeners.get(method) ?? new Set()
      subscribers.add(listener)
      listeners.set(method, subscribers)
      return () => { subscribers.delete(listener) }
    },
    close() { teardown.push('cdp') }
  }
  const runtimePage: RuntimePageState = {
    binding: { browserEpoch: 'owned-epoch', pageGeneration: 0, targetId: 'owned-target', sessionId: 'owned-session', tabId: 'owned-tab' },
    consoleEntries: [], networkById: new Map(), networkResourceTypes: new Map(), networkEntries: [], harEntries: [],
    intercepts: new InterceptLedger(), domContentLoadedLoaders: new Set(), loadedLoaders: new Set()
  }
  const binding = {
    pageId: page.browserPageId, targetId: 'owned-target', sessionId: 'owned-session', tabId: 'owned-tab', generation: 0, runtime: runtimePage
  }
  const epoch: FakeEpoch = {
    id: 'owned-epoch', profileId: page.profileId, invalid: false, stopping: false, cdp,
    activeTabId: binding.tabId, pages: new Map([[page.browserPageId, binding]]),
    helper: {
      socketPath: join(root, 'helper.sock'), socketDir: join(root, 'sockets'), socketAliasRoot: join(root, 'aliases'),
      async asyncClose() { teardown.push('helper') }
    },
    chrome: { profileRoot: join(root, 'chrome'), child: { exited: Promise.resolve() }, async asyncClose() { teardown.push('chrome') } }
  }
  // Reuse the per-instance fake-epoch seam so no module mocks or real Chrome races can hide lifecycle ordering.
  Reflect.set(Reflect.get(runtime, 'profile').call(runtime, page.profileId), 'epoch', epoch)
  const subscribePageEvents = Reflect.get(runtime, 'subscribePageEvents') as (epoch: object, binding: object) => void
  const actions = new BrowserExtraActions(store, runtime, () => { throw new Error('unexpected element operation') })
  const emit = (method: string, params: Record<string, unknown>, sessionId = binding.sessionId) => {
    const event = { method, params, sessionId } as CdpEvent
    for (const listener of [...(listeners.get(method) ?? [])]) listener(event)
  }
  return {
    root, store, page, runtime, runtimePage, binding, epoch, cdp, actions, commands, refusals, invalidated, teardown,
    gates, hooks, responses, listeners, sendPromises, emit,
    get spawns() { return spawns },
    registerPageEvents: (targetEpoch: FakeEpoch = epoch, targetBinding: FakeBinding = binding) => {
      subscribePageEvents.call(runtime, targetEpoch, targetBinding)
    }
  }
}

type FakeBinding = {
  pageId: string
  targetId: string
  sessionId: string
  tabId: string
  generation: number
  runtime: RuntimePageState
}

type FakeEpoch = {
  id: string
  profileId: string
  invalid: boolean
  stopping: boolean
  cdp: PageCdp & { close(): void }
  pages: Map<string, FakeBinding>
  activeTabId?: string
  userAgent?: string
  teardown?: Promise<void>
  helper: { socketPath: string; socketDir: string; socketAliasRoot: string; asyncClose(): Promise<void> }
  chrome: { profileRoot: string; child: { exited: Promise<void> }; asyncClose(): Promise<void> }
}

type RuntimeInterceptFixture = {
  root: string
  store: BrowserStore
  page: BrowserPage
  runtime: BrowserRuntime
  runtimePage: RuntimePageState
  binding: FakeBinding
  epoch: FakeEpoch
  cdp: PageCdp & { close(): void }
  actions: BrowserExtraActions
  commands: Command[]
  refusals: string[]
  invalidated: string[]
  teardown: string[]
  gates: Map<string, Promise<unknown>>
  hooks: Map<string, (command: Command) => void>
  responses: Map<string, (command: Command) => unknown>
  listeners: Map<string, Set<(event: CdpEvent) => void>>
  emit(method: string, params: Record<string, unknown>, sessionId?: string): void
  registerPageEvents(targetEpoch?: FakeEpoch, targetBinding?: FakeBinding): void
  sendPromises: Map<string, Promise<unknown>>
  readonly spawns: number
}

function emitPaused(f: RuntimeInterceptFixture, requestId: string, sessionId = 'owned-session'): void {
  f.emit('Fetch.requestPaused', {
    requestId,
    request: { url: `http://127.0.0.1/held/${requestId}`, method: 'GET', headers: {} },
    resourceType: 'Fetch'
  }, sessionId)
}

function watchCallbacks(): PaneWatchCallbacks {
  return {
    onFrame: () => {},
    onPrompt: () => {},
    onDownloadStart: () => {},
    onDownloadProgress: () => {},
    onLocation: () => {},
    onIssue: () => {},
    onStale: () => {}
  }
}

async function enableRoute(f: RuntimeInterceptFixture): Promise<void> {
  await f.runtime.withPage(f.page, 'interceptEnable', (execution) =>
    f.actions.run('interceptEnable', { patterns: ['*held*'] }, execution))
}

function holdRequests(f: RuntimeInterceptFixture, requestIds: string[]): void {
  for (const id of requestIds) {
    expect(f.runtimePage.intercepts.hold({
      id, url: `http://127.0.0.1/held/${id}`, method: 'GET', headers: {}, resourceType: 'Fetch'
    })).toBe(true)
  }
}

for (const watched of [false, true]) {
  test(`a refused held continuation cannot fail disable on an ${watched ? 'actively watched' : 'unwatched'} page`, async () => {
    const f = releaseFixture()
    const pageId = f.page.browserPageId
    const watchId = 'live-watch'
    const watchEvents: unknown[] = []
    const callbacks: PaneWatchCallbacks = {
      onFrame: (event) => { watchEvents.push(event) },
      onPrompt: (event) => { watchEvents.push(event) },
      onDownloadStart: (event) => { watchEvents.push(event) },
      onDownloadProgress: (event) => { watchEvents.push(event) },
      onLocation: (event) => { watchEvents.push(event) },
      onIssue: (event) => { watchEvents.push(event) },
      onStale: (event) => { watchEvents.push(event) }
    }
    try {
      if (watched) await f.runtime.startPaneWatch(f.page, watchId, callbacks)
      await f.runtime.withPage(f.page, 'interceptEnable', (execution) => f.actions.run('interceptEnable', { patterns: ['*held*'] }, execution))
      for (const id of ['refused-request', 'live-request']) {
        expect(f.runtimePage.intercepts.hold({
          id, url: `http://127.0.0.1/held/${id}`, method: 'GET', headers: {}, resourceType: 'Fetch'
        })).toBe(true)
      }
      expect(f.runtime.interceptSnapshot(pageId).requests.map(({ id }) => id)).toEqual(['refused-request', 'live-request'])

      const disabled = await f.runtime.withInterceptsReleased(pageId, () => f.runtime.withPage(f.page, 'interceptDisable',
        (execution) => f.actions.run('interceptDisable', {}, execution)))

      expect(disabled).toEqual({ disabled: true })
      expect(f.commands.filter(({ method }) => method === 'Fetch.continueRequest')).toEqual([
        { method: 'Fetch.continueRequest', params: { requestId: 'refused-request' }, sessionId: 'owned-session', timeoutMs: 5_000 },
        { method: 'Fetch.continueRequest', params: { requestId: 'live-request' }, sessionId: 'owned-session', timeoutMs: 5_000 }
      ])
      expect(f.refusals).toEqual(['refused-request'])
      expect(f.runtime.interceptSnapshot(pageId)).toEqual({ patterns: [], requests: [] })
      expect(f.runtimePage.intercepts.list()).toEqual([])
      const probe = await f.runtime.withPage(f.page, 'eval', async (execution) => {
        expect(execution.binding.browserEpoch).toBe('owned-epoch')
        expect(execution.binding.sessionId).toBe('owned-session')
        return await execution.cdp.send('Runtime.evaluate', { expression: '"epoch remains usable"', returnByValue: true }, execution.binding.sessionId)
      })
      expect(probe).toEqual({ result: { type: 'string', value: 'epoch remains usable' } })
      expect(f.epoch.invalid).toBe(false)
      expect(f.invalidated).toEqual([])
      expect(f.teardown).toEqual([])
      expect(watchEvents).toEqual([])
      if (watched) {
        expect(f.runtime.isPageWatched(pageId)).toBe(true)
        await f.runtime.stopPaneWatch(watchId)
        expect(f.runtime.isPageWatched(pageId)).toBe(false)
        expect(f.commands).toContainEqual({ method: 'Page.stopScreencast', params: {}, sessionId: 'owned-session', timeoutMs: 5_000 })
      }
    } finally {
      if (f.runtime.isPageWatched(pageId)) await f.runtime.stopPaneWatch(watchId)
      rmSync(f.root, { recursive: true, force: true })
    }
  })
}
for (const watched of [false, true]) {
  for (const lifecycle of ['close', 'profile rebind'] as const) {
    test(`${lifecycle} terminally aborts held and late requests on a ${watched ? 'watched' : 'unwatched'} binding`, async () => {
      const f = releaseFixture()
      const pageId = f.page.browserPageId
      const watchId = `discard-${lifecycle}-${watched}`
      const heldIds = ['held-one', 'held-two']
      const abortGates = heldIds.map(() => deferred())
      const targetGate = deferred()
      const targetStarted = deferred<void>()
      const abortStarted = deferred<void>()
      let cleanup: Promise<void> | undefined
      f.registerPageEvents()
      try {
        if (watched) await f.runtime.startPaneWatch(f.page, watchId, watchCallbacks())
        await enableRoute(f)
        holdRequests(f, heldIds)
        for (const [index, id] of heldIds.entries()) f.gates.set(`Fetch.failRequest:${id}`, abortGates[index]!.promise)
        f.gates.set('Target.closeTarget', targetGate.promise)
        f.hooks.set('Target.closeTarget', () => targetStarted.resolve())
        f.hooks.set('Fetch.failRequest:held-one', () => abortStarted.resolve())
        if (watched) f.hooks.set('Page.stopScreencast', () => emitPaused(f, 'watch-handoff'))

        cleanup = lifecycle === 'close'
          ? f.runtime.closePageOutOfBand(pageId)
          : f.runtime.cancelPageForChange(pageId)
        const firstBoundary = await Promise.race([
          abortStarted.promise.then(() => 'abort' as const),
          targetStarted.promise.then(() => 'target' as const)
        ])
        expect(firstBoundary).toBe('abort')

        const initialFailures = f.commands.filter(({ method, params }) =>
          method === 'Fetch.failRequest' && heldIds.includes(String(params.requestId)))
        expect(initialFailures).toEqual(heldIds.map((requestId) => ({
          method: 'Fetch.failRequest', params: { requestId, errorReason: 'Aborted' },
          sessionId: 'owned-session', timeoutMs: 5_000
        })))
        expect(f.commands.filter(({ method }) => method === 'Target.closeTarget')).toEqual([])

        emitPaused(f, 'late-during-abort')
        await f.runtime.withInterceptsReleased(pageId, () =>
          f.runtime.withPage(f.page, 'interceptDisable', (execution) => f.actions.run('interceptDisable', {}, execution))
        ).catch(() => undefined)
        expect(f.commands.some(({ method, params }) =>
          method === 'Fetch.continueRequest' && heldIds.includes(String(params.requestId)))).toBe(false)

        for (const gate of abortGates) gate.resolve({})
        const termination = f.runtimePage.termination
        expect(termination).toBeDefined()
        let terminationSettled = false
        void termination!.then(() => { terminationSettled = true })
        expect(terminationSettled).toBe(false)
        await targetStarted.promise
        const closeCommand = f.commands.find(({ method }) => method === 'Target.closeTarget')
        expect(closeCommand?.params).toEqual({ targetId: 'owned-target' })
        expect(closeCommand?.sessionId).toBeUndefined()
        expect(closeCommand?.timeoutMs).toBe(5_000)
        const lastCapturedAbort = Math.max(...heldIds.map((id) => f.commands.findIndex(({ method, params }) =>
          method === 'Fetch.failRequest' && params.requestId === id)))
        expect(f.commands.findIndex(({ method }) => method === 'Target.closeTarget')).toBeGreaterThan(lastCapturedAbort)
        emitPaused(f, 'late-during-close')
        targetGate.resolve({})
        await cleanup
        if (lifecycle === 'profile rebind') f.runtime.finishPageChange(pageId)
        await termination
        expect(terminationSettled).toBe(true)
        emitPaused(f, 'late-after-termination')

        const failures = f.commands.filter(({ method }) => method === 'Fetch.failRequest')
        for (const command of failures) {
          expect(command).toEqual({
            method: 'Fetch.failRequest',
            params: { requestId: command.params.requestId, errorReason: 'Aborted' },
            sessionId: 'owned-session',
            timeoutMs: 5_000
          })
        }
        expect(failures.map(({ params }) => params.requestId)).toContain('late-during-abort')
        expect(failures.map(({ params }) => params.requestId)).toContain('late-during-close')
        expect(failures.map(({ params }) => params.requestId)).toContain('late-after-termination')
        if (watched) expect(failures.map(({ params }) => params.requestId)).toContain('watch-handoff')
        expect(f.commands.filter(({ method }) => method === 'Fetch.continueRequest' || method === 'Fetch.disable')).toEqual([])
        expect(f.runtimePage.intercepts.discarded).toBe(true)
        expect(f.runtimePage.intercepts.list()).toEqual([])
      } finally {
        for (const gate of abortGates) gate.resolve({})
        targetGate.resolve({})
        await cleanup?.catch(() => {})
        if (f.runtime.isPageWatched(pageId)) await f.runtime.stopPaneWatch(watchId)
        if (lifecycle === 'profile rebind') f.runtime.finishPageChange(pageId)
        rmSync(f.root, { recursive: true, force: true })
      }
    })
  }
}

test('concurrent close and rebind share one abort barrier before helper tab_close', async () => {
  const f = releaseFixture()
  const pageId = f.page.browserPageId
  const abortGate = deferred()
  const targetGate = deferred()
  const targetStarted = deferred<void>()
  const helperCloseStarted = deferred<void>()
  const helperActions: string[] = []
  const trace: string[] = []
  let helper: HelperServer | undefined
  let rebind: Promise<void> | undefined
  let close: Promise<void> | undefined
  f.registerPageEvents()
  try {
    await enableRoute(f)
    holdRequests(f, ['held-request'])
    helper = await helperServer(f.epoch.helper.socketPath, ({ action }) => {
      helperActions.push(action)
      trace.push(`helper:${action}`)
      if (action === 'tab_close') helperCloseStarted.resolve()
    })
    f.gates.set('Fetch.failRequest:held-request', abortGate.promise)
    f.gates.set('Target.closeTarget', targetGate.promise)
    f.hooks.set('Target.closeTarget', () => {
      trace.push('Target.closeTarget')
      targetStarted.resolve()
    })
    f.hooks.set('Fetch.failRequest:held-request', () => trace.push('Fetch.failRequest'))

    rebind = f.runtime.rebindPageLocked(f.page.profileId, pageId)
    close = f.runtime.closePageOutOfBand(pageId)
    expect(f.commands.filter(({ method }) => method === 'Fetch.failRequest')).toEqual([{
      method: 'Fetch.failRequest',
      params: { requestId: 'held-request', errorReason: 'Aborted' },
      sessionId: 'owned-session',
      timeoutMs: 5_000
    }])
    expect(helperActions).toEqual([])
    expect(f.commands.filter(({ method }) => method === 'Target.closeTarget')).toEqual([])

    abortGate.resolve({})
    await helperCloseStarted.promise
    await targetStarted.promise
    expect(f.commands.filter(({ method }) => method === 'Fetch.failRequest')).toHaveLength(1)
    expect(trace.indexOf('Fetch.failRequest')).toBeLessThan(trace.indexOf('helper:tab_close'))
    expect(trace.indexOf('Fetch.failRequest')).toBeLessThan(trace.indexOf('Target.closeTarget'))
    targetGate.resolve({})
    await Promise.all([rebind, close])
    expect(f.runtimePage.intercepts.discarded).toBe(true)
    expect(helperActions).toContain('tab_close')
  } finally {
    abortGate.resolve({})
    targetGate.resolve({})
    await Promise.all([rebind, close].filter((promise): promise is Promise<void> => promise !== undefined).map((promise) => promise.catch(() => {})))
    await helper?.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('an active Watch fails pauses arriving after its binding ledger is discarded', async () => {
  const f = releaseFixture()
  const pageId = f.page.browserPageId
  const watchId = 'discarded-watch-handler'
  f.registerPageEvents()
  try {
    await f.runtime.startPaneWatch(f.page, watchId, watchCallbacks())
    await enableRoute(f)
    holdRequests(f, ['held-before-discard'])
    const lateFailureGate = deferred()
    f.gates.set('Fetch.failRequest:late-on-active-watch', lateFailureGate.promise)
    expect(f.runtimePage.intercepts.discard()).toEqual(['held-before-discard'])

    emitPaused(f, 'late-on-active-watch')
    const lateFailure = f.sendPromises.get('Fetch.failRequest:late-on-active-watch')!
    expect(lateFailure).toBeDefined()

    expect(f.commands.filter(({ method }) => method === 'Fetch.failRequest')).toEqual([{
      method: 'Fetch.failRequest',
      params: { requestId: 'late-on-active-watch', errorReason: 'Aborted' },
      sessionId: 'owned-session',
      timeoutMs: 5_000
    }])
    lateFailureGate.reject(new Error('Fetch.failRequest: Invalid InterceptionId.'))
    await expect(lateFailure).rejects.toThrow('Invalid InterceptionId.')
    expect(f.runtime.isPageWatched(pageId)).toBe(true)
    expect(f.epoch.invalid).toBe(false)
    expect(f.commands.filter(({ method }) => method === 'Fetch.continueRequest')).toEqual([])
  } finally {
    if (f.runtime.isPageWatched(pageId)) await f.runtime.stopPaneWatch(watchId)
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('close marks a watched binding terminal before gated Watch shutdown and awaits both barriers', async () => {
  const f = releaseFixture()
  const pageId = f.page.browserPageId
  const watchId = 'gated-watch-shutdown'
  const watchGate = deferred()
  const abortGate = deferred()
  const targetStarted = deferred<void>()
  let cleanup: Promise<void> | undefined
  f.registerPageEvents()
  try {
    await f.runtime.startPaneWatch(f.page, watchId, watchCallbacks())
    await enableRoute(f)
    holdRequests(f, ['held-before-close'])
    f.gates.set('Page.stopScreencast', watchGate.promise)
    f.gates.set('Fetch.failRequest:held-before-close', abortGate.promise)
    f.hooks.set('Page.stopScreencast', () => emitPaused(f, 'watch-shutdown-handoff'))
    f.hooks.set('Target.closeTarget', () => targetStarted.resolve())

    cleanup = f.runtime.closePageOutOfBand(pageId)
    expect(f.runtimePage.intercepts.discarded).toBe(true)
    expect(f.runtime.isPageWatched(pageId)).toBe(false)
    expect(f.commands.filter(({ method }) => method === 'Target.closeTarget')).toEqual([])
    expect(f.commands.filter(({ method, params }) =>
      method === 'Fetch.failRequest' && params.requestId === 'watch-shutdown-handoff')).toEqual([{
      method: 'Fetch.failRequest',
      params: { requestId: 'watch-shutdown-handoff', errorReason: 'Aborted' },
      sessionId: 'owned-session',
      timeoutMs: 5_000
    }])

    watchGate.resolve({})
    await Promise.resolve()
    expect(f.commands.filter(({ method }) => method === 'Target.closeTarget')).toEqual([])
    abortGate.resolve({})
    await targetStarted.promise
    await cleanup
    const handoffFailureIndex = f.commands.findIndex(({ method, params }) =>
      method === 'Fetch.failRequest' && params.requestId === 'watch-shutdown-handoff')
    expect(f.commands.findIndex(({ method }) => method === 'Target.closeTarget')).toBeGreaterThan(handoffFailureIndex)
    expect(f.runtimePage.intercepts.list()).toEqual([])
  } finally {
    watchGate.resolve({})
    abortGate.resolve({})
    await cleanup?.catch(() => {})
    if (f.runtime.isPageWatched(pageId)) await f.runtime.stopPaneWatch(watchId)
    rmSync(f.root, { recursive: true, force: true })
  }
})

for (const failure of [
  { name: 'Invalid InterceptionId refusal', error: new Error('Fetch.failRequest: Invalid InterceptionId.') },
  { name: 'CDP timeout', error: new CdpTimeoutError('Fetch.failRequest') }
]) {
  test(`${failure.name} is local to the discarded binding and preserves a sibling Watch`, async () => {
    const f = releaseFixture()
    const pageId = f.page.browserPageId
    const sibling = f.store.addPage({ profileId: f.page.profileId, worktreeId: null, url: 'about:blank', title: '' })
    const siblingState: RuntimePageState = {
      binding: {
        browserEpoch: f.epoch.id, pageGeneration: 0, targetId: 'sibling-target',
        sessionId: 'sibling-session', tabId: 'sibling-tab'
      },
      consoleEntries: [], networkById: new Map(), networkResourceTypes: new Map(), networkEntries: [], harEntries: [],
      intercepts: new InterceptLedger(), domContentLoadedLoaders: new Set(), loadedLoaders: new Set()
    }
    const siblingBinding: FakeBinding = {
      pageId: sibling.browserPageId, targetId: 'sibling-target', sessionId: 'sibling-session',
      tabId: 'sibling-tab', generation: 0, runtime: siblingState
    }
    const watchId = 'unrelated-sibling-watch'
    const refusalGate = deferred()
    const liveGate = deferred()
    const targetStarted = deferred<void>()
    let cleanup: Promise<void> | undefined
    f.epoch.pages.set(sibling.browserPageId, siblingBinding)
    f.registerPageEvents(f.epoch, siblingBinding)
    f.registerPageEvents()
    try {
      await enableRoute(f)
      f.epoch.activeTabId = siblingBinding.tabId
      await f.runtime.startPaneWatch(sibling, watchId, watchCallbacks())
      holdRequests(f, ['refused-request', 'live-request'])
      f.gates.set('Fetch.failRequest:refused-request', refusalGate.promise)
      f.gates.set('Fetch.failRequest:live-request', liveGate.promise)
      f.hooks.set('Target.closeTarget', () => targetStarted.resolve())

      cleanup = f.runtime.closePageOutOfBand(pageId)
      expect(f.commands.filter(({ method }) => method === 'Fetch.failRequest')).toEqual([
        {
          method: 'Fetch.failRequest', params: { requestId: 'refused-request', errorReason: 'Aborted' },
          sessionId: 'owned-session', timeoutMs: 5_000
        },
        {
          method: 'Fetch.failRequest', params: { requestId: 'live-request', errorReason: 'Aborted' },
          sessionId: 'owned-session', timeoutMs: 5_000
        }
      ])
      expect(f.commands.filter(({ method }) => method === 'Target.closeTarget')).toEqual([])

      refusalGate.reject(failure.error)
      liveGate.resolve({})
      await targetStarted.promise
      await cleanup
      const lateFailureGate = deferred()
      f.gates.set('Fetch.failRequest:late-after-close', lateFailureGate.promise)
      emitPaused(f, 'late-after-close')
      const lateFailure = f.sendPromises.get('Fetch.failRequest:late-after-close')!
      expect(f.commands).toContainEqual({
        method: 'Fetch.failRequest',
        params: { requestId: 'late-after-close', errorReason: 'Aborted' },
        sessionId: 'owned-session',
        timeoutMs: 5_000
      })
      lateFailureGate.reject(failure.error)
      await expect(lateFailure).rejects.toThrow(failure.error.message)

      expect(f.commands.filter(({ method }) => method === 'Target.closeTarget')).toHaveLength(1)
      expect(f.runtimePage.intercepts.discarded).toBe(true)
      expect(f.runtimePage.intercepts.list()).toEqual([])
      expect(f.epoch.invalid).toBe(false)
      expect(f.invalidated).toEqual([pageId])
      expect(f.spawns).toBe(0)
      expect(f.runtime.isPageWatched(sibling.browserPageId)).toBe(true)
      expect(siblingState.intercepts.discarded).toBe(false)
    } finally {
      refusalGate.resolve({})
      liveGate.resolve({})
      await cleanup?.catch(() => {})
      if (f.runtime.isPageWatched(sibling.browserPageId)) await f.runtime.stopPaneWatch(watchId)
      rmSync(f.root, { recursive: true, force: true })
    }
  })
}

test('epoch loss discards only local state and restoration binds a fresh bootstrap-suspended ledger', async () => {
  const f = releaseFixture()
  const pageId = f.page.browserPageId
  const oldLedger = f.runtimePage.intercepts
  const profile = Reflect.get(f.runtime, 'profile').call(f.runtime, f.page.profileId) as object
  const invalidateEpoch = Reflect.get(f.runtime, 'invalidateEpoch') as (profile: object, epoch: FakeEpoch, reason: string) => void
  const originalDelete = f.epoch.pages.delete.bind(f.epoch.pages)
  let terminalBeforeRemoval = false
  let helper: HelperServer | undefined
  f.registerPageEvents()
  try {
    await enableRoute(f)
    holdRequests(f, ['held-before-loss'])
    f.epoch.pages.delete = (key) => {
      if (key === pageId) terminalBeforeRemoval = oldLedger.discarded && oldLedger.list().length === 0
      return originalDelete(key)
    }
    const commandCountBeforeLoss = f.commands.length

    invalidateEpoch.call(f.runtime, profile, f.epoch, 'fake transport loss')
    await (f.epoch.teardown ?? Promise.resolve())

    expect(terminalBeforeRemoval).toBe(true)
    expect(oldLedger.discarded).toBe(true)
    expect(oldLedger.list()).toEqual([])
    expect(f.commands.slice(commandCountBeforeLoss).filter(({ method }) => method.startsWith('Fetch.'))).toEqual([])
    expect(f.runtime.interceptSnapshot(pageId)).toEqual({ patterns: ['*held*'], requests: [] })
    expect(f.spawns).toBe(0)

    f.store.updatePage(pageId, (page) => { page.url = 'http://127.0.0.1/retained-page' })
    const retainedPage = f.store.getPage(pageId)
    const retainedUrl = retainedPage.url
    const freshEpoch: FakeEpoch = {
      id: 'restored-epoch',
      profileId: f.page.profileId,
      invalid: false,
      stopping: false,
      cdp: f.cdp,
      pages: new Map(),
      userAgent: 'fake-agent',
      helper: f.epoch.helper,
      chrome: f.epoch.chrome
    }
    Reflect.set(profile, 'epoch', freshEpoch)
    let targetSnapshots = 0
    f.responses.set('Target.getTargets', () => ({
      targetInfos: targetSnapshots++ === 0 ? [] : [{ targetId: 'restored-target', type: 'page' }]
    }))
    f.responses.set('Target.attachToTarget', () => ({ sessionId: 'restored-session' }))
    f.responses.set('Page.getFrameTree', () => ({
      frameTree: { frame: { id: 'restored-frame', loaderId: 'initial-loader', url: 'about:blank' } }
    }))
    f.responses.set('Page.navigate', () => ({ frameId: 'restored-frame', loaderId: 'restored-loader' }))
    f.responses.set('Runtime.evaluate', () => ({
      result: { type: 'object', value: { url: retainedUrl, title: 'restored page' } }
    }))
    f.hooks.set('Page.navigate', () => {
      f.emit('Page.frameNavigated', {
        frame: { id: 'restored-frame', loaderId: 'restored-loader', url: retainedUrl }
      }, 'restored-session')
      f.emit('Page.lifecycleEvent', {
        frameId: 'restored-frame', loaderId: 'restored-loader', name: 'load'
      }, 'restored-session')
      emitPaused(f, 'bootstrap-request', 'restored-session')
    })
    helper = await helperServer(freshEpoch.helper.socketPath, ({ action, script }) => {
      if (action !== 'evaluate') return
      const label = /sourceURL=([^\n]+)/.exec(String(script))?.[1]
      if (label) f.emit('Debugger.scriptParsed', { url: label }, 'restored-session')
    })
    const ensureBinding = Reflect.get(f.runtime, 'ensureBinding') as (
      epoch: FakeEpoch, page: BrowserPage, generation: number
    ) => Promise<FakeBinding>
    const restored = await ensureBinding.call(f.runtime, freshEpoch, retainedPage, f.runtime.generation(pageId))

    expect(restored.runtime.intercepts).not.toBe(oldLedger)
    expect(restored.runtime.intercepts.suspended).toBe(false)
    expect(restored.runtime.intercepts.list()).toEqual([])
    expect(f.commands.some(({ method, params, sessionId }) =>
      method === 'Fetch.continueRequest' && params.requestId === 'bootstrap-request' && sessionId === 'restored-session')).toBe(true)
    emitPaused(f, 'after-restore-request', 'restored-session')
    expect(restored.runtime.intercepts.list().map(({ id }) => id)).toEqual(['after-restore-request'])
    expect(f.runtime.interceptSnapshot(pageId)).toEqual({
      patterns: ['*held*'], requests: [expect.objectContaining({ id: 'after-restore-request' })]
    })
    expect(f.spawns).toBe(0)
  } finally {
    await helper?.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('profile maintenance awaits binding aborts before closing the browser epoch', async () => {
  const f = releaseFixture()
  const abortGate = deferred()
  const browserCloseStarted = deferred<void>()
  let maintenance: Promise<void> | undefined
  try {
    await enableRoute(f)
    holdRequests(f, ['held-during-maintenance'])
    f.gates.set('Fetch.failRequest:held-during-maintenance', abortGate.promise)
    f.hooks.set('Browser.close', () => browserCloseStarted.resolve())

    maintenance = f.runtime.withProfileMaintenance(f.page.profileId, async () => {})
    expect(f.commands.filter(({ method }) => method === 'Fetch.failRequest')).toEqual([{
      method: 'Fetch.failRequest',
      params: { requestId: 'held-during-maintenance', errorReason: 'Aborted' },
      sessionId: 'owned-session',
      timeoutMs: 5_000
    }])
    expect(f.commands.filter(({ method }) => method === 'Browser.close')).toEqual([])
    expect(f.runtimePage.intercepts.discarded).toBe(true)

    abortGate.resolve({})
    await browserCloseStarted.promise
    await maintenance
    expect(f.commands.findIndex(({ method }) => method === 'Browser.close'))
      .toBeGreaterThan(f.commands.findIndex(({ method, params }) =>
        method === 'Fetch.failRequest' && params.requestId === 'held-during-maintenance'))
    expect(f.runtimePage.intercepts.list()).toEqual([])
  } finally {
    abortGate.resolve({})
    await maintenance?.catch(() => {})
    rmSync(f.root, { recursive: true, force: true })
  }
})
