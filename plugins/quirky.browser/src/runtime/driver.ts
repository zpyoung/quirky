import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { validateValue, type Schema } from '@quirky/protocol'
import { fault, BrowserFault } from './errors'
import { CdpConnection, type CdpEvent } from './cdp'
import { startChrome, type OwnedChrome } from './chrome'
import { FifoLock } from './lock'
import { nativeData } from './native-response'
import { NativeTransportError, nativeRequest, startNativeHelper, type NativeHelper, type NativeResponse } from './native'
import type { BrowserDependencies, BrowserTestControl } from './dependencies'
import type { BrowserPage } from '../profiles/store'
import type { PaneViewport } from '../pane-contract'
import { BrowserStore } from '../profiles/store'


export type RuntimeBinding = {
  browserEpoch: string
  pageGeneration: number
  targetId: string
  sessionId: string
  tabId: string
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }


export type NavigationEvent =
  | { kind: 'frame'; frameId: string; loaderId?: string; url: string }
  | { kind: 'same-document'; frameId: string; url: string }
  | { kind: 'lifecycle'; frameId: string; loaderId: string; name: string }
  | { kind: 'document-request'; requestId: string; frameId: string; loaderId: string }
  | { kind: 'loading-failed'; requestId: string; errorText: string }

export type NavigationTracker = {
  frameId: string
  previousLoaderId?: string
  previousUrl: string
  events: NavigationEvent[]
  notify?: () => void
  signal?: AbortSignal
  termination?: Promise<void>
}

export type RuntimePageState = {
  binding: RuntimeBinding
  navigationReady?: boolean
  mainFrameId?: string
  mainFrameLoaderId?: string
  mainFrameUrl?: string
  pendingNavigation?: NavigationTracker
  termination?: Promise<void>
  finishTermination?: () => void
}

export type PageCdp = Pick<CdpConnection, 'send' | 'subscribe'>
export type PageExecution = {
  page: BrowserPage
  cdp: PageCdp
  binding: RuntimeBinding
  runtimePage: RuntimePageState
  signal?: AbortSignal
  native(action: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<NativeResponse>
}
export type PaneInput = {
  kind: 'mouse' | 'key' | 'text' | 'wheel'
  type?: string
  x?: number
  y?: number
  button?: string
  key?: string
  code?: string
  text?: string
  deltaX?: number
  deltaY?: number
  modifiers?: number
}

export type PaneControl = {
  action: 'back' | 'forward' | 'reload' | 'hardReload' | 'stop' | 'find' | 'zoom' | 'viewport'
  text?: string
  forward?: boolean
  level?: number
  preset?: PaneViewport
  findCurrent?: number
}

export type PaneControlResult = {
  url?: string
  title?: string
  canGoBack?: boolean
  canGoForward?: boolean
  found?: boolean
  total?: number
}

export type RuntimePanePrompt = {
  id: string
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload' | 'auth' | 'certificate' | 'external'
  origin: string
  message: string
  defaultValue?: string
  canProceed?: boolean
  respond(input: { accept: boolean; text?: string; username?: string; password?: string }): Promise<void>
}

export type RuntimePaneDownloadStart = { guid: string; url: string; suggestedFilename: string; stagingPath: string }
export type RuntimePaneDownloadProgress = { guid: string; state: string; received: number; total?: number }
export type RuntimePanePopup = { targetId: string; url: string; windowName: string; hasOpener: boolean; openerFrameId?: string }

export type PaneWatchCallbacks = {
  onFrame(frame: { data: string; width: number; height: number }): void
  onPrompt(prompt: RuntimePanePrompt): void
  onDownloadStart(download: RuntimePaneDownloadStart): void
  onDownloadProgress(progress: RuntimePaneDownloadProgress): void
  onLocation(page: BrowserPage): void
  onPopup?(popup: RuntimePanePopup): boolean | Promise<boolean>
  onIssue(reason: string): void
  onStale(reason: string): void
}


export type NavigationResult = { url: string; title: string; errorText?: string }

type BoundPage = {
  pageId: string
  tabId: string
  targetId: string
  sessionId: string
  generation: number
  runtime: RuntimePageState
}

type RuntimeEpoch = {
  id: string
  profileId: string
  chrome: OwnedChrome
  helper: NativeHelper
  cdp: CdpConnection
  pages: Map<string, BoundPage>
  activeTabId?: string
  invalid: boolean
  stopping: boolean
  teardown?: Promise<void>
}
type PaneWatchState = {
  watchId: string
  pageId: string
  generation: number
  epoch: RuntimeEpoch
  binding: BoundPage
  callbacks: PaneWatchCallbacks
  subscriptions: (() => void)[]
  downloads: Set<string>
  downloadSubscriptions: (() => void)[]
  popups: number[]
  frameWidth?: number
  frameHeight?: number
  stopped: boolean
}

type ProfileRuntime = {
  lock: FifoLock
  epoch?: RuntimeEpoch
  starting?: Promise<RuntimeEpoch>
  lossReported: boolean
  failureReason?: string
  controllers: Map<string, Set<AbortController>>
}

type TargetInfo = { targetId: string; type: string }
type TabCreated = { tabId: string }
type Attached = { sessionId: string }

const TARGET_LIST_SCHEMA: Schema = {
  type: 'object',
  properties: {
    targetInfos: {
      type: 'array',
      items: {
        type: 'object',
        properties: { targetId: { type: 'string' }, type: { type: 'string' } },
        required: ['targetId', 'type'],
        additionalProperties: true
      }
    }
  },
  required: ['targetInfos'],
  additionalProperties: true
}

const ATTACHED_SCHEMA: Schema = {
  type: 'object',
  properties: { sessionId: { type: 'string' } },
  required: ['sessionId'],
  additionalProperties: true
}

const TAB_CREATED_SCHEMA: Schema = {
  type: 'object',
  properties: { tabId: { type: 'string' }, label: {}, url: { type: 'string' }, total: { type: 'integer' } },
  required: ['tabId'],
  additionalProperties: true
}

const TAB_SWITCH_SCHEMA: Schema = {
  type: 'object',
  properties: { tabId: { type: 'string' }, label: {}, title: { type: 'string' }, url: { type: 'string' } },
  required: ['tabId'],
  additionalProperties: true
}



const EVENT_NETWORK_REQUEST_SCHEMA: Schema = {
  type: 'object',
  properties: { requestId: { type: 'string' }, request: { type: 'object' } },
  required: ['requestId', 'request'],
  additionalProperties: true
}


function safeRecord(value: unknown, schema: Schema, description: string): Record<string, unknown> {
  const failure = validateValue(schema, value, description)
  if (failure) throw fault('browser_tab_changed', `native browser returned malformed ${description}`)
  return value as Record<string, unknown>
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}



function cdpTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes('websocket') || message.includes('timed out') || message.includes('malformed json') || message.includes('malformed envelope') || message.includes('50 mib frame')
}

export class BrowserRuntime {
  private readonly profiles = new Map<string, ProfileRuntime>()
  private readonly generations = new Map<string, number>()
  private readonly closingTargets = new Set<string>()
  private readonly closingPages = new Set<string>()
  private readonly paneWatches = new Map<string, PaneWatchState>()
  private readonly paneWatchesByPage = new Map<string, string>()
  private readonly paneDownloadOwners = new Map<string, { profileId: string; pageId: string; epochId: string }>()

  constructor(
    private readonly store: BrowserStore,
    private readonly dependencies: BrowserDependencies,
    private readonly onPageInvalidated: (pageId: string) => void
  ) {
    for (const page of store.listPages()) this.generations.set(page.browserPageId, 0)
    this.dependencies.onControl?.(this.testControl())
  }
  private testControl(): BrowserTestControl {
    return {
      crashHelper: async (profileId) => {
        const epoch = this.profile(profileId).epoch
        if (!epoch) throw fault('browser_error', 'no owned browser helper is running for that profile')
        epoch.helper.child.kill('SIGKILL')
        await epoch.helper.child.exited
      }
    }
  }

  generation(pageId: string): number {
    return this.generations.get(pageId) ?? 0
  }

  invalidatePage(pageId: string, preserveBinding = true): number {
    const generation = this.generation(pageId) + 1
    this.generations.set(pageId, generation)
    this.onPageInvalidated(pageId)
    for (const profile of this.profiles.values()) {
      const binding = profile.epoch?.pages.get(pageId)
      if (!binding) continue
      if (preserveBinding) {
        binding.generation = generation
        binding.runtime.binding.pageGeneration = generation
      } else profile.epoch?.pages.delete(pageId)
      const watchId = this.paneWatchesByPage.get(pageId)
      const watch = watchId ? this.paneWatches.get(watchId) : undefined
      if (!watch) continue
      if (
        preserveBinding && !this.closingPages.has(pageId) && !profile.epoch?.invalid &&
        watch.binding.sessionId === binding.sessionId && watch.binding.targetId === binding.targetId
      ) {
        watch.generation = generation
        watch.binding.generation = generation
        watch.binding.runtime.binding.pageGeneration = generation
      } else {
        void this.endPaneWatch(watch, 'The managed page identity changed or closed.')
      }
    }
    return generation
  }


  async withPage<T>(page: BrowserPage, method: string, operation: (execution: PageExecution) => Promise<T>): Promise<T> {
    const profile = this.profile(page.profileId)
    const expectedGeneration = this.generation(page.browserPageId)
    const controller = new AbortController()
    const controllers = profile.controllers.get(page.browserPageId) ?? new Set<AbortController>()
    controllers.add(controller)
    profile.controllers.set(page.browserPageId, controllers)
    try {
      return await profile.lock.run(async () => {
        if (this.closingPages.has(page.browserPageId)) throw fault('browser_tab_closed', 'the managed page is closing')
        let current: BrowserPage
        try { current = this.store.getPage(page.browserPageId) } catch { throw fault('browser_tab_closed', 'the managed page was closed before the operation ran') }
        if (current.profileId !== page.profileId) throw fault('browser_tab_changed', 'the managed page changed browser profiles before the operation ran')
        if (this.generation(page.browserPageId) !== expectedGeneration) throw fault('browser_tab_changed', 'the managed page changed before the operation ran')
        const epoch = await this.ensureEpoch(profile, page.profileId)
        const binding = await this.ensureBinding(epoch, current, this.generation(page.browserPageId))
        if (epoch.activeTabId !== binding.tabId) {
          this.invalidateHelperReferences(epoch)
          // Resume the exact owned headless target before the helper opens its fresh
          // CDP session; a background target can otherwise stall Page.enable.
          await epoch.cdp.send('Page.bringToFront', {}, binding.sessionId, 5_000)
          let switched: NativeResponse
          try {
            switched = await nativeRequest(epoch.helper.socketPath, 'tab_switch', { tabId: binding.tabId }, 90_000, controller.signal)
          } catch (error) {
            if (controller.signal.aborted) await binding.runtime.termination
            throw error
          }
          if (!switched.success) throw new NativeTransportError('browser_tab_changed', `native helper lost the managed tab mapping: ${switched.error ?? 'no error detail'}`)
          const switchedData = safeRecord(switched.data, TAB_SWITCH_SCHEMA, 'tab switch result')
          if (switchedData.tabId !== binding.tabId) throw new NativeTransportError('browser_tab_changed', 'native helper selected an unexpected tab')
          epoch.activeTabId = binding.tabId
        }
        this.dependencies.onOperation?.({ pageId: page.browserPageId, method })
        const execution = this.execution(current, epoch, binding, controller.signal)
        let result: T
        try {
          result = await operation(execution)
        } catch (error) {
          if (controller.signal.aborted) await binding.runtime.termination
          throw error
        }
        if (this.closingPages.has(page.browserPageId)) {
          await binding.runtime.termination
          throw fault('browser_tab_closed', 'the managed page was closed during the operation')
        }
        if (epoch.invalid || this.generation(page.browserPageId) !== expectedGeneration) throw fault('browser_tab_changed', 'browser page identity changed during the operation')
        return result
      }, controller.signal)
    } catch (error) {
      if (this.closingPages.has(page.browserPageId)) throw fault('browser_tab_closed', 'the managed page was closed during the operation')
      const transportFailure = this.profileTransportFailure(profile, error)
      if (transportFailure) throw transportFailure
      throw error
    } finally {
      controllers.delete(controller)
      if (controllers.size === 0) profile.controllers.delete(page.browserPageId)
    }
  }
  async paneNavigate(page: BrowserPage, url: string): Promise<NavigationResult> {
    return await this.withPage(page, 'paneNavigate', (execution) => this.navigate(execution, url))
  }

  async paneInput(page: BrowserPage, input: PaneInput, watchId: string): Promise<void> {
    const watch = this.paneWatches.get(watchId)
    if (!watch || watch.pageId !== page.browserPageId || !this.isCurrentPaneWatch(watch)) {
      throw fault('browser_tab_changed', 'typed input requires the current exact Watch page binding')
    }
    await this.withPage(page, 'paneInput', async (execution) => {
      if (execution.binding.targetId !== watch.binding.targetId || execution.binding.sessionId !== watch.binding.sessionId) {
        throw fault('browser_tab_changed', 'typed input target no longer matches the displayed Watch frame')
      }
      const params: Record<string, unknown> = {}
      if (input.kind === 'text') {
        if (typeof input.text !== 'string' || input.text.length === 0 || Buffer.byteLength(input.text, 'utf8') > 64 * 1024) {
          throw fault('invalid_argument', 'text input must contain 1 to 65,536 UTF-8 bytes')
        }
        await execution.cdp.send('Input.insertText', { text: input.text }, execution.binding.sessionId)
        return
      }
      if (input.modifiers !== undefined && (!Number.isInteger(input.modifiers) || input.modifiers < 0 || input.modifiers > 15)) {
        throw fault('invalid_argument', 'input modifiers must be a bitmask between 0 and 15')
      }
      if (input.kind === 'mouse' || input.kind === 'wheel') {
        if (typeof input.x !== 'number' || !Number.isFinite(input.x) || input.x < 0 || input.x > 16_384 ||
            typeof input.y !== 'number' || !Number.isFinite(input.y) || input.y < 0 || input.y > 16_384 ||
            typeof watch.frameWidth !== 'number' || typeof watch.frameHeight !== 'number' ||
            input.x >= watch.frameWidth || input.y >= watch.frameHeight) {
          throw fault('invalid_argument', 'pointer coordinates must be within the last displayed browser frame')
        }
        params.x = input.x
        params.y = input.y
        if (input.kind === 'wheel') {
          if (typeof input.deltaX !== 'number' || !Number.isFinite(input.deltaX) ||
              typeof input.deltaY !== 'number' || !Number.isFinite(input.deltaY)) {
            throw fault('invalid_argument', 'wheel input requires finite deltaX and deltaY')
          }
          params.type = 'mouseWheel'
          params.deltaX = input.deltaX
          params.deltaY = input.deltaY
        } else {
          if (input.type !== 'mousePressed' && input.type !== 'mouseReleased' && input.type !== 'mouseMoved') {
            throw fault('invalid_argument', 'mouse type must be mousePressed, mouseReleased, or mouseMoved')
          }
          if (input.type !== 'mouseMoved' && !['left', 'middle', 'right', 'back', 'forward'].includes(input.button ?? '')) {
            throw fault('invalid_argument', 'pressed mouse input requires a supported button')
          }
          if (input.button !== undefined) params.button = input.button
          if (input.type === 'mousePressed' || input.type === 'mouseReleased') params.clickCount = 1
          params.type = input.type
        }
      } else {
        if (input.type !== 'keyDown' && input.type !== 'keyUp' && input.type !== 'char') {
          throw fault('invalid_argument', 'key type must be keyDown, keyUp, or char')
        }
        if (typeof input.key !== 'string' || input.key.length === 0 || input.key.length > 128) {
          throw fault('invalid_argument', 'key input requires a key of at most 128 characters')
        }
        params.type = input.type
        params.key = input.key
        if (input.code !== undefined) params.code = input.code
        if (input.type === 'char' && input.text !== undefined) params.text = input.text
        if (input.modifiers !== undefined) params.modifiers = input.modifiers
        await execution.cdp.send('Input.dispatchKeyEvent', params, execution.binding.sessionId)
        return
      }
      if (input.modifiers !== undefined) params.modifiers = input.modifiers
      await execution.cdp.send('Input.dispatchMouseEvent', params, execution.binding.sessionId)
    })
  }

  async paneControl(page: BrowserPage, control: PaneControl): Promise<PaneControlResult> {
    return await this.withPage(page, 'paneControl', async (execution) => {
      const sessionId = execution.binding.sessionId
      if (control.action === 'back' || control.action === 'forward') {
        const history = safeRecord(await execution.cdp.send('Page.getNavigationHistory', {}, sessionId), {
          type: 'object',
          properties: { currentIndex: { type: 'integer' }, entries: { type: 'array', items: { type: 'object', additionalProperties: true } } },
          required: ['currentIndex', 'entries'],
          additionalProperties: true
        }, 'navigation history')
        const entries = history.entries as unknown[]
        const index = history.currentIndex as number
        const destination = entries[index + (control.action === 'back' ? -1 : 1)]
        if (destination !== undefined) {
          const entry = safeRecord(destination, {
            type: 'object',
            properties: { id: { type: 'integer' }, url: { type: 'string' } },
            required: ['id', 'url'],
            additionalProperties: true
          }, 'navigation entry')
          await this.navigateHistoryEntry(execution, entry.id as number, entry.url as string)
        }
      } else if (control.action === 'reload' || control.action === 'hardReload') {
        await this.reloadPage(execution, control.action === 'hardReload')
      } else if (control.action === 'stop') {
        await execution.cdp.send('Page.stopLoading', {}, sessionId)
      } else if (control.action === 'find') {
        const text = control.text ?? ''
        if (text.length === 0) {
          await execution.cdp.send('Runtime.evaluate', {
            expression: 'window.getSelection()?.removeAllRanges(); true',
            returnByValue: true
          }, sessionId)
          return { found: false, total: 0 }
        }
        const backward = control.forward === false
        // DOM.performSearch counts matching nodes, not occurrences within a node.
        const expression = `(() => {
          const q = ${JSON.stringify(text)}.toLowerCase();
          const content = (document.body?.innerText ?? '').toLowerCase();
          let total = 0, offset = 0;
          while ((offset = content.indexOf(q, offset)) !== -1) { total++; offset += q.length; }
          return { found: window.find(${JSON.stringify(text)}, false, ${backward}, true, false, true, false), total };
        })()`
        const evaluated = objectValue(await execution.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId))
        const result = objectValue(evaluated?.result)
        const value = objectValue(result?.value)
        if (evaluated?.exceptionDetails !== undefined || !value || typeof value.found !== 'boolean' ||
            typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0) {
          throw fault('browser_error', 'page find returned an invalid occurrence count')
        }
        return { found: value.found, total: value.total }
      } else if (control.action === 'zoom') {
        if (typeof control.level !== 'number' || !Number.isFinite(control.level)) throw fault('invalid_argument', 'zoom level must be finite')
        const level = Math.max(-3, Math.min(5, Math.round(control.level * 2) / 2))
        const scale = 1.2 ** level
        const expression = `(() => { if (document.documentElement) document.documentElement.style.zoom = ${JSON.stringify(String(scale))}; return true; })()`
        await execution.cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
      } else {
        const preset = control.preset
        if (preset === undefined) throw fault('invalid_argument', 'viewport control requires a preset')
        if (preset === 'default') {
          await execution.cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId)
          await execution.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }, sessionId)
        } else {
          const dimensions: Record<Exclude<PaneViewport, 'default'>, { width: number; height: number }> = {
            'mobile-s': { width: 320, height: 568 },
            'mobile-m': { width: 375, height: 667 },
            'mobile-l': { width: 425, height: 812 },
            tablet: { width: 768, height: 1024 },
            laptop: { width: 1024, height: 768 },
            'laptop-l': { width: 1440, height: 900 },
            desktop: { width: 1920, height: 1080 }
          }
          const { width, height } = dimensions[preset]
          const mobile = preset === 'mobile-s' || preset === 'mobile-m' || preset === 'mobile-l' || preset === 'tablet'
          await execution.cdp.send('Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor: mobile ? 2 : 1, mobile
          }, sessionId)
          await execution.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile }, sessionId)
        }
      }
      const location = await this.pageLocation(execution)
      const history = safeRecord(await execution.cdp.send('Page.getNavigationHistory', {}, sessionId), {
        type: 'object',
        properties: { currentIndex: { type: 'integer' }, entries: { type: 'array' } },
        required: ['currentIndex', 'entries'],
        additionalProperties: true
      }, 'navigation history')
      const entries = history.entries as unknown[]
      const index = history.currentIndex as number
      return {
        ...location,
        canGoBack: index > 0,
        canGoForward: index >= 0 && index < entries.length - 1
      }
    })
  }
  private async navigateHistoryEntry(execution: PageExecution, entryId: number, url: string): Promise<void> {
    const tracker = this.beginNavigation(execution)
    let match: { frameId: string; loaderId?: string; url?: string } | undefined
    try {
      await execution.cdp.send('Page.navigateToHistoryEntry', { entryId }, execution.binding.sessionId)
      if (url !== tracker.previousUrl) {
        const event = await this.waitForNavigationEvent(tracker, (events) => events.find((candidate) =>
          (candidate.kind === 'frame' || candidate.kind === 'same-document') &&
          candidate.frameId === tracker.frameId && candidate.url === url
        ), 30_000, `navigation to ${url} timed out`)
        if (event.kind === 'frame') {
          match = { frameId: event.frameId, ...(event.loaderId ? { loaderId: event.loaderId } : {}) }
        } else if (event.kind === 'same-document') {
          match = { frameId: event.frameId, url: event.url }
        }
      }
      await this.pageLocation(execution)
    } finally {
      this.finishNavigation(execution, tracker, match)
    }
  }

  private async reloadPage(execution: PageExecution, ignoreCache: boolean): Promise<void> {
    const tracker = this.beginNavigation(execution)
    let match: { frameId: string; loaderId?: string; url?: string } | undefined
    const timeoutMs = 30_000
    const startedAt = Date.now()
    try {
      await execution.cdp.send('Page.reload', { ignoreCache }, execution.binding.sessionId, timeoutMs)
      const navigation = await this.waitForNavigationEvent(
        tracker,
        (events) => events.find((event) =>
          event.kind === 'frame' &&
          event.frameId === tracker.frameId &&
          event.loaderId !== undefined &&
          event.loaderId !== tracker.previousLoaderId
        ),
        Math.max(0, timeoutMs - (Date.now() - startedAt)),
        'reload did not navigate to a new main-frame document'
      )
      if (navigation.kind !== 'frame' || !navigation.loaderId) {
        throw fault('browser_tab_changed', 'reload did not establish a new main-frame document')
      }
      match = { frameId: navigation.frameId, loaderId: navigation.loaderId }
      const loaded = await this.waitForDocumentLoad(
        tracker,
        navigation.frameId,
        navigation.loaderId,
        Math.max(0, timeoutMs - (Date.now() - startedAt))
      )
      if (loaded.kind === 'loading-failed') throw fault('browser_error', `reload failed: ${loaded.errorText}`)
      await this.pageLocation(execution)
    } finally {
      this.finishNavigation(execution, tracker, match)
    }
  }

  async startPaneWatch(page: BrowserPage, watchId: string, callbacks: PaneWatchCallbacks): Promise<RuntimeBinding> {
    if (this.paneWatchesByPage.has(page.browserPageId)) throw fault('browser_error', 'this managed page already has an active Watch lease')
    return await this.withPage(page, 'paneWatch', async (execution) => {
      const profile = this.profile(page.profileId)
      const epoch = profile.epoch
      const binding = epoch?.pages.get(page.browserPageId)
      if (!epoch || epoch.invalid || !binding || binding.sessionId !== execution.binding.sessionId) {
        throw fault('browser_tab_changed', 'the exact managed page binding is no longer available')
      }
      const state: PaneWatchState = {
        watchId,
        pageId: page.browserPageId,
        generation: execution.binding.pageGeneration,
        epoch,
        binding,
        callbacks,
        subscriptions: [],
        downloadSubscriptions: [],
        downloads: new Set(),
        popups: [],
        stopped: false
      }
      this.paneWatches.set(watchId, state)
      this.paneWatchesByPage.set(page.browserPageId, watchId)
      const sessionId = binding.sessionId
      const subscribePage = (method: string, handler: (event: CdpEvent) => void) => {
        state.subscriptions.push(epoch.cdp.subscribe(method, (event) => {
          if (event.sessionId === sessionId && this.isCurrentPaneWatch(state)) handler(event)
        }))
      }
      try {
        subscribePage('Fetch.requestPaused', (event) => {
          const requestId = asString(event.params.requestId)
          if (!requestId) {
            void this.endPaneWatch(state, 'Watch received an invalid intercepted request.')
            return
          }
          // Authentication interception pauses ordinary requests too. Resume on this exact
          // session outside the profile FIFO held by the pending navigation.
          void epoch.cdp.send('Fetch.continueRequest', { requestId }, sessionId, 5_000)
            .catch(() => this.endPaneWatch(state, 'Watch could not resume an intercepted request.'))
        })
        const downloadDir = join(this.store.dataDir, 'pane-downloads', page.profileId)
        mkdirSync(downloadDir, { recursive: true, mode: 0o700 })
        subscribePage('Page.screencastFrame', (event) => {
          const frameId = event.params.sessionId
          const data = asString(event.params.data)
          const metadata = event.params.metadata
          const record = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
            ? metadata as Record<string, unknown>
            : {}
          void epoch.cdp.send('Page.screencastFrameAck', { sessionId: frameId }, sessionId, 5_000).then(() => {
            if (!this.isCurrentPaneWatch(state) || !data) return
            const width = typeof record.deviceWidth === 'number' ? record.deviceWidth : record.sourceWidth
            const height = typeof record.deviceHeight === 'number' ? record.deviceHeight : record.sourceHeight
            if (typeof width !== 'number' || !Number.isFinite(width) || width < 1 ||
                typeof height !== 'number' || !Number.isFinite(height) || height < 1) return
            state.frameWidth = width
            state.frameHeight = height
            try { callbacks.onFrame({ data, width, height }) } catch { /* the latest-frame sink may have closed */ }
          }).catch(() => this.endPaneWatch(state, 'The Watch screencast transport was lost.'))
        })
        subscribePage('Page.javascriptDialogOpening', (event) => this.emitJavaScriptPrompt(state, event))
        subscribePage('Fetch.authRequired', (event) => this.emitAuthPrompt(state, event))
        subscribePage('Fetch.requestPaused', (event) => {
          const requestId = asString(event.params.requestId)
          if (!requestId) return
          void epoch.cdp.send('Fetch.continueRequest', { requestId }, sessionId, 5_000)
            .catch(() => this.endPaneWatch(state, 'The Watch request transport was lost.'))
        })
        subscribePage('Security.certificateError', (event) => this.emitCertificatePrompt(state, event))
        subscribePage('Page.windowOpen', (event) => this.emitExternalPrompt(state, event))
        subscribePage('Page.frameNavigated', (event) => {
          const value = event.params.frame
          if (typeof value !== 'object' || value === null || Array.isArray(value) || (value as Record<string, unknown>).parentId !== undefined) return
          try { callbacks.onLocation(this.store.getPage(page.browserPageId)) } catch { /* the page was removed during navigation */ }
        })
        subscribePage('Page.navigatedWithinDocument', () => {
          try { callbacks.onLocation(this.store.getPage(page.browserPageId)) } catch { /* the page was removed during navigation */ }
        })
        subscribePage('Page.lifecycleEvent', (event) => {
          if (event.params.name === 'load') void this.refreshPaneLocation(state)
        })
        state.downloadSubscriptions.push(epoch.cdp.subscribe('Browser.downloadWillBegin', (event) => {
          if (!this.isCurrentPaneWatch(state)) return
          const frameId = asString(event.params.frameId)
          const guid = asString(event.params.guid)
          const url = asString(event.params.url)
          if (!frameId || frameId !== binding.runtime.mainFrameId || !guid || !url) return
          state.downloads.add(guid)
          this.paneDownloadOwners.set(guid, { profileId: page.profileId, pageId: page.browserPageId, epochId: epoch.id })
          callbacks.onDownloadStart({
            guid,
            url,
            suggestedFilename: asString(event.params.suggestedFilename) ?? 'download',
            stagingPath: join(this.store.dataDir, 'pane-downloads', page.profileId, guid)
          })
        }))
        state.downloadSubscriptions.push(epoch.cdp.subscribe('Browser.downloadProgress', (event) => {
          const guid = asString(event.params.guid)
          if (!guid || !state.downloads.has(guid) || state.epoch.invalid) return
          const status = asString(event.params.state) ?? 'inProgress'
          callbacks.onDownloadProgress({
            guid,
            state: status,
            received: typeof event.params.receivedBytes === 'number' ? event.params.receivedBytes : 0,
            ...(typeof event.params.totalBytes === 'number' ? { total: event.params.totalBytes } : {})
          })
          if (status === 'completed' || status === 'canceled' || status === 'interrupted') {
            state.downloads.delete(guid)
            this.paneDownloadOwners.delete(guid)
            if (state.stopped && state.downloads.size === 0) this.clearDownloadSubscriptions(state)
          }
        }))
        state.subscriptions.push(epoch.cdp.subscribe('Target.targetCreated', (event) => {
          if (!this.isCurrentPaneWatch(state)) return
          const target = event.params.targetInfo
          if (typeof target !== 'object' || target === null || Array.isArray(target)) return
          const info = target as Record<string, unknown>
          const targetId = asString(info.targetId)
          if (!targetId || info.type !== 'page' || info.openerId !== binding.targetId) return
          const now = Date.now()
          state.popups = state.popups.filter((openedAt) => now - openedAt < 2_000)
          state.popups.push(now)
          const url = asString(info.url) ?? 'about:blank'
          if (state.popups.length > 4) {
            void epoch.cdp.send('Target.closeTarget', { targetId }, undefined, 5_000).catch(() => {})
            try { callbacks.onIssue('More than four page-created tabs opened within two seconds; excess popups were closed.') } catch { /* pane was closed */ }
            return
          }
          if (!/^https?:/i.test(url)) {
            void epoch.cdp.send('Target.closeTarget', { targetId }, undefined, 5_000).catch(() => {})
            return
          }
          void this.inspectPopup(epoch, targetId).then((details) => {
            if (!details || epoch.invalid || !this.isCurrentPaneWatch(state)) {
              if (!epoch.invalid) void epoch.cdp.send('Target.closeTarget', { targetId }, undefined, 5_000).catch(() => {})
              return
            }
            const handled = callbacks.onPopup?.({
              targetId,
              url,
              ...details,
              ...(typeof info.openerFrameId === 'string' ? { openerFrameId: info.openerFrameId } : {})
            })
            void Promise.resolve(handled).finally(() => {
              if (!epoch.invalid) void epoch.cdp.send('Target.closeTarget', { targetId }, undefined, 5_000).catch(() => {})
            }).catch(() => {})
          }).catch(() => {
            if (!epoch.invalid) void epoch.cdp.send('Target.closeTarget', { targetId }, undefined, 5_000).catch(() => {})
          })
        }))
        await epoch.cdp.send('Browser.setDownloadBehavior', {
          behavior: 'allowAndName',
          downloadPath: downloadDir,
          eventsEnabled: true
        })
        await epoch.cdp.send('Fetch.enable', { handleAuthRequests: true }, sessionId)
        await epoch.cdp.send('Security.enable', {}, sessionId)
        await epoch.cdp.send('Security.setOverrideCertificateErrors', { override: true }, sessionId)
        await epoch.cdp.send('Target.setDiscoverTargets', { discover: true })
        await epoch.cdp.send('Page.startScreencast', {
          format: 'jpeg',
          quality: 60,
          maxWidth: 1280,
          maxHeight: 900,
          everyNthFrame: 1
        }, sessionId)
        if (!this.isCurrentPaneWatch(state)) throw fault('browser_tab_changed', 'the managed page changed before Watch started')
        return this.publicBinding(epoch, binding)
      } catch (error) {
        await this.endPaneWatch(state)
        throw error
      }
    })
  }

  async stopPaneWatch(watchId: string): Promise<void> {
    const watch = this.paneWatches.get(watchId)
    if (!watch) throw fault('browser_tab_changed', 'the Watch lease is stale or already stopped')
    await this.endPaneWatch(watch)
  }

  async cancelPaneDownload(pageId: string, guid: string): Promise<void> {
    const owner = this.paneDownloadOwners.get(guid)
    if (!owner || owner.pageId !== pageId) throw fault('browser_tab_changed', 'the download no longer belongs to this managed page')
    const epoch = this.profile(owner.profileId).epoch
    if (!epoch || epoch.invalid || epoch.id !== owner.epochId) throw fault('browser_tab_changed', 'the download browser epoch is no longer active')
    await epoch.cdp.send('Browser.cancelDownload', { guid }, undefined, 5_000)
  }
  private isCurrentPaneWatch(watch: PaneWatchState): boolean {
    return !watch.stopped && !watch.epoch.invalid && !watch.epoch.stopping &&
      this.generation(watch.pageId) === watch.generation &&
      watch.epoch.pages.get(watch.pageId) === watch.binding &&
      watch.binding.generation === watch.generation
  }

  private async endPaneWatch(watch: PaneWatchState, reason?: string): Promise<void> {
    if (watch.stopped) return
    watch.stopped = true
    this.paneWatches.delete(watch.watchId)
    if (this.paneWatchesByPage.get(watch.pageId) === watch.watchId) this.paneWatchesByPage.delete(watch.pageId)
    for (const unsubscribe of watch.subscriptions) unsubscribe()
    if (watch.downloads.size === 0) this.clearDownloadSubscriptions(watch)
    if (!watch.epoch.invalid && !watch.epoch.stopping) {
      await Promise.allSettled([
        watch.epoch.cdp.send('Page.stopScreencast', {}, watch.binding.sessionId, 5_000),
        watch.epoch.cdp.send('Fetch.disable', {}, watch.binding.sessionId, 5_000),
        watch.epoch.cdp.send('Security.setOverrideCertificateErrors', { override: false }, watch.binding.sessionId, 5_000),
        watch.epoch.cdp.send('Security.disable', {}, watch.binding.sessionId, 5_000)
      ])
    }
    if (reason) {
      try { watch.callbacks.onStale(reason) } catch { /* the pane was removed while the lease ended */ }
    }
  }
  private clearDownloadSubscriptions(watch: PaneWatchState): void {
    for (const unsubscribe of watch.downloadSubscriptions) unsubscribe()
    watch.downloadSubscriptions = []
  }

  private async refreshPaneLocation(watch: PaneWatchState): Promise<void> {
    if (!this.isCurrentPaneWatch(watch)) return
    let page: BrowserPage
    try { page = this.store.getPage(watch.pageId) } catch { return }
    try {
      const location = await this.pageLocation(this.execution(page, watch.epoch, watch.binding))
      if (!this.isCurrentPaneWatch(watch)) return
      this.store.updatePage(watch.pageId, (record) => {
        record.url = location.url
        record.title = location.title
        record.loadError = null
      })
      watch.callbacks.onLocation(this.store.getPage(watch.pageId))
    } catch { /* a navigation or close won the race with the title read */ }
  }

  private originOf(value: string | undefined): string {
    if (!value) return 'unknown origin'
    try { return new URL(value).origin } catch { return 'unknown origin' }
  }

  private emitJavaScriptPrompt(watch: PaneWatchState, event: CdpEvent): void {
    const type = asString(event.params.type)
    if (type !== 'alert' && type !== 'confirm' && type !== 'prompt' && type !== 'beforeunload') return
    const prompt: RuntimePanePrompt = {
      id: randomUUID(),
      kind: type,
      origin: this.originOf(asString(event.params.url) ?? watch.binding.runtime.mainFrameUrl),
      message: asString(event.params.message) ?? '',
      ...(type === 'prompt' && typeof event.params.defaultPrompt === 'string' ? { defaultValue: event.params.defaultPrompt } : {}),
      respond: async (input) => {
        if (!this.isCurrentPaneWatch(watch)) throw fault('browser_tab_changed', 'the prompt belongs to a stale Watch lease')
        await watch.epoch.cdp.send('Page.handleJavaScriptDialog', {
          accept: input.accept,
          ...(type === 'prompt' && input.text !== undefined ? { promptText: input.text } : {})
        }, watch.binding.sessionId, 5_000)
      }
    }
    try { watch.callbacks.onPrompt(prompt) } catch {
      void prompt.respond({ accept: false }).catch(() => {})
    }
  }

  private emitAuthPrompt(watch: PaneWatchState, event: CdpEvent): void {
    const requestId = asString(event.params.requestId)
    const challenge = event.params.authChallenge
    if (!requestId || typeof challenge !== 'object' || challenge === null || Array.isArray(challenge)) return
    const info = challenge as Record<string, unknown>
    const origin = asString(info.origin) ?? this.originOf(watch.binding.runtime.mainFrameUrl)
    const realm = asString(info.realm)
    const prompt: RuntimePanePrompt = {
      id: randomUUID(),
      kind: 'auth',
      origin,
      message: realm ? `${origin} requests authentication for ${realm}.` : `${origin} requests authentication.`,
      respond: async (input) => {
        if (!this.isCurrentPaneWatch(watch)) throw fault('browser_tab_changed', 'the authentication prompt belongs to a stale Watch lease')
        const response = input.accept
          ? { response: 'ProvideCredentials', username: input.username ?? '', password: input.password ?? '' }
          : { response: 'CancelAuth' }
        await watch.epoch.cdp.send('Fetch.continueWithAuth', {
          requestId,
          authChallengeResponse: response
        }, watch.binding.sessionId, 5_000)
      }
    }
    try { watch.callbacks.onPrompt(prompt) } catch {
      void prompt.respond({ accept: false }).catch(() => {})
    }
  }

  private certificateHostIsLoopback(value: string): boolean {
    try {
      const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '')
      if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
      const octets = host.split('.')
      return octets.length === 4 && Number(octets[0]) === 127 &&
        octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    } catch {
      return false
    }
  }

  private emitCertificatePrompt(watch: PaneWatchState, event: CdpEvent): void {
    const eventId = event.params.eventId
    const requestUrl = asString(event.params.requestURL)
    if (typeof eventId !== 'number' || !requestUrl) return
    const canProceed = this.certificateHostIsLoopback(requestUrl)
    const prompt: RuntimePanePrompt = {
      id: randomUUID(),
      kind: 'certificate',
      origin: this.originOf(requestUrl),
      message: `The certificate for ${this.originOf(requestUrl)} could not be verified.`,
      canProceed,
      respond: async (input) => {
        if (!this.isCurrentPaneWatch(watch)) throw fault('browser_tab_changed', 'the certificate prompt belongs to a stale Watch lease')
        await watch.epoch.cdp.send('Security.handleCertificateError', {
          eventId,
          action: input.accept && canProceed ? 'continue' : 'cancel'
        }, watch.binding.sessionId, 5_000)
        if (input.accept && !canProceed) throw fault('invalid_argument', 'certificate exceptions may only proceed for loopback origins')
      }
    }
    try { watch.callbacks.onPrompt(prompt) } catch {
      void prompt.respond({ accept: false }).catch(() => {})
    }
  }

  private emitExternalPrompt(watch: PaneWatchState, event: CdpEvent): void {
    const url = asString(event.params.url)
    if (!url || event.params.userGesture !== true) return
    let protocol = ''
    try { protocol = new URL(url).protocol } catch { return }
    if (protocol === 'http:' || protocol === 'https:' || protocol !== 'mailto:') return
    const origin = this.originOf(watch.binding.runtime.mainFrameUrl)
    const prompt: RuntimePanePrompt = {
      id: randomUUID(),
      kind: 'external',
      origin,
      message: `${origin} requested opening an email link in another app.`,
      respond: async (input) => {
        if (!this.isCurrentPaneWatch(watch)) throw fault('browser_tab_changed', 'the external-app prompt belongs to a stale Watch lease')
        if (!input.accept) return
        if (process.platform !== 'darwin') throw fault('browser_unavailable', 'external-app launching is supported only on macOS')
        Bun.spawn(['open', url], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref()
      }
    }
    try { watch.callbacks.onPrompt(prompt) } catch { /* without an attached pane no external app is launched */ }
  }

  private async inspectPopup(epoch: RuntimeEpoch, targetId: string): Promise<{ windowName: string; hasOpener: boolean } | undefined> {
    let sessionId: string | undefined
    try {
      const attached = safeRecord(await epoch.cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, 5_000), ATTACHED_SCHEMA, 'popup target attachment')
      sessionId = attached.sessionId as string
      await epoch.cdp.send('Runtime.enable', {}, sessionId, 5_000)
      const response = objectValue(await epoch.cdp.send('Runtime.evaluate', {
        expression: '({ windowName: window.name, hasOpener: window.opener !== null })',
        returnByValue: true
      }, sessionId, 5_000))
      const remote = objectValue(response?.result)
      const value = objectValue(remote?.value)
      if (typeof value?.windowName !== 'string' || typeof value.hasOpener !== 'boolean') return undefined
      return { windowName: value.windowName, hasOpener: value.hasOpener }
    } catch {
      return undefined
    } finally {
      if (sessionId) await epoch.cdp.send('Target.detachFromTarget', { sessionId }, undefined, 5_000).catch(() => {})
    }
  }
  private profileTransportFailure(profile: ProfileRuntime, error: unknown): BrowserFault | undefined {
    if (error instanceof NativeTransportError) {
      this.invalidateEpoch(profile, profile.epoch, error.message)
      profile.lossReported = true
      return fault(error.reason, error.message)
    }
    if (error instanceof BrowserFault && error.reason === 'browser_tab_changed') {
      this.invalidateEpoch(profile, profile.epoch, error.message)
      profile.lossReported = true
      return error
    }
    if (cdpTransportFailure(error)) {
      this.invalidateEpoch(profile, profile.epoch, error instanceof Error ? error.message : String(error))
      profile.lossReported = true
      return fault('browser_tab_changed', 'owned browser CDP transport was lost')
    }
    return undefined
  }

  async withProfileLock<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const profile = this.profile(profileId)
    try {
      return await profile.lock.run(operation)
    } catch (error) {
      const transportFailure = this.profileTransportFailure(profile, error)
      if (transportFailure) throw transportFailure
      throw error
    }
  }


  async closePageOutOfBand(pageId: string): Promise<void> {
    this.closingPages.add(pageId)
    this.invalidatePage(pageId, true)
    const targets: Array<{ epoch: RuntimeEpoch; binding: BoundPage }> = []
    for (const profile of this.profiles.values()) {
      const epoch = profile.epoch
      const binding = epoch?.pages.get(pageId)
      if (!epoch || !binding || epoch.invalid) continue
      this.startPageTermination(binding.runtime)
      this.closingTargets.add(binding.targetId)
      targets.push({ epoch, binding })
    }
    for (const profile of this.profiles.values()) {
      for (const controller of profile.controllers.get(pageId) ?? []) controller.abort()
    }
    for (const { epoch, binding } of targets) {
      try {
        await epoch.cdp.send('Target.closeTarget', { targetId: binding.targetId }, undefined, 5_000)
      } catch { /* target close is bounded by queued cleanup */ }
      finally { this.finishPageTermination(binding.runtime) }
    }
  }

  private startPageTermination(state: RuntimePageState): void {
    if (state.termination) return
    const termination = Promise.withResolvers<void>()
    state.termination = termination.promise
    state.finishTermination = termination.resolve
    if (state.pendingNavigation) state.pendingNavigation.termination = termination.promise
  }

  private finishPageTermination(state: RuntimePageState): void {
    state.finishTermination?.()
    state.finishTermination = undefined
    state.termination = undefined
  }
  private invalidateHelperReferences(epoch: RuntimeEpoch): void {
    if (!epoch.activeTabId) return
    for (const binding of epoch.pages.values()) {
      if (binding.tabId === epoch.activeTabId) {
        this.onPageInvalidated(binding.pageId)
        return
      }
    }
  }



  async closePageLocked(profileId: string, pageId: string): Promise<void> {
    const profile = this.profile(profileId)
    const epoch = profile.epoch
    const binding = epoch?.pages.get(pageId)
    this.invalidatePage(pageId, false)
    if (epoch && binding && !epoch.invalid) await this.closeBinding(epoch, pageId, binding)
    this.closingPages.delete(pageId)
    this.generations.delete(pageId)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.paneWatches.values()].map((watch) => this.endPaneWatch(watch)))
    this.paneDownloadOwners.clear()
    await Promise.all([...this.profiles.values()].map(async (profile) => {
      for (const controllers of profile.controllers.values()) for (const controller of controllers) controller.abort()
      const epoch = profile.epoch
      if (!epoch) return
      epoch.stopping = true
      await this.teardownEpoch(epoch)
      if (profile.epoch === epoch) profile.epoch = undefined
    }))
  }


  async navigate(execution: PageExecution, url: string, timeoutMs = 30_000): Promise<NavigationResult> {
    const tracker = this.beginNavigation(execution)
    const startedAt = Date.now()
    let match: { frameId: string; loaderId?: string; url?: string } | undefined
    try {
      const response = await execution.cdp.send('Page.navigate', { url }, execution.binding.sessionId, timeoutMs)
      const result = safeRecord(response, {
        type: 'object',
        properties: { frameId: { type: 'string' }, loaderId: { type: 'string' }, errorText: { type: 'string' } },
        required: ['frameId'],
        additionalProperties: true
      }, 'navigation result')
      const frameId = result.frameId as string
      if (frameId !== tracker.frameId) throw fault('browser_tab_changed', 'navigation returned an unexpected main frame')
      const loaderId = asString(result.loaderId)
      let errorText = asString(result.errorText)
      if (loaderId) {
        match = { frameId, loaderId }
        if (!errorText) {
          const loaded = await this.waitForDocumentLoad(tracker, frameId, loaderId, Math.max(0, timeoutMs - (Date.now() - startedAt)))
          if (loaded.kind === 'loading-failed') errorText = loaded.errorText
        }
      } else if (!errorText) {
        const targetUrl = new URL(url).href
        if (targetUrl !== tracker.previousUrl) {
          await this.waitForNavigationEvent(
            tracker,
            (events) => events.find((event) => event.kind === 'same-document' && event.frameId === frameId && event.url === targetUrl),
            Math.max(0, timeoutMs - (Date.now() - startedAt)),
            `navigation to ${url} timed out`
          )
          match = { frameId, url: targetUrl }
        }
      }
      const location = await this.pageLocation(execution)
      if (!errorText && this.generation(execution.page.browserPageId) === execution.binding.pageGeneration) {
        execution.runtimePage.mainFrameUrl = location.url
      }
      return errorText
        ? { url, title: location.title, errorText }
        : location
    } catch (error) {
      if (error instanceof BrowserFault) throw error
      if (error instanceof Error && error.message.toLowerCase().includes('timed out')) throw fault('browser_timeout', `navigation to ${url} timed out`)
      throw fault('browser_error', `navigation failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.finishNavigation(execution, tracker, match)
    }
  }


  async pageLocation(execution: PageExecution): Promise<{ url: string; title: string }> {
    const response = safeRecord(await execution.cdp.send('Runtime.evaluate', {
      expression: '({url: location.href, title: document.title})',
      returnByValue: true
    }, execution.binding.sessionId), {
      type: 'object',
      properties: {
        result: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            value: {
              type: 'object',
              properties: { url: { type: 'string' }, title: { type: 'string' } },
              required: ['url', 'title'],
              additionalProperties: true
            }
          },
          required: ['type', 'value'],
          additionalProperties: true
        },
        exceptionDetails: {}
      },
      required: ['result'],
      additionalProperties: true
    }, 'page location response')
    if (response.exceptionDetails !== undefined) throw fault('browser_error', 'bound page location could not be read')
    const remote = safeRecord(response.result, {
      type: 'object',
      properties: {
        type: { type: 'string' },
        value: {
          type: 'object',
          properties: { url: { type: 'string' }, title: { type: 'string' } },
          required: ['url', 'title'],
          additionalProperties: true
        }
      },
      required: ['type', 'value'],
      additionalProperties: true
    }, 'page location result')
    const location = safeRecord(remote.value, {
      type: 'object',
      properties: { url: { type: 'string' }, title: { type: 'string' } },
      required: ['url', 'title'],
      additionalProperties: true
    }, 'page location value')
    return { url: location.url as string, title: location.title as string }
  }

  private beginNavigation(execution: PageExecution): NavigationTracker {
    const state = execution.runtimePage
    if (state.pendingNavigation) throw fault('browser_tab_changed', 'another navigation is already active for this page')
    if (!state.mainFrameId) throw fault('browser_tab_changed', 'managed page main frame is not established')
    const tracker: NavigationTracker = {
      frameId: state.mainFrameId,
      previousLoaderId: state.mainFrameLoaderId,
      previousUrl: state.mainFrameUrl ?? 'about:blank',
      events: [],
      signal: execution.signal,
      termination: state.termination
    }
    state.pendingNavigation = tracker
    return tracker
  }

  private async waitForNavigationEvent(
    tracker: NavigationTracker,
    find: (events: NavigationEvent[]) => NavigationEvent | undefined,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<NavigationEvent> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (tracker.signal?.aborted) {
        await tracker.termination
        throw fault('browser_tab_closed', 'navigation was cancelled because its page is closing')
      }
      const event = find(tracker.events)
      if (event) return event
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw fault('browser_timeout', timeoutMessage)
      const changed = Promise.withResolvers<void>()
      const timeout = Promise.withResolvers<void>()
      const aborted = Promise.withResolvers<void>()
      const onAbort = () => aborted.resolve()
      tracker.notify = changed.resolve
      tracker.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => timeout.resolve(), remaining)
      try {
        const waits: Promise<'changed' | 'timeout' | 'aborted'>[] = [
          changed.promise.then(() => 'changed' as const),
          timeout.promise.then(() => 'timeout' as const)
        ]
        if (tracker.signal) waits.push(aborted.promise.then(() => 'aborted' as const))
        const outcome = await Promise.race(waits)
        if (outcome === 'aborted') {
          await tracker.termination
          throw fault('browser_tab_closed', 'navigation was cancelled because its page is closing')
        }
        if (outcome === 'timeout') throw fault('browser_timeout', timeoutMessage)
      } finally {
        clearTimeout(timer)
        tracker.signal?.removeEventListener('abort', onAbort)
        if (tracker.notify === changed.resolve) tracker.notify = undefined
      }
    }
  }

  private async waitForDocumentLoad(
    tracker: NavigationTracker,
    frameId: string,
    loaderId: string,
    timeoutMs: number
  ): Promise<NavigationEvent> {
    return await this.waitForNavigationEvent(tracker, (events) =>
      this.documentFailure(tracker, frameId, loaderId) ??
      events.find((event) => event.kind === 'lifecycle' && event.frameId === frameId && event.loaderId === loaderId && event.name === 'load'),
    timeoutMs,
    'navigation did not reach the matching document load event')
  }

  private documentFailure(tracker: NavigationTracker, frameId: string, loaderId: string): NavigationEvent | undefined {
    const requestIds = new Set(tracker.events
      .filter((event) => event.kind === 'document-request' && event.frameId === frameId && event.loaderId === loaderId)
      .map((event) => event.kind === 'document-request' ? event.requestId : ''))
    return tracker.events.find((event) => event.kind === 'loading-failed' && requestIds.has(event.requestId))
  }


  private finishNavigation(
    execution: PageExecution,
    tracker: NavigationTracker,
    match?: { frameId: string; loaderId?: string; url?: string }
  ): void {
    const state = execution.runtimePage
    if (state.pendingNavigation !== tracker) return
    state.pendingNavigation = undefined
    if (this.closingPages.has(execution.page.browserPageId)) return
    const epoch = this.profile(execution.page.profileId).epoch
    const binding = epoch?.pages.get(execution.page.browserPageId)
    if (!epoch || epoch.invalid || !binding) return
    let matched = false
    for (const event of tracker.events) {
      if (event.kind === 'frame' && event.frameId === tracker.frameId) {
        if (event.loaderId === tracker.previousLoaderId && event.url === tracker.previousUrl) continue
        if (match?.loaderId && event.loaderId === match.loaderId) {
          state.mainFrameId = event.frameId
          state.mainFrameLoaderId = event.loaderId
          state.mainFrameUrl = event.url
          matched = true
        } else {
          this.observeMainFrameNavigation(epoch, binding, event.frameId, event.loaderId, event.url)
        }
      } else if (event.kind === 'same-document' && event.frameId === tracker.frameId) {
        if (match?.url === event.url) {
          state.mainFrameUrl = event.url
          matched = true
        } else if (event.url !== tracker.previousUrl) {
          this.observeSameDocumentNavigation(epoch, binding, event.frameId, event.url)
        }
      } else if (event.kind === 'lifecycle' && match?.loaderId === event.loaderId && event.frameId === tracker.frameId) {
        state.mainFrameId = event.frameId
        state.mainFrameLoaderId = event.loaderId
        matched = true
      }
    }
    if (!matched || !match) return
    state.mainFrameId = match.frameId
    if (match.loaderId) state.mainFrameLoaderId = match.loaderId
    if (match.url) state.mainFrameUrl = match.url
  }

  private profile(profileId: string): ProfileRuntime {
    let profile = this.profiles.get(profileId)
    if (!profile) {
      profile = { lock: new FifoLock(), lossReported: false, controllers: new Map() }
      this.profiles.set(profileId, profile)
    }
    return profile
  }

  private async ensureEpoch(profile: ProfileRuntime, profileId: string): Promise<RuntimeEpoch> {
    if (profile.epoch && !profile.epoch.invalid) return profile.epoch
    if (profile.epoch?.invalid) {
      if (!profile.lossReported) {
        profile.lossReported = true
        throw fault('browser_tab_changed', `owned browser helper or CDP epoch was lost${profile.failureReason ? `: ${profile.failureReason}` : ''}`)
      }
      await this.teardownEpoch(profile.epoch)
      profile.epoch = undefined
      profile.lossReported = false
    }
    if (profile.starting) return await profile.starting
    const starting = this.startEpoch(profile, profileId)
    profile.starting = starting
    try {
      const epoch = await starting
      profile.epoch = epoch
      const pages = this.store.listPages().filter((page) => page.profileId === profileId)
      for (const page of pages) await this.ensureBinding(epoch, page, this.generation(page.browserPageId))
      return epoch
    } catch (error) {
      throw error
    } finally {
      profile.starting = undefined
    }
  }

  private async startEpoch(profile: ProfileRuntime, profileId: string): Promise<RuntimeEpoch> {
    const profileRoot = this.store.profilePath(profileId)
    const chrome = await startChrome(profileRoot, this.dependencies)
    let helper: NativeHelper | undefined
    let cdp: CdpConnection | undefined
    let epoch: RuntimeEpoch | undefined
    try {
      helper = await startNativeHelper(profileRoot, chrome.cdpUrl, this.dependencies)
      cdp = await CdpConnection.connect(chrome.browserWebSocketUrl, (reason) => {
        if (epoch) this.invalidateEpoch(profile, epoch, reason)
      })
      epoch = {
        id: randomUUID(),
        profileId,
        chrome,
        helper,
        cdp,
        pages: new Map(),
        invalid: false,
        stopping: false
      }
      void chrome.child.exited.then(() => this.invalidateEpoch(profile, epoch!, 'owned Chrome process exited'))
      void helper.child.exited.then(() => this.invalidateEpoch(profile, epoch!, 'owned native helper process exited'))
      this.subscribeBrowserEvents(epoch)
      return epoch
    } catch (error) {
      cdp?.close()
      if (helper) await helper.asyncClose()
      await chrome.asyncClose()
      if (error instanceof BrowserFault) throw error
      throw fault('browser_unavailable', 'owned headless Chrome and its native helper could not be attached')
    }
  }

  private async closeBinding(epoch: RuntimeEpoch, pageId: string, binding: BoundPage): Promise<void> {
    if (!epoch.invalid) {
      this.closingTargets.add(binding.targetId)
      this.invalidateHelperReferences(epoch)
      try { await nativeRequest(epoch.helper.socketPath, 'tab_close', { tabId: binding.tabId }, 5_000) } catch { /* target may already be closed */ }
      if (epoch.activeTabId === binding.tabId) epoch.activeTabId = undefined
      try { await epoch.cdp.send('Target.closeTarget', { targetId: binding.targetId }, undefined, 5_000) } catch { /* Chrome may already have closed this target */ }
      try { await epoch.cdp.send('Target.detachFromTarget', { sessionId: binding.sessionId }, undefined, 5_000) } catch { /* session is already detached */ }
    }
    epoch.pages.delete(pageId)
  }
  private async ensureBinding(epoch: RuntimeEpoch, page: BrowserPage, generation: number): Promise<BoundPage> {
    const existing = epoch.pages.get(page.browserPageId)
    if (existing && existing.generation === generation) return existing
    if (existing) await this.closeBinding(epoch, page.browserPageId, existing)
    this.invalidateHelperReferences(epoch)
    // Only a newly created target can belong to this tab_new call. Old pages'
    // debugger readiness is unrelated to the identity of a fresh tab.
    const before = safeRecord(await epoch.cdp.send('Target.getTargets'), TARGET_LIST_SCHEMA, 'target list').targetInfos as unknown[]
    const existingTargets = new Set<string>()
    for (const value of before) {
      const targetId = asString(objectValue(value)?.targetId)
      if (targetId) existingTargets.add(targetId)
    }
    const created = await nativeRequest(epoch.helper.socketPath, 'tab_new', { url: 'about:blank' }, 10_000)
    const tab = nativeData<TabCreated>(created, TAB_CREATED_SCHEMA, 'new tab')
    epoch.activeTabId = tab.tabId
    const binding = await this.bindFreshPage(epoch, page, generation, tab.tabId, existingTargets)
    epoch.pages.set(page.browserPageId, binding)
    await this.enablePageDomains(epoch, binding)
    await this.navigateRetainedPage(epoch, page, binding)
    return binding
  }

  private async bindFreshPage(epoch: RuntimeEpoch, page: BrowserPage, generation: number, tabId: string, existingTargets: ReadonlySet<string>): Promise<BoundPage> {
    const targetsResponse = await epoch.cdp.send('Target.getTargets')
    const targets = safeRecord(targetsResponse, TARGET_LIST_SCHEMA, 'target list').targetInfos as unknown[]
    const sessions = new Map<string, string>()
    const sessionTarget = new Map<string, string>()
    const matches: string[] = []
    const challengeSeen = Promise.withResolvers<void>()
    const label = `quirky-internal-page/${randomUUID()}`
    const unsubscribe = epoch.cdp.subscribe('Debugger.scriptParsed', (event) => {
      if (!event.sessionId || event.params.url !== label) return
      matches.push(event.sessionId)
      challengeSeen.resolve()
    })
    try {
      for (const targetValue of targets) {
        const target = safeRecord(targetValue, { type: 'object', properties: { targetId: { type: 'string' }, type: { type: 'string' } }, required: ['targetId', 'type'], additionalProperties: true }, 'target info') as TargetInfo
        if (target.type !== 'page' || existingTargets.has(target.targetId)) continue
        const attached = await epoch.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
        const sessionId = safeRecord(attached, ATTACHED_SCHEMA, 'target attachment').sessionId as string
        sessions.set(target.targetId, sessionId)
        sessionTarget.set(sessionId, target.targetId)
        await epoch.cdp.send('Debugger.enable', {}, sessionId)
      }
      if (sessions.size === 0) throw new Error('owned Chrome has no candidate page targets')
      this.invalidateHelperReferences(epoch)
      const switched = await nativeRequest(epoch.helper.socketPath, 'tab_switch', { tabId }, 10_000)
      if (!switched.success) throw new Error(switched.error ?? 'native helper did not select the new page')
      const switchedData = safeRecord(switched.data, TAB_SWITCH_SCHEMA, 'new tab selection')
      if (switchedData.tabId !== tabId) throw new Error('native helper selected a different page')
      epoch.activeTabId = tabId
      const source = await nativeRequest(epoch.helper.socketPath, 'evaluate', { script: `null\n//# sourceURL=${label}` }, 10_000)
      if (!source.success) throw new Error(source.error ?? 'native helper challenge failed')
      if (matches.length === 0) {
        const timeout = Promise.withResolvers<false>()
        const timer = setTimeout(() => timeout.resolve(false), 1_000)
        try { await Promise.race([challengeSeen.promise.then(() => true), timeout.promise]) } finally { clearTimeout(timer) }
      }
      if (matches.length !== 1) throw new Error('fresh helper page identity challenge was missing or ambiguous')
      const sessionId = matches[0]!
      const targetId = sessionTarget.get(sessionId)
      if (!targetId || sessions.get(targetId) !== sessionId) throw new Error('fresh page identity challenge came from an unexpected target')
      for (const candidateSession of sessions.values()) {
        try { await epoch.cdp.send('Debugger.disable', {}, candidateSession) } catch { /* detached candidate */ }
      }
      for (const [candidateTarget, candidateSession] of sessions) {
        if (candidateSession === sessionId) continue
        try { await epoch.cdp.send('Target.detachFromTarget', { sessionId: candidateSession }) } catch { /* candidate closed during binding */ }
        sessions.delete(candidateTarget)
      }
      const runtimePage: RuntimePageState = {
        binding: { browserEpoch: epoch.id, pageGeneration: generation, targetId, sessionId, tabId }
      }
      const binding: BoundPage = { pageId: page.browserPageId, tabId, targetId, sessionId, generation, runtime: runtimePage }
      return binding
    } catch (error) {
      try { await nativeRequest(epoch.helper.socketPath, 'tab_close', { tabId }, 2_000) } catch { /* failed binding will tear down the owned epoch */ }
      for (const sessionId of sessions.values()) {
        try { await epoch.cdp.send('Target.detachFromTarget', { sessionId }, undefined, 2_000) } catch { /* candidate session was already closed */ }
      }
      this.invalidateEpoch(this.profile(epoch.profileId), epoch, 'trusted page binding failed')
      throw fault('browser_tab_changed', 'fresh managed page identity could not be established')
    } finally {
      unsubscribe()
    }
  }

  private async enablePageDomains(epoch: RuntimeEpoch, binding: BoundPage): Promise<void> {
    const sessionId = binding.sessionId
    await epoch.cdp.send('Page.enable', {}, sessionId)
    await epoch.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId)
    await epoch.cdp.send('Runtime.enable', {}, sessionId)
    await epoch.cdp.send('Network.enable', {}, sessionId)
    this.subscribePageEvents(epoch, binding)
    const tree = safeRecord(await epoch.cdp.send('Page.getFrameTree', {}, sessionId), {
      type: 'object',
      properties: {
        frameTree: {
          type: 'object',
          properties: {
            frame: {
              type: 'object',
              properties: { id: { type: 'string' }, loaderId: { type: 'string' }, url: { type: 'string' } },
              required: ['id', 'url'],
              additionalProperties: true
            }
          },
          required: ['frame'],
          additionalProperties: true
        }
      },
      required: ['frameTree'],
      additionalProperties: true
    }, 'page frame tree')
    const frameTree = safeRecord(tree.frameTree, {
      type: 'object', properties: { frame: { type: 'object', additionalProperties: true } }, required: ['frame'], additionalProperties: true
    }, 'page frame tree')
    const frame = safeRecord(frameTree.frame, {
      type: 'object',
      properties: { id: { type: 'string' }, loaderId: { type: 'string' }, url: { type: 'string' } },
      required: ['id', 'url'],
      additionalProperties: true
    }, 'main frame')
    binding.runtime.mainFrameId = frame.id as string
    binding.runtime.mainFrameLoaderId = asString(frame.loaderId)
    binding.runtime.mainFrameUrl = frame.url as string
    binding.runtime.navigationReady = true
  }

  private subscribeBrowserEvents(epoch: RuntimeEpoch): void {
    epoch.cdp.subscribe('Target.targetDestroyed', (event) => {
      const targetId = asString(event.params.targetId)
      if (!targetId || this.closingTargets.delete(targetId)) return
      for (const [pageId, binding] of epoch.pages) {
        if (binding.targetId === targetId && !epoch.stopping && !this.closingPages.has(pageId)) {
          this.invalidateEpoch(this.profile(epoch.profileId), epoch, `owned target for page ${pageId} was destroyed`)
          return
        }
      }
    })
  }

  private subscribePageEvents(epoch: RuntimeEpoch, binding: BoundPage): void {
    const state = binding.runtime
    epoch.cdp.subscribe('Page.frameNavigated', (event) => {
      if (event.sessionId !== binding.sessionId) return
      const value = event.params.frame
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return
      const frame = value as Record<string, unknown>
      const frameId = asString(frame.id)
      const url = asString(frame.url)
      if (!frameId || !url || frame.parentId !== undefined) return
      const loaderId = asString(frame.loaderId)
      const navigationEvent: NavigationEvent = {
        kind: 'frame',
        frameId,
        ...(loaderId ? { loaderId } : {}),
        url,
      }
      if (this.pushNavigationEvent(state, navigationEvent)) return
      this.observeMainFrameNavigation(epoch, binding, frameId, loaderId, url)
    })
    epoch.cdp.subscribe('Page.navigatedWithinDocument', (event) => {
      if (event.sessionId !== binding.sessionId) return
      const frameId = asString(event.params.frameId)
      const url = asString(event.params.url)
      if (!frameId || !url || frameId !== state.mainFrameId) return
      const navigationEvent: NavigationEvent = { kind: 'same-document', frameId, url }
      if (this.pushNavigationEvent(state, navigationEvent)) return
      this.observeSameDocumentNavigation(epoch, binding, frameId, url)
    })
    epoch.cdp.subscribe('Page.lifecycleEvent', (event) => {
      if (event.sessionId !== binding.sessionId) return
      const frameId = asString(event.params.frameId)
      const loaderId = asString(event.params.loaderId)
      const name = asString(event.params.name)
      if (!frameId || !loaderId || !name || frameId !== state.mainFrameId) return
      const navigationEvent: NavigationEvent = { kind: 'lifecycle', frameId, loaderId, name }
      if (this.pushNavigationEvent(state, navigationEvent)) return
      if (name === 'load' && loaderId === state.mainFrameLoaderId) {
        const generation = this.generation(binding.pageId)
        void this.refreshSpontaneousTitle(epoch, binding, generation, loaderId).catch(() => {})
      }
    })
    epoch.cdp.subscribe('Network.requestWillBeSent', (event) => {
      if (event.sessionId !== binding.sessionId || validateValue(EVENT_NETWORK_REQUEST_SCHEMA, event.params, 'document request event')) return
      const requestId = asString(event.params.requestId)
      const frameId = asString(event.params.frameId)
      const loaderId = asString(event.params.loaderId)
      if (event.params.type === 'Document' && requestId && frameId && loaderId) {
        this.pushNavigationEvent(state, { kind: 'document-request', requestId, frameId, loaderId })
      }
    })
    epoch.cdp.subscribe('Network.loadingFailed', (event) => {
      if (event.sessionId !== binding.sessionId) return
      const requestId = asString(event.params.requestId)
      if (!requestId || !state.pendingNavigation?.events.some((candidate) => candidate.kind === 'document-request' && candidate.requestId === requestId)) return
      this.pushNavigationEvent(state, {
        kind: 'loading-failed',
        requestId,
        errorText: asString(event.params.errorText) ?? 'network error',
      })
    })
  }
  private pushNavigationEvent(state: RuntimePageState, event: NavigationEvent): boolean {
    const tracker = state.pendingNavigation
    if (!tracker) return false
    tracker.events.push(event)
    tracker.notify?.()
    return true
  }

  private observeMainFrameNavigation(
    epoch: RuntimeEpoch,
    binding: BoundPage,
    frameId: string,
    loaderId: string | undefined,
    url: string
  ): void {
    const state = binding.runtime
    if (!state.navigationReady) return
    const changed = frameId !== state.mainFrameId || loaderId !== state.mainFrameLoaderId || url !== state.mainFrameUrl
    state.mainFrameId = frameId
    state.mainFrameLoaderId = loaderId
    state.mainFrameUrl = url
    if (!changed) return
    const generation = this.invalidatePage(binding.pageId, true)
    try {
      this.store.updatePage(binding.pageId, (page) => {
        page.url = url
        page.title = ''
        page.loadError = null
      })
    } catch { return }
    if (loaderId) void this.refreshSpontaneousTitle(epoch, binding, generation, loaderId).catch(() => {})
  }

  private observeSameDocumentNavigation(epoch: RuntimeEpoch, binding: BoundPage, frameId: string, url: string): void {
    const state = binding.runtime
    if (!state.navigationReady || frameId !== state.mainFrameId || url === state.mainFrameUrl) return
    state.mainFrameUrl = url
    const generation = this.invalidatePage(binding.pageId, true)
    try {
      this.store.updatePage(binding.pageId, (page) => {
        page.url = url
        page.loadError = null
      })
    } catch { return }
    const loaderId = state.mainFrameLoaderId
    if (loaderId) void this.refreshSpontaneousTitle(epoch, binding, generation, loaderId).catch(() => {})
  }

  private async refreshSpontaneousTitle(epoch: RuntimeEpoch, binding: BoundPage, generation: number, loaderId: string): Promise<void> {
    if (epoch.invalid || this.generation(binding.pageId) !== generation || binding.runtime.mainFrameLoaderId !== loaderId) return
    let page: BrowserPage
    try { page = this.store.getPage(binding.pageId) } catch { return }
    const location = await this.pageLocation(this.execution(page, epoch, binding))
    if (epoch.invalid || this.generation(binding.pageId) !== generation || binding.runtime.mainFrameLoaderId !== loaderId) return
    try {
      this.store.updatePage(binding.pageId, (record) => {
        record.url = location.url
        record.title = location.title
        record.loadError = null
      })
    } catch { /* the page closed while its spontaneous navigation completed */ }
  }


  private execution(page: BrowserPage, epoch: RuntimeEpoch, binding: BoundPage, signal?: AbortSignal): PageExecution {
    const cancellation = async (): Promise<never> => {
      await binding.runtime.termination
      throw fault('browser_tab_closed', 'the browser operation was cancelled')
    }
    const cdp: PageCdp = {
      send: async (method, params, sessionId, timeoutMs) => {
        if (signal?.aborted) return await cancellation()
        try {
          const result = await epoch.cdp.send(method, params, sessionId, timeoutMs)
          if (signal?.aborted) return await cancellation()
          return result
        } catch (error) {
          if (signal?.aborted) return await cancellation()
          throw error
        }
      },
      subscribe: (method, listener) => epoch.cdp.subscribe(method, listener)
    }
    return {
      page,
      cdp,
      binding: this.publicBinding(epoch, binding),
      runtimePage: binding.runtime,
      ...(signal ? { signal } : {}),
      native: async (action, fields = {}, timeoutMs = 90_000) => {
        if (signal?.aborted) return await cancellation()
        try {
          const response = await nativeRequest(epoch.helper.socketPath, action, fields, timeoutMs, signal)
          if (signal?.aborted) return await cancellation()
          return response
        } catch (error) {
          if (signal?.aborted) return await cancellation()
          throw error
        }
      }
    }
  }

  private publicBinding(epoch: RuntimeEpoch, binding: BoundPage): RuntimeBinding {
    return {
      browserEpoch: epoch.id,
      pageGeneration: binding.generation,
      targetId: binding.targetId,
      sessionId: binding.sessionId,
      tabId: binding.tabId
    }
  }

  private async navigateRetainedPage(epoch: RuntimeEpoch, page: BrowserPage, binding: BoundPage): Promise<void> {
    if (page.url === '' || page.url === 'about:blank') return
    const execution = this.execution(page, epoch, binding)
    try {
      const result = await this.navigate(execution, page.url)
      if (result.errorText) {
        this.store.updatePage(page.browserPageId, (record) => {
          record.url = page.url
          record.title = result.title
          record.loadError = { code: 'navigation_failed', description: result.errorText!.slice(0, 300), validatedUrl: page.url }
        })
        throw fault('browser_error', `navigation failed: ${result.errorText}`)
      }
      this.store.updatePage(page.browserPageId, (record) => {
        record.url = result.url
        record.title = result.title
        record.loadError = null
      })
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error)
      try {
        this.store.updatePage(page.browserPageId, (record) => {
          record.url = page.url
          record.title = ''
          record.loadError = {
            code: error instanceof BrowserFault ? error.reason : 'navigation_failed',
            description: description.slice(0, 300),
            validatedUrl: page.url
          }
        })
      } catch { /* the persisted page was removed while navigation failed */ }
      throw error
    }
  }

  private invalidateEpoch(profile: ProfileRuntime, epoch: RuntimeEpoch | undefined, reason: string): void {
    if (!epoch || epoch.stopping || epoch.invalid) return
    epoch.invalid = true
    profile.failureReason = reason.slice(0, 300)
    for (const page of this.store.listPages()) {
      if (page.profileId !== epoch.profileId) continue
      this.invalidatePage(page.browserPageId, false)
    }
    for (const [guid, owner] of this.paneDownloadOwners) {
      if (owner.epochId === epoch.id) this.paneDownloadOwners.delete(guid)
    }
    epoch.teardown = this.teardownEpoch(epoch)
  }

  private async teardownEpoch(epoch: RuntimeEpoch): Promise<void> {
    if (epoch.teardown) return await epoch.teardown
    epoch.stopping = true
    epoch.cdp.close()
    epoch.teardown = Promise.allSettled([epoch.helper.asyncClose(), epoch.chrome.asyncClose()]).then(() => {
      rmSync(epoch.helper.socketDir, { recursive: true, force: true })
      rmSync(epoch.helper.socketAliasRoot, { recursive: true, force: true })
      rmSync(join(epoch.chrome.profileRoot, 'helper-home'), { recursive: true, force: true })
    }).then(() => undefined)
    await epoch.teardown
  }
}
