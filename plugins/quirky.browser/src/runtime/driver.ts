import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { validateValue, type Schema } from '@quirky/protocol'
import { fault, BrowserFault } from './errors'
import { CdpConnection } from './cdp'
import { startChrome, type OwnedChrome } from './chrome'
import { FifoLock, withLocks } from './lock'
import { nativeData } from './native-response'
import { NativeTransportError, nativeRequest, startNativeHelper, type NativeHelper, type NativeResponse } from './native'
import type { BrowserDependencies, BrowserTestControl, CookieTransport } from './dependencies'
import type { BrowserPage, Cookie } from '../cookies/types'
import { BrowserStore } from '../profiles/store'

function canonicalCookieDomain(domain: string): string {
  return domain.replace(/^\.+/, '').toLowerCase()
}

export type RuntimeBinding = {
  browserEpoch: string
  pageGeneration: number
  targetId: string
  sessionId: string
  tabId: string
}

export type ConsoleEntry = { level: string; text: string; timestamp: number; url?: string; line?: number }
export type NetworkEntry = { url: string; method: string; status: number; mimeType: string; size: number; timestamp: number }
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type ViewportSetting = { width: number; height: number; deviceScaleFactor: number; mobile: boolean }
export type PageSettings = {
  viewport?: ViewportSetting
  geolocation?: { latitude: number; longitude: number; accuracy: number }
  deviceName?: string
  userAgent?: string
  offline: boolean
  headers?: Record<string, string>
  credentials?: { user: string; pass: string }
  colorScheme?: 'dark' | 'light' | null
  reducedMotion?: 'reduce' | 'no-preference' | null
  routes: string[]
}

export type PendingDialog = {
  token: string
  browserEpoch: string
  pageGeneration: number
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  url: string
  message: string
  responding: boolean
}

export type NavigationEvent =
  | { kind: 'frame'; frameId: string; loaderId?: string; url: string; navigationType?: string }
  | { kind: 'same-document'; frameId: string; url: string }
  | { kind: 'lifecycle'; frameId: string; loaderId: string; name: string }
  | { kind: 'document-request'; requestId: string; frameId: string; loaderId: string }
  | { kind: 'loading-failed'; requestId: string; errorText: string; canceled: boolean }

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
  consoleEntries: ConsoleEntry[]
  networkById: Map<string, NetworkEntry>
  networkEntries: NetworkEntry[]
  harEntries: JsonValue[]
  interceptRequests: Array<{ id: string; url: string; method: string; headers: Record<string, string>; resourceType: string }>
  navigationReady?: boolean
  mainFrameId?: string
  mainFrameLoaderId?: string
  mainFrameUrl?: string
  domContentLoadedLoaders: Set<string>
  loadedLoaders: Set<string>
  pendingNavigation?: NavigationTracker
  termination?: Promise<void>
  finishTermination?: () => void
  captureStartedAt?: number
  pendingDialog?: PendingDialog
}

export type PageCdp = Pick<CdpConnection, 'send' | 'subscribe'>
export type PageExecution = {
  page: BrowserPage
  cdp: PageCdp
  binding: RuntimeBinding
  runtimePage: RuntimePageState
  settings: PageSettings
  signal?: AbortSignal
  native(action: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<NativeResponse>
}

export type ProfileExecution = { cdp: CdpConnection; browserEpoch: string }

export type NavigationResult = { url: string; title: string; errorText?: string; requestedUrl?: string }

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
  cookiePageId?: string
  cookiePage?: BoundPage
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


const COOKIE_LIST_SCHEMA: Schema = {
  type: 'object',
  properties: {
    cookies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
          domain: { type: 'string' },
          path: { type: 'string' },
          secure: { type: 'boolean' },
          httpOnly: { type: 'boolean' },
          sameSite: { type: 'string' },
          expires: { type: 'number' },
          partitionKey: {
            type: 'object',
            properties: { topLevelSite: { type: 'string' }, hasCrossSiteAncestor: { type: 'boolean' } },
            required: ['topLevelSite', 'hasCrossSiteAncestor'],
            additionalProperties: true
          }
        },
        required: ['name', 'value', 'domain', 'path', 'secure', 'httpOnly'],
        additionalProperties: true
      }
    }
  },
  required: ['cookies'],
  additionalProperties: true
}

const COOKIE_SET_SCHEMA: Schema = {
  type: 'object',
  properties: { success: { type: 'boolean' } },
  required: ['success'],
  additionalProperties: true
}
const EVENT_CONSOLE_SCHEMA: Schema = {
  type: 'object',
  properties: { type: { type: 'string' }, timestamp: { type: 'number' }, args: { type: 'array', items: { type: 'object' } }, stackTrace: { type: 'object' } },
  required: ['type', 'timestamp', 'args'],
  additionalProperties: true
}

const EVENT_NETWORK_REQUEST_SCHEMA: Schema = {
  type: 'object',
  properties: { requestId: { type: 'string' }, request: { type: 'object' }, timestamp: { type: 'number' }, wallTime: { type: 'number' } },
  required: ['requestId', 'request'],
  additionalProperties: true
}

const DEVICE_PROFILES: Record<string, { width: number; height: number; scale: number; userAgent: string }> = {
  'iphone 14': { width: 390, height: 844, scale: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'iphone 14 pro': { width: 393, height: 852, scale: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'pixel 7': { width: 412, height: 915, scale: 2.625, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  ipad: { width: 820, height: 1180, scale: 2, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' }
}
export function browserDevice(name: string): { width: number; height: number; scale: number; userAgent: string } | undefined {
  return DEVICE_PROFILES[name.trim().toLowerCase()]
}

function initialSettings(): PageSettings {
  return { offline: false, routes: [] }
}

function safeRecord(value: unknown, schema: Schema, description: string): Record<string, unknown> {
  const failure = validateValue(schema, value, description)
  if (failure) throw fault('browser_tab_changed', `native browser returned malformed ${description}`)
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function headersAsStrings(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const headers: Record<string, string> = Object.create(null)
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== 'string') return {}
    headers[name] = header
  }
  return headers
}

function cdpTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes('websocket') || message.includes('timed out') || message.includes('malformed json') || message.includes('malformed envelope') || message.includes('50 mib frame')
}

export class BrowserRuntime {
  private readonly profiles = new Map<string, ProfileRuntime>()
  private readonly generations = new Map<string, number>()
  private readonly settings = new Map<string, PageSettings>()
  private readonly closingTargets = new Set<string>()
  private readonly closingPages = new Set<string>()
  private readonly changingPages = new Set<string>()

  constructor(
    private readonly store: BrowserStore,
    private readonly dependencies: BrowserDependencies,
    private readonly onPageInvalidated: (pageId: string) => void
  ) {
    for (const page of store.listPages()) this.generations.set(page.browserPageId, 0)
    dependencies.onControl?.(this.testControl())
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
    }
    return generation
  }

  pageSettings(pageId: string): PageSettings {
    const current = this.settings.get(pageId)
    return current ? structuredClone(current) : initialSettings()
  }

  updatePageSettings(pageId: string, update: (settings: PageSettings) => void): PageSettings {
    const settings = this.settings.get(pageId) ?? initialSettings()
    update(settings)
    this.settings.set(pageId, settings)
    return structuredClone(settings)
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
        if (this.changingPages.has(page.browserPageId)) throw fault('browser_tab_changed', 'the managed page is changing browser profiles')
        let current: BrowserPage
        try { current = this.store.getPage(page.browserPageId) } catch { throw fault('browser_tab_closed', 'the managed page was closed before the operation ran') }
        if (current.profileId !== page.profileId) throw fault('browser_tab_changed', 'the managed page changed browser profiles before the operation ran')
        if (this.generation(page.browserPageId) !== expectedGeneration) throw fault('browser_tab_changed', 'the managed page changed before the operation ran')
        const epoch = await this.ensureEpoch(profile, page.profileId)
        const binding = await this.ensureBinding(epoch, current, this.generation(page.browserPageId))
        if (epoch.activeTabId !== binding.tabId) {
          this.invalidateHelperReferences(epoch)
          let switched: NativeResponse
          try {
            switched = await nativeRequest(epoch.helper.socketPath, 'tab_switch', { tabId: binding.tabId }, 90_000, controller.signal)
          } catch (error) {
            if (controller.signal.aborted) await binding.runtime.termination
            throw error
          }
          if (!switched.success) throw new NativeTransportError('browser_tab_changed', 'native helper lost the managed tab mapping')
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
        if (this.changingPages.has(page.browserPageId)) {
          await binding.runtime.termination
          throw fault('browser_tab_changed', 'the managed page changed browser profiles during the operation')
        }
        if (epoch.invalid || this.generation(page.browserPageId) !== expectedGeneration) throw fault('browser_tab_changed', 'browser page identity changed during the operation')
        return result
      }, controller.signal)
    } catch (error) {
      if (this.closingPages.has(page.browserPageId)) throw fault('browser_tab_closed', 'the managed page was closed during the operation')
      if (this.changingPages.has(page.browserPageId)) throw fault('browser_tab_changed', 'the managed page changed browser profiles during the operation')
      const transportFailure = this.profileTransportFailure(profile, error)
      if (transportFailure) throw transportFailure
      throw error
    } finally {
      controllers.delete(controller)
      if (controllers.size === 0) profile.controllers.delete(page.browserPageId)
    }
  }

  async withProfile<T>(profileId: string, operation: (execution: ProfileExecution) => Promise<T>): Promise<T> {
    const profile = this.profile(profileId)
    try {
      return await profile.lock.run(async () => {
        const epoch = await this.ensureEpoch(profile, profileId)
        const result = await operation({ cdp: epoch.cdp, browserEpoch: epoch.id })
        if (epoch.invalid) throw fault('browser_tab_changed', 'owned browser epoch changed during the operation')
        return result
      })
    } catch (error) {
      const transportFailure = this.profileTransportFailure(profile, error)
      if (transportFailure) throw transportFailure
      throw error
    }
  }
  async withCookieMutation<T>(profileId: string, operation: (transport: CookieTransport) => Promise<T>): Promise<T> {
    const profile = this.profile(profileId)
    try {
      return await profile.lock.run(async () => operation(await this.cookieTransportLocked(profileId)))
    } catch (error) {
      const transportFailure = this.profileTransportFailure(profile, error)
      if (transportFailure) throw transportFailure
      throw error
    }
  }

  async cookieTransportLocked(profileId: string): Promise<CookieTransport> {
    const profile = this.profile(profileId)
    const epoch = await this.ensureEpoch(profile, profileId)
    const target = await this.ensureCookieTarget(epoch)
    const transport: CookieTransport = {
      list: async () => await this.readCdpCookies(epoch),
      delete: async (_profileId, cookie) => await this.deleteCdpCookie(epoch, target, cookie),
      set: async (_profileId, cookie) => await this.setCdpCookie(epoch, target, cookie)
    }
    return this.dependencies.wrapCookieTransport?.(transport) ?? transport
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

  async withProfiles<T>(profileIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const profiles = [...new Set(profileIds)].map((profileId) => ({ profileId, runtime: this.profile(profileId) }))
    const locks = new Map<string, FifoLock>()
    for (const { profileId, runtime } of profiles) locks.set(profileId, runtime.lock)
    try {
      return await withLocks(locks, profileIds, operation)
    } catch (error) {
      for (const { runtime } of profiles) {
        const transportFailure = this.profileTransportFailure(runtime, error)
        if (transportFailure) throw transportFailure
      }
      throw error
    }
  }

  async ensurePageLocked(page: BrowserPage): Promise<RuntimeBinding> {
    const profile = this.profile(page.profileId)
    const epoch = await this.ensureEpoch(profile, page.profileId)
    const binding = await this.ensureBinding(epoch, page, this.generation(page.browserPageId))
    return this.publicBinding(epoch, binding)
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
      binding.runtime.pendingDialog = undefined
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

  async cancelPageForChange(pageId: string): Promise<void> {
    this.changingPages.add(pageId)
    this.invalidatePage(pageId, true)
    const targets: Array<{ epoch: RuntimeEpoch; binding: BoundPage }> = []
    for (const profile of this.profiles.values()) {
      const epoch = profile.epoch
      const binding = epoch?.pages.get(pageId)
      if (!epoch || !binding || epoch.invalid) continue
      this.startPageTermination(binding.runtime)
      binding.runtime.pendingDialog = undefined
      this.closingTargets.add(binding.targetId)
      targets.push({ epoch, binding })
    }
    for (const profile of this.profiles.values()) {
      for (const controller of profile.controllers.get(pageId) ?? []) controller.abort()
    }
    for (const { epoch, binding } of targets) {
      try {
        await epoch.cdp.send('Target.closeTarget', { targetId: binding.targetId }, undefined, 5_000)
      } catch { /* profile switch will create a fresh target */ }
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

  async rebindPageLocked(profileId: string, pageId: string): Promise<void> {
    const epoch = this.profile(profileId).epoch
    const binding = epoch?.pages.get(pageId)
    if (epoch && binding && !epoch.invalid) await this.closeBinding(epoch, pageId, binding)
  }

  finishPageChange(pageId: string): void {
    this.changingPages.delete(pageId)
  }

  async closePageLocked(profileId: string, pageId: string): Promise<void> {
    const profile = this.profile(profileId)
    const epoch = profile.epoch
    const binding = epoch?.pages.get(pageId)
    this.invalidatePage(pageId, false)
    if (epoch && binding && !epoch.invalid) await this.closeBinding(epoch, pageId, binding)
    this.closingPages.delete(pageId)
    this.settings.delete(pageId)
    this.generations.delete(pageId)
  }

  async stopProfileLocked(profileId: string): Promise<void> {
    const profile = this.profile(profileId)
    const epoch = profile.epoch
    if (!epoch) return
    epoch.stopping = true
    await this.teardownEpoch(epoch)
    if (profile.epoch === epoch) profile.epoch = undefined
    profile.lossReported = false
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.profiles.values()].map(async (profile) => {
      for (const controllers of profile.controllers.values()) for (const controller of controllers) controller.abort()
      const epoch = profile.epoch
      if (!epoch) return
      epoch.stopping = true
      await this.teardownEpoch(epoch)
      if (profile.epoch === epoch) profile.epoch = undefined
    }))
  }

  bindingFor(pageId: string): RuntimeBinding | undefined {
    for (const profile of this.profiles.values()) {
      const epoch = profile.epoch
      const page = epoch?.pages.get(pageId)
      if (epoch && page && !epoch.invalid) return this.publicBinding(epoch, page)
    }
    return undefined
  }

  stateFor(pageId: string): RuntimePageState | undefined {
    for (const profile of this.profiles.values()) {
      const runtime = profile.epoch?.pages.get(pageId)?.runtime
      if (runtime) return runtime
    }
    return undefined
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
        ? { url, title: location.title, errorText, requestedUrl: url }
        : location
    } catch (error) {
      if (error instanceof BrowserFault) throw error
      if (error instanceof Error && error.message.toLowerCase().includes('timed out')) throw fault('browser_timeout', `navigation to ${url} timed out`)
      throw fault('browser_error', `navigation failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.finishNavigation(execution, tracker, match)
    }
  }

  async historyNavigate(execution: PageExecution, action: 'back' | 'forward' | 'reload'): Promise<NavigationResult> {
    const tracker = this.beginNavigation(execution)
    const startedAt = Date.now()
    const timeoutMs = action === 'reload' ? 10_000 : 30_000
    let requestedUrl = tracker.previousUrl
    let match: { frameId: string; loaderId?: string; url?: string } | undefined
    try {
      let targetEntry: { id: number; url: string } | undefined
      if (action !== 'reload') {
        const history = await this.navigationHistory(execution)
        const current = history.entries[history.currentIndex]
        const targetIndex = history.currentIndex + (action === 'back' ? -1 : 1)
        targetEntry = history.entries[targetIndex]
        if (!current || !targetEntry) return await this.pageLocation(execution)
        requestedUrl = targetEntry.url
      }
      await execution.cdp.send(
        action === 'reload' ? 'Page.reload' : 'Page.navigateToHistoryEntry',
        action === 'reload' ? {} : { entryId: targetEntry!.id },
        execution.binding.sessionId,
        timeoutMs
      )
      const candidate = await this.waitForNavigationEvent(
        tracker,
        (events) => this.navigationCandidate(tracker, events, action !== 'reload'),
        Math.max(0, timeoutMs - (Date.now() - startedAt)),
        `${action} navigation timed out`
      )
      let errorText: string | undefined
      if (candidate.kind === 'loading-failed') {
        errorText = candidate.errorText
        const loaderId = this.loaderForFailedRequest(tracker, candidate.requestId)
        if (loaderId) match = { frameId: tracker.frameId, loaderId }
      } else if (candidate.kind === 'same-document') {
        match = { frameId: candidate.frameId, url: candidate.url }
        if (action !== 'reload' && !await this.historyEntryIsCurrent(execution, targetEntry!.id)) {
          throw fault('browser_tab_changed', 'history navigation was superseded by another page navigation')
        }
      } else if (candidate.kind === 'frame' && candidate.loaderId) {
        match = { frameId: candidate.frameId, loaderId: candidate.loaderId }
        if (candidate.navigationType !== 'BackForwardCacheRestore') {
          const loaded = await this.waitForDocumentLoad(
            tracker,
            candidate.frameId,
            candidate.loaderId,
            Math.max(0, timeoutMs - (Date.now() - startedAt))
          )
          if (loaded.kind === 'loading-failed') errorText = loaded.errorText
        }
        if (!errorText && action !== 'reload' && !await this.historyEntryIsCurrent(execution, targetEntry!.id)) {
          throw fault('browser_tab_changed', 'history navigation was superseded by another page navigation')
        }
      } else {
        throw fault('browser_tab_changed', 'history navigation returned an uncorrelated page event')
      }
      const location = await this.pageLocation(execution)
      if (!errorText && this.generation(execution.page.browserPageId) === execution.binding.pageGeneration) {
        execution.runtimePage.mainFrameUrl = location.url
      }
      return errorText
        ? { url: requestedUrl, title: location.title, errorText, requestedUrl }
        : location
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error)
      if (!this.closingPages.has(execution.page.browserPageId) && !this.changingPages.has(execution.page.browserPageId)) {
        try {
          this.store.updatePage(execution.page.browserPageId, (page) => {
            page.url = requestedUrl
            page.title = ''
            page.loadError = {
              code: error instanceof BrowserFault ? error.reason : 'navigation_failed',
              description: description.slice(0, 300),
              validatedUrl: requestedUrl
            }
          })
        } catch { /* the managed page was removed while navigation failed */ }
      }
      if (error instanceof BrowserFault) throw error
      if (error instanceof Error && error.message.toLowerCase().includes('timed out')) throw fault('browser_timeout', `${action} navigation timed out`)
      throw fault('browser_error', `${action} navigation failed: ${description}`)
    } finally {
      this.finishNavigation(execution, tracker, match)
    }
  }

  async waitForLoadState(
    execution: PageExecution,
    loadState: 'load' | 'domcontentloaded',
    timeoutMs: number
  ): Promise<void> {
    const state = execution.runtimePage
    const frameId = state.mainFrameId
    const loaderId = state.mainFrameLoaderId
    if (!frameId || !loaderId) {
      if (state.mainFrameUrl === 'about:blank') return
      throw fault('browser_tab_changed', 'managed page main frame is not established')
    }
    const completed = loadState === 'load' ? state.loadedLoaders : state.domContentLoadedLoaders
    if (completed.has(loaderId) || state.mainFrameUrl === 'about:blank') return
    const eventName = loadState === 'load' ? 'load' : 'DOMContentLoaded'
    const arrived = Promise.withResolvers<void>()
    const unsubscribe = execution.cdp.subscribe('Page.lifecycleEvent', (event) => {
      if (
        event.sessionId === execution.binding.sessionId &&
        event.params.frameId === frameId &&
        event.params.loaderId === loaderId &&
        event.params.name === eventName
      ) {
        completed.add(loaderId)
        arrived.resolve()
      }
    })
    if (completed.has(loaderId)) {
      unsubscribe()
      return
    }
    const timeout = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const onAbort = () => aborted.resolve()
    execution.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => timeout.resolve(), Math.min(timeoutMs, 95_000))
    try {
      const waits: Promise<'loaded' | 'timeout' | 'aborted'>[] = [
        arrived.promise.then(() => 'loaded' as const),
        timeout.promise.then(() => 'timeout' as const)
      ]
      if (execution.signal) waits.push(aborted.promise.then(() => 'aborted' as const))
      const outcome = await Promise.race(waits)
      if (outcome === 'aborted') {
        await state.termination
        throw fault('browser_tab_closed', 'page load wait was cancelled because its page is closing')
      }
      if (outcome === 'timeout') throw fault('browser_timeout', 'page load condition timed out')
    } finally {
      clearTimeout(timer)
      execution.signal?.removeEventListener('abort', onAbort)
      unsubscribe()
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

  private navigationCandidate(tracker: NavigationTracker, events: NavigationEvent[], allowSameDocument: boolean): NavigationEvent | undefined {
    for (const event of events) {
      if (event.kind === 'frame' && event.frameId === tracker.frameId && event.loaderId && event.loaderId !== tracker.previousLoaderId) return event
      if (allowSameDocument && event.kind === 'same-document' && event.frameId === tracker.frameId) return event
      if (event.kind === 'document-request' && event.frameId === tracker.frameId && event.loaderId !== tracker.previousLoaderId) {
        const failure = this.documentFailure(tracker, event.frameId, event.loaderId)
        if (failure) return failure
      }
    }
    return undefined
  }

  private loaderForFailedRequest(tracker: NavigationTracker, requestId: string): string | undefined {
    const request = tracker.events.find((event) => event.kind === 'document-request' && event.requestId === requestId)
    return request?.kind === 'document-request' ? request.loaderId : undefined
  }

  private async navigationHistory(execution: PageExecution): Promise<{ currentIndex: number; entries: Array<{ id: number; url: string }> }> {
    const history = safeRecord(await execution.cdp.send('Page.getNavigationHistory', {}, execution.binding.sessionId), {
      type: 'object',
      properties: {
        currentIndex: { type: 'integer' },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'integer' }, url: { type: 'string' } },
            required: ['id', 'url'],
            additionalProperties: true
          }
        }
      },
      required: ['currentIndex', 'entries'],
      additionalProperties: true
    }, 'navigation history')
    const entries = (history.entries as unknown[]).map((entry) => {
      const value = safeRecord(entry, {
        type: 'object',
        properties: { id: { type: 'integer' }, url: { type: 'string' } },
        required: ['id', 'url'],
        additionalProperties: true
      }, 'navigation history entry')
      return { id: value.id as number, url: value.url as string }
    })
    return { currentIndex: history.currentIndex as number, entries }
  }

  private async historyEntryIsCurrent(execution: PageExecution, id: number): Promise<boolean> {
    const history = await this.navigationHistory(execution)
    return history.entries[history.currentIndex]?.id === id
  }

  private finishNavigation(
    execution: PageExecution,
    tracker: NavigationTracker,
    match?: { frameId: string; loaderId?: string; url?: string }
  ): void {
    const state = execution.runtimePage
    if (state.pendingNavigation !== tracker) return
    state.pendingNavigation = undefined
    if (this.closingPages.has(execution.page.browserPageId) || this.changingPages.has(execution.page.browserPageId)) return
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
          this.observeMainFrameNavigation(epoch, binding, event.frameId, event.loaderId, event.url, event.navigationType)
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
    if (match.loaderId) {
      for (const loader of state.domContentLoadedLoaders) if (loader !== match.loaderId) state.domContentLoadedLoaders.delete(loader)
      for (const loader of state.loadedLoaders) if (loader !== match.loaderId) state.loadedLoaders.delete(loader)
    }
  }
  async answerDialog(pageId: string, accept: boolean, text?: string): Promise<void> {
    const stored = this.store.getPage(pageId)
    const profile = this.profile(stored.profileId)
    const epoch = profile.epoch
    const binding = epoch?.pages.get(pageId)
    if (!epoch || epoch.invalid || !binding) throw fault('browser_tab_changed', 'dialog page binding is no longer live')
    const pending = binding.runtime.pendingDialog
    if (!pending) throw fault('browser_error', 'there is no pending JavaScript dialog for this page')
    if (pending.browserEpoch !== epoch.id || pending.pageGeneration !== this.generation(pageId) || binding.generation !== this.generation(pageId)) {
      throw fault('browser_tab_changed', 'pending dialog belongs to a stale page generation')
    }
    if (pending.responding) throw fault('browser_error', 'the pending dialog is already being answered')
    pending.responding = true
    try {
      await epoch.cdp.send('Page.handleJavaScriptDialog', {
        accept,
        ...(text === undefined ? {} : { promptText: text })
      }, binding.sessionId, 5_000)
      if (epoch.invalid || this.store.getPage(pageId).profileId !== stored.profileId || this.generation(pageId) !== pending.pageGeneration) {
        throw fault('browser_tab_changed', 'page binding changed while the dialog response was sent')
      }
    } catch (error) {
      if (error instanceof BrowserFault) throw error
      try { this.store.getPage(pageId) } catch { throw fault('browser_tab_closed', 'dialog page was closed while responding') }
      throw fault('browser_error', 'JavaScript dialog response failed')
    } finally {
      if (binding.runtime.pendingDialog === pending) binding.runtime.pendingDialog = undefined
    }
  }

  testControl(): BrowserTestControl {
    return {
      crashHelper: async (profileId) => {
        const epoch = this.profile(profileId).epoch
        if (!epoch) throw fault('browser_error', 'no owned browser helper is running for that profile')
        epoch.helper.child.kill('SIGKILL')
        await epoch.helper.child.exited
      },
      crashChrome: async (profileId) => {
        const epoch = this.profile(profileId).epoch
        if (!epoch) throw fault('browser_error', 'no owned Chrome process is running for that profile')
        epoch.chrome.child.kill('SIGKILL')
        await epoch.chrome.child.exited
      }
    }
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
    if (epoch.cookiePageId === pageId) {
      epoch.cookiePageId = undefined
      epoch.cookiePage = undefined
    }
  }
  private async ensureBinding(epoch: RuntimeEpoch, page: BrowserPage, generation: number): Promise<BoundPage> {
    const existing = epoch.pages.get(page.browserPageId)
    if (existing && existing.generation === generation) return existing
    if (existing) await this.closeBinding(epoch, page.browserPageId, existing)
    this.invalidateHelperReferences(epoch)
    const created = await nativeRequest(epoch.helper.socketPath, 'tab_new', { url: 'about:blank' }, 10_000)
    const tab = nativeData<TabCreated>(created, TAB_CREATED_SCHEMA, 'new tab')
    epoch.activeTabId = tab.tabId
    const binding = await this.bindFreshPage(epoch, page, generation, tab.tabId)
    epoch.pages.set(page.browserPageId, binding)
    await this.enablePageDomains(epoch, binding)
    await this.applySettings(epoch, binding, this.pageSettings(page.browserPageId), page.url)
    await this.navigateRetainedPage(epoch, page, binding)
    return binding
  }
  private async ensureCookieTarget(epoch: RuntimeEpoch): Promise<BoundPage> {
    if (epoch.cookiePage && epoch.cookiePageId) return epoch.cookiePage
    const pageId = `internal_cookie_${randomUUID()}`
    const page: BrowserPage = {
      browserPageId: pageId,
      worktreeId: null,
      profileId: epoch.profileId,
      index: -1,
      active: false,
      url: 'about:blank',
      title: '',
      loadError: null
    }
    this.invalidateHelperReferences(epoch)
    const created = await nativeRequest(epoch.helper.socketPath, 'tab_new', { url: 'about:blank' }, 10_000)
    const tab = nativeData<TabCreated>(created, TAB_CREATED_SCHEMA, 'cookie control tab')
    epoch.activeTabId = tab.tabId
    const binding = await this.bindFreshPage(epoch, page, 0, tab.tabId)
    epoch.pages.set(pageId, binding)
    await this.enablePageDomains(epoch, binding)
    epoch.cookiePageId = pageId
    epoch.cookiePage = binding
    return binding
  }

  private async readCdpCookies(epoch: RuntimeEpoch): Promise<Cookie[]> {
    const value = await epoch.cdp.send('Storage.getCookies')
    const data = safeRecord(value, COOKIE_LIST_SCHEMA, 'cookie list')
    const rows = data.cookies as unknown[]
    const cookies: Cookie[] = []
    for (const item of rows) {
      const row = safeRecord(item, COOKIE_LIST_SCHEMA.properties!.cookies!.items as Schema, 'cookie')
      const domain = row.domain as string
      const sameSite = row.sameSite === 'Strict' || row.sameSite === 'Lax' || row.sameSite === 'None' ? row.sameSite : undefined
      const partition = row.partitionKey
      let partitionKey: Cookie['partitionKey']
      if (partition !== undefined) {
        const key = safeRecord(partition, {
          type: 'object',
          properties: { topLevelSite: { type: 'string' }, hasCrossSiteAncestor: { type: 'boolean' } },
          required: ['topLevelSite', 'hasCrossSiteAncestor'],
          additionalProperties: true
        }, 'cookie partition key')
        partitionKey = { topLevelSite: key.topLevelSite as string, hasCrossSiteAncestor: key.hasCrossSiteAncestor as boolean }
      }
      cookies.push({
        name: row.name as string,
        value: row.value as string,
        domain,
        path: row.path as string,
        secure: row.secure as boolean,
        httpOnly: row.httpOnly as boolean,
        hostOnly: !domain.startsWith('.'),
        ...(sameSite ? { sameSite } : {}),
        ...(typeof row.expires === 'number' && row.expires > 0 ? { expires: row.expires } : {}),
        ...(partitionKey ? { partitionKey } : {})
      })
    }
    return cookies
  }

  private async setCdpCookie(epoch: RuntimeEpoch, binding: BoundPage, cookie: Cookie): Promise<void> {
    const host = canonicalCookieDomain(cookie.domain)
    const params: Record<string, unknown> = {
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      ...(cookie.hostOnly ? { url: `${cookie.secure ? 'https' : 'http'}://${host}/` } : { domain: `.${host}` }),
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {})
    }
    const result = safeRecord(await epoch.cdp.send('Network.setCookie', params, binding.sessionId), COOKIE_SET_SCHEMA, 'cookie write')
    if (result.success !== true) throw fault('browser_error', 'Chrome rejected the requested cookie write')
  }

  private async deleteCdpCookie(epoch: RuntimeEpoch, binding: BoundPage, cookie: Cookie): Promise<void> {
    const before = await this.readCdpCookies(epoch)
    if (!before.some((candidate) => this.sameCookieIdentity(candidate, cookie))) return
    const siblings = before.filter((candidate) =>
      candidate.name === cookie.name && canonicalCookieDomain(candidate.domain) === canonicalCookieDomain(cookie.domain) && candidate.path === cookie.path &&
      !this.sameCookieIdentity(candidate, cookie)
    )
    const host = canonicalCookieDomain(cookie.domain)
    await epoch.cdp.send('Network.deleteCookies', {
      name: cookie.name,
      path: cookie.path,
      ...(cookie.hostOnly ? { url: `${cookie.secure ? 'https' : 'http'}://${host}/` } : { domain: `.${host}` }),
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {})
    }, binding.sessionId)
    let remaining = await this.readCdpCookies(epoch)
    if (remaining.some((candidate) => this.sameCookieIdentity(candidate, cookie))) throw fault('browser_error', 'Chrome did not delete the selected cookie identity')
    try {
      for (const sibling of siblings) {
        if (!remaining.some((candidate) => this.sameCookieIdentity(candidate, sibling))) {
          await this.setCdpCookie(epoch, binding, sibling)
          remaining = await this.readCdpCookies(epoch)
        }
      }
    } catch {
      throw fault('browser_unsafe_replace', 'Chrome could not restore sibling cookie identities after exact deletion')
    }
    if (siblings.some((sibling) => !remaining.some((candidate) => this.sameCookieIdentity(candidate, sibling)))) {
      throw fault('browser_unsafe_replace', 'Chrome did not preserve sibling cookie identities during exact deletion')
    }
  }

  private sameCookieIdentity(a: Cookie, b: Cookie): boolean {
    return a.name === b.name && canonicalCookieDomain(a.domain) === canonicalCookieDomain(b.domain) && a.path === b.path && a.hostOnly === b.hostOnly &&
      a.partitionKey?.topLevelSite === b.partitionKey?.topLevelSite &&
      a.partitionKey?.hasCrossSiteAncestor === b.partitionKey?.hasCrossSiteAncestor
  }

  private async bindFreshPage(epoch: RuntimeEpoch, page: BrowserPage, generation: number, tabId: string): Promise<BoundPage> {
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
        if (target.type !== 'page') continue
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
        binding: { browserEpoch: epoch.id, pageGeneration: generation, targetId, sessionId, tabId },
        consoleEntries: [],
        networkEntries: [],
        networkById: new Map(),
        harEntries: [],
        interceptRequests: [],
        domContentLoadedLoaders: new Set(),
        loadedLoaders: new Set()
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
    await epoch.cdp.send('Network.enable', { maxTotalBufferSize: 50 * 1024 * 1024, maxResourceBufferSize: 10 * 1024 * 1024 }, sessionId)
    await epoch.cdp.send('Log.enable', {}, sessionId)
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
      const navigationType = asString(event.params.type)
      const navigationEvent: NavigationEvent = {
        kind: 'frame',
        frameId,
        ...(loaderId ? { loaderId } : {}),
        url,
        ...(navigationType ? { navigationType } : {})
      }
      if (this.pushNavigationEvent(state, navigationEvent)) return
      this.observeMainFrameNavigation(epoch, binding, frameId, loaderId, url, navigationType)
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
      if (name === 'DOMContentLoaded') state.domContentLoadedLoaders.add(loaderId)
      if (name === 'load') state.loadedLoaders.add(loaderId)
      if (this.pushNavigationEvent(state, navigationEvent)) return
      if (name === 'load' && loaderId === state.mainFrameLoaderId) {
        const generation = this.generation(binding.pageId)
        void this.refreshSpontaneousTitle(epoch, binding, generation, loaderId).catch(() => {})
      }
    })
    epoch.cdp.subscribe('Runtime.consoleAPICalled', (event) => {
      if (event.sessionId !== binding.sessionId || validateValue(EVENT_CONSOLE_SCHEMA, event.params, 'console event')) return
      const args = event.params.args as Array<Record<string, unknown>>
      const text = args.map((arg) => {
        const value = arg.value ?? arg.description ?? arg.unserializableValue
        return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
      }).join(' ')
      const stack = event.params.stackTrace as Record<string, unknown> | undefined
      const frames = Array.isArray(stack?.callFrames) ? stack.callFrames : []
      const frame = frames[0] as Record<string, unknown> | undefined
      const frameUrl = asString(frame?.url)
      const frameLine = frame?.lineNumber
      state.consoleEntries.push({
        level: asString(event.params.type) ?? 'log',
        text: text.slice(0, 100_000),
        timestamp: asFiniteNumber(event.params.timestamp) ?? Date.now() / 1000,
        ...(frameUrl === undefined ? {} : { url: frameUrl }),
        ...(typeof frameLine === 'number' ? { line: frameLine + 1 } : {})
      })
      if (state.consoleEntries.length > 10_000) state.consoleEntries.splice(0, state.consoleEntries.length - 10_000)
    })
    epoch.cdp.subscribe('Network.requestWillBeSent', (event) => {
      if (event.sessionId !== binding.sessionId || validateValue(EVENT_NETWORK_REQUEST_SCHEMA, event.params, 'network request event')) return
      const request = event.params.request as Record<string, unknown>
      const url = asString(request.url)
      const method = asString(request.method)
      const requestId = asString(event.params.requestId)
      const resourceType = asString(event.params.type)
      const frameId = asString(event.params.frameId)
      const loaderId = asString(event.params.loaderId)
      if (resourceType === 'Document' && frameId && loaderId && requestId) {
        this.pushNavigationEvent(state, { kind: 'document-request', requestId, frameId, loaderId })
      }
      if (!url || !method || !requestId) return
      const timestamp = asFiniteNumber(event.params.wallTime) ?? asFiniteNumber(event.params.timestamp) ?? Date.now() / 1000
      const record: NetworkEntry = { url, method, status: 0, mimeType: '', size: 0, timestamp }
      state.networkEntries.push(record)
      state.networkById.set(requestId, record)
      if (state.networkEntries.length > 10_000) {
        const removed = state.networkEntries.splice(0, state.networkEntries.length - 10_000)
        for (const [id, entry] of state.networkById) if (removed.includes(entry)) state.networkById.delete(id)
      }
      if (state.captureStartedAt === undefined || timestamp < state.captureStartedAt) return
      const headers = headersAsStrings(request.headers)
      let queryString: Array<{ name: string; value: string }> = []
      try { queryString = [...new URL(url).searchParams].map(([name, value]) => ({ name, value })) } catch { /* the original URL remains in HAR */ }
      const postData = asString(request.postData)
      state.harEntries.push({
        startedDateTime: new Date(timestamp * 1000).toISOString(),
        time: 0,
        request: {
          method,
          url,
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
          queryString,
          cookies: [],
          headersSize: -1,
          bodySize: postData === undefined ? 0 : Buffer.byteLength(postData),
          ...(postData === undefined ? {} : { postData: { mimeType: asString(headers['content-type']) ?? '', text: postData } })
        },
        response: {
          status: 0,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          headers: [],
          cookies: [],
          content: { size: 0, mimeType: '' },
          redirectURL: '',
          headersSize: -1,
          bodySize: 0
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
        _requestId: requestId
      })
    })
    epoch.cdp.subscribe('Network.responseReceived', (event) => {
      if (event.sessionId !== binding.sessionId) return
      const requestId = asString(event.params.requestId)
      const response = event.params.response
      if (!requestId || validateValue({
        type: 'object',
        properties: {
          status: { type: 'number' },
          mimeType: { type: 'string' },
          url: { type: 'string' },
          statusText: { type: 'string' },
          headers: { type: 'object' }
        },
        required: ['status', 'mimeType'],
        additionalProperties: true
      }, response, 'network response')) return
      const typed = response as Record<string, unknown>
      const record = state.networkById.get(requestId)
      if (record) {
        record.status = asFiniteNumber(typed.status) ?? 0
        record.mimeType = asString(typed.mimeType) ?? ''
      }
      const har = this.harEntry(state, requestId)
      if (!har) return
      const responseValue = har.response as Record<string, JsonValue>
      responseValue.status = asFiniteNumber(typed.status) ?? 0
      responseValue.statusText = asString(typed.statusText) ?? ''
      responseValue.headers = Object.entries(headersAsStrings(typed.headers)).map(([name, value]) => ({ name, value }))
      const content = responseValue.content as Record<string, JsonValue>
      content.mimeType = asString(typed.mimeType) ?? ''
    })
    epoch.cdp.subscribe('Network.loadingFinished', (event) => {
      if (event.sessionId !== binding.sessionId) return
      const requestId = asString(event.params.requestId)
      if (!requestId) return
      const size = asFiniteNumber(event.params.encodedDataLength) ?? 0
      const record = state.networkById.get(requestId)
      if (record) record.size = size
      this.finishHarEntry(state, requestId, size, '')
    })
    epoch.cdp.subscribe('Network.loadingFailed', (event) => {
      if (event.sessionId !== binding.sessionId) return
      const requestId = asString(event.params.requestId)
      if (!requestId) return
      const errorText = asString(event.params.errorText) ?? 'network error'
      const tracker = state.pendingNavigation
      if (tracker?.events.some((candidate) => candidate.kind === 'document-request' && candidate.requestId === requestId)) {
        this.pushNavigationEvent(state, { kind: 'loading-failed', requestId, errorText, canceled: event.params.canceled === true })
      }
      this.finishHarEntry(state, requestId, 0, errorText)
    })
    epoch.cdp.subscribe('Fetch.requestPaused', (event) => {
      if (event.sessionId !== binding.sessionId || validateValue({
        type: 'object',
        properties: { requestId: { type: 'string' }, request: { type: 'object' }, resourceType: { type: 'string' } },
        required: ['requestId', 'request', 'resourceType'],
        additionalProperties: true
      }, event.params, 'intercepted request')) return
      const params = event.params as Record<string, unknown>
      const requestData = params.request as Record<string, unknown>
      state.interceptRequests.push({
        id: params.requestId as string,
        url: asString(requestData.url) ?? '',
        method: asString(requestData.method) ?? 'GET',
        headers: headersAsStrings(requestData.headers),
        resourceType: params.resourceType as string
      })
      if (state.interceptRequests.length > 10_000) state.interceptRequests.splice(0, state.interceptRequests.length - 10_000)
      void epoch.cdp.send('Fetch.continueRequest', { requestId: params.requestId }, binding.sessionId)
        .catch((error) => this.invalidateEpoch(this.profile(epoch.profileId), epoch, error instanceof Error ? error.message : String(error)))
    })
    epoch.cdp.subscribe('Fetch.authRequired', (event) => {
      if (event.sessionId !== binding.sessionId) return
      const credentials = this.pageSettings(binding.pageId).credentials
      const requestId = asString(event.params.requestId)
      if (!credentials || !requestId) return
      void epoch.cdp.send('Fetch.continueWithAuth', {
        requestId,
        authChallengeResponse: { response: 'ProvideCredentials', username: credentials.user, password: credentials.pass }
      }, binding.sessionId).catch((error) => this.invalidateEpoch(this.profile(epoch.profileId), epoch, error instanceof Error ? error.message : String(error)))
    })
    epoch.cdp.subscribe('Page.javascriptDialogOpening', (event) => {
      if (event.sessionId !== binding.sessionId || validateValue({
        type: 'object',
        properties: { type: { type: 'string' }, url: { type: 'string' }, message: { type: 'string' } },
        required: ['type', 'url', 'message'],
        additionalProperties: true
      }, event.params, 'JavaScript dialog')) return
      const data = event.params as Record<string, unknown>
      const type = data.type as PendingDialog['type']
      if (!['alert', 'confirm', 'prompt', 'beforeunload'].includes(type)) return
      state.pendingDialog = {
        token: randomUUID(),
        browserEpoch: epoch.id,
        pageGeneration: binding.generation,
        type,
        url: data.url as string,
        message: (data.message as string).slice(0, 10_000),
        responding: false
      }
      this.dependencies.onDialog?.({ pageId: binding.pageId, type })
    })
    epoch.cdp.subscribe('Page.javascriptDialogClosed', (event) => {
      if (event.sessionId === binding.sessionId) state.pendingDialog = undefined
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
    url: string,
    _navigationType?: string
  ): void {
    const state = binding.runtime
    if (!state.navigationReady) return
    const changed = frameId !== state.mainFrameId || loaderId !== state.mainFrameLoaderId || url !== state.mainFrameUrl
    if (loaderId !== state.mainFrameLoaderId) {
      state.domContentLoadedLoaders.clear()
      state.loadedLoaders.clear()
    }
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
    if (page.profileId !== epoch.profileId || this.closingPages.has(binding.pageId) || this.changingPages.has(binding.pageId)) return
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

  private harEntry(state: RuntimePageState, requestId: string): Record<string, JsonValue> | undefined {
    const entry = state.harEntries.find((candidate) =>
      typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate) &&
      (candidate as Record<string, JsonValue>)._requestId === requestId
    )
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, JsonValue> : undefined
  }

  private finishHarEntry(state: RuntimePageState, requestId: string, size: number, error: string): void {
    const entry = this.harEntry(state, requestId)
    if (!entry) return
    entry.time = 0
    if (error !== '') entry._failure = error
    const response = entry.response as Record<string, JsonValue>
    response.bodySize = size
    const content = response.content as Record<string, JsonValue>
    content.size = size
  }

  private async applySettings(epoch: RuntimeEpoch, binding: BoundPage, settings: PageSettings, pageUrl: string): Promise<void> {
    const sessionId = binding.sessionId
    if (settings.viewport) {
      await epoch.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: Math.round(settings.viewport.width),
        height: Math.round(settings.viewport.height),
        deviceScaleFactor: settings.viewport.deviceScaleFactor,
        mobile: settings.viewport.mobile
      }, sessionId)
    }
    if (settings.geolocation) {
      const origin = new URL(pageUrl).origin
      if (origin !== 'null') await epoch.cdp.send('Browser.setPermission', { origin, permission: { name: 'geolocation' }, setting: 'granted' })
      await epoch.cdp.send('Emulation.setGeolocationOverride', {
        latitude: settings.geolocation.latitude,
        longitude: settings.geolocation.longitude,
        accuracy: settings.geolocation.accuracy
      }, sessionId)
    }
    if (settings.userAgent) await epoch.cdp.send('Emulation.setUserAgentOverride', { userAgent: settings.userAgent }, sessionId)
    if (settings.offline) await epoch.cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none' }, sessionId)
    if (settings.headers) await epoch.cdp.send('Network.setExtraHTTPHeaders', { headers: settings.headers }, sessionId)
    if (settings.colorScheme !== undefined || settings.reducedMotion !== undefined) {
      await epoch.cdp.send('Emulation.setEmulatedMedia', {
        features: [
          ...(settings.colorScheme === undefined || settings.colorScheme === null ? [] : [{ name: 'prefers-color-scheme', value: settings.colorScheme }]),
          ...(settings.reducedMotion === undefined || settings.reducedMotion === null ? [] : [{ name: 'prefers-reduced-motion', value: settings.reducedMotion }])
        ]
      }, sessionId)
    }
    if (settings.routes.length > 0 || settings.credentials) {
      await epoch.cdp.send('Fetch.enable', {
        ...(settings.routes.length > 0 ? { patterns: settings.routes.map((urlPattern) => ({ urlPattern: urlPattern.replaceAll('**', '*'), requestStage: 'Request' })) } : {}),
        ...(settings.credentials ? { handleAuthRequests: true } : {})
      }, sessionId)
    }
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
      settings: this.pageSettings(page.browserPageId),
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
      const runtimePage = epoch.pages.get(page.browserPageId)?.runtime
      if (runtimePage) runtimePage.pendingDialog = undefined
      this.invalidatePage(page.browserPageId, false)
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
