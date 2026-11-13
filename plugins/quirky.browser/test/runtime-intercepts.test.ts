import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { BrowserStore } from '../src/profiles/store'
import type { CdpEvent } from '../src/runtime/cdp'
import { BrowserRuntime, type PageCdp, type PaneWatchCallbacks, type RuntimePageState } from '../src/runtime/driver'
import { BrowserExtraActions } from '../src/runtime/extras-actions'
import { InterceptLedger } from '../src/runtime/intercept'

type Command = { method: string; params: Record<string, unknown>; sessionId?: string; timeoutMs?: number }

function releaseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-intercept-release-'))
  const store = new BrowserStore(root)
  const page = store.addPage({ profileId: 'default', worktreeId: null, url: 'about:blank', title: '' })
  const invalidated: string[] = []
  const runtime = new BrowserRuntime(store, {
    runtimeRoot: root,
    spawn: () => { throw new Error('a refused continuation must not start another browser') }
  }, (id) => { invalidated.push(id) })
  const commands: Command[] = []
  const refusals: string[] = []
  const teardown: string[] = []
  const listeners = new Map<string, Set<(event: CdpEvent) => void>>()
  const cdp: PageCdp & { close(): void } = {
    async send(method, params = {}, sessionId, timeoutMs) {
      commands.push({ method, params, sessionId, timeoutMs })
      if (method === 'Fetch.continueRequest' && params.requestId === 'refused-request') {
        refusals.push(String(params.requestId))
        throw new Error('Fetch.continueRequest: Invalid InterceptionId.')
      }
      if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'epoch remains usable' } }
      return {}
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
  const epoch = {
    id: 'owned-epoch', profileId: page.profileId, invalid: false, stopping: false, cdp,
    activeTabId: binding.tabId, pages: new Map([[page.browserPageId, binding]]),
    helper: {
      socketPath: join(root, 'helper.sock'), socketDir: join(root, 'sockets'), socketAliasRoot: join(root, 'aliases'),
      async asyncClose() { teardown.push('helper') }
    },
    chrome: { profileRoot: join(root, 'chrome'), async asyncClose() { teardown.push('chrome') } }
  }
  // reuse the per-instance fake-epoch seam so no module mocks or real Chrome races can hide the refusal
  Reflect.set(Reflect.get(runtime, 'profile').call(runtime, page.profileId), 'epoch', epoch)
  const actions = new BrowserExtraActions(store, runtime, () => { throw new Error('unexpected element operation') })
  return { root, page, runtime, runtimePage, epoch, actions, commands, refusals, invalidated, teardown }
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
