import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { validateValue, type Schema } from '@quirky/protocol'
import { fault, BrowserFault } from './errors'
import { CdpConnection } from './cdp'
import { startChrome, type OwnedChrome } from './chrome'
import { FifoLock } from './lock'
import { nativeData } from './native-response'
import { NativeTransportError, nativeRequest, startNativeHelper, type NativeHelper, type NativeResponse } from './native'
import type { BrowserDependencies, BrowserTestControl } from './dependencies'
import type { BrowserPage } from '../profiles/store'
import { BrowserStore } from '../profiles/store'
import type { BrowserIdentityMode } from '../preferences/contract'
import { identityModeFromSetting, userAgentForIdentity } from '../preferences/identity'


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
  userAgent?: string
  invalid: boolean
  stopping: boolean
  teardown?: Promise<void>
}

type ProfileRuntime = {
  lock: FifoLock
  epoch?: RuntimeEpoch
  starting?: Promise<RuntimeEpoch>
  lossReported: boolean
  failureReason?: string
  clearing: boolean
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
const BROWSER_VERSION_SCHEMA: Schema = {
  type: 'object',
  properties: { userAgent: { type: 'string' } },
  required: ['userAgent'],
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

  private readonly identityMode: BrowserIdentityMode
  constructor(
    private readonly store: BrowserStore,
    private readonly dependencies: BrowserDependencies,
    private readonly onPageInvalidated: (pageId: string) => void,
    identityMode: unknown = 'clean'
  ) {
    this.identityMode = identityModeFromSetting(identityMode)
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
    }
    return generation
  }


  async withPage<T>(page: BrowserPage, method: string, operation: (execution: PageExecution) => Promise<T>): Promise<T> {
    const profile = this.profile(page.profileId)
    if (profile.clearing) throw fault('browser_error', 'browser profile is being cleared')
    const expectedGeneration = this.generation(page.browserPageId)
    const controller = new AbortController()
    const controllers = profile.controllers.get(page.browserPageId) ?? new Set<AbortController>()
    controllers.add(controller)
    profile.controllers.set(page.browserPageId, controllers)
    try {
      return await profile.lock.run(async () => {
        if (profile.clearing) throw fault('browser_error', 'browser profile is being cleared')
        if (this.closingPages.has(page.browserPageId)) throw fault('browser_tab_closed', 'the managed page is closing')
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
    if (profile.clearing) throw fault('browser_error', 'browser profile is being cleared')
    try {
      return await profile.lock.run(async () => {
        if (profile.clearing) throw fault('browser_error', 'browser profile is being cleared')
        return await operation()
      })
    } catch (error) {
      const transportFailure = this.profileTransportFailure(profile, error)
      if (transportFailure) throw transportFailure
      throw error
    }
  }

  async withProfileMaintenance<T>(profileId: string, operation: () => Promise<T> | T): Promise<T> {
    this.store.getProfile(profileId)
    const profile = this.profile(profileId)
    if (profile.clearing) throw fault('browser_error', 'browser profile maintenance is already in progress')
    profile.clearing = true
    try {
      for (const controllers of profile.controllers.values()) {
        for (const controller of controllers) controller.abort()
      }

      const starting = profile.starting
      if (starting) {
        try { await starting } catch { /* a failed startup leaves no browser data operation in flight */ }
      }

      const epoch = profile.epoch
      if (epoch) {
        epoch.stopping = true
        const bindings = [...epoch.pages.values()]
        for (const binding of bindings) this.startPageTermination(binding.runtime)
        for (const page of this.store.listPages()) {
          if (page.profileId === profileId) this.invalidatePage(page.browserPageId, false)
        }
        for (const controllers of profile.controllers.values()) {
          for (const controller of controllers) controller.abort()
        }
        try {
          await this.teardownEpoch(epoch)
        } finally {
          for (const binding of bindings) this.finishPageTermination(binding.runtime)
          if (profile.epoch === epoch) profile.epoch = undefined
        }
      }

      return await profile.lock.run(async () => {
        if (profile.starting || profile.epoch) {
          throw fault('browser_error', 'browser profile did not quiesce before maintenance')
        }
        return await operation()
      })
    } finally {
      profile.clearing = false
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
      profile = { lock: new FifoLock(), lossReported: false, clearing: false, controllers: new Map() }
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
    const created = await nativeRequest(epoch.helper.socketPath, 'tab_new', { url: 'about:blank' }, 10_000)
    const tab = nativeData<TabCreated>(created, TAB_CREATED_SCHEMA, 'new tab')
    epoch.activeTabId = tab.tabId
    const binding = await this.bindFreshPage(epoch, page, generation, tab.tabId)
    epoch.pages.set(page.browserPageId, binding)
    await this.enablePageDomains(epoch, binding)
    await this.navigateRetainedPage(epoch, page, binding)
    return binding
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
    let userAgent = epoch.userAgent
    if (!userAgent) {
      const version = safeRecord(await epoch.cdp.send('Browser.getVersion'), BROWSER_VERSION_SCHEMA, 'browser version')
      const actualUserAgent = version.userAgent
      if (typeof actualUserAgent !== 'string' || actualUserAgent.length === 0) {
        throw fault('browser_error', 'owned Chrome did not report its user agent')
      }
      userAgent = userAgentForIdentity(this.identityMode, actualUserAgent)
      epoch.userAgent = userAgent
    }
    await epoch.cdp.send('Network.setUserAgentOverride', { userAgent }, sessionId)
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
