import { randomUUID } from 'node:crypto'
import { RpcErrorCode, type MobileBrowserFrame, type MobileMarkdownDocument, type MobileWorkspaceTab, type PluginCaller, type PluginContext, type QuirkyEvent } from '@quirky/protocol'

const MAX_MARKDOWN_BYTES = 64 * 1024
const MAX_FRAME_BASE64_BYTES = 512 * 1024
const MAX_WATCH_LEASES = 4
const MAX_NAME_LENGTH = 128
const MAX_NAVIGATION_BYTES = 2048
const MARKDOWN_NOTE_PREFIX = 'Phone note '
const MOBILE_VIEWPORT = 'mobile-m'
const VIEWPORTS = ['default', 'mobile-s', 'mobile-m', 'mobile-l', 'tablet', 'laptop', 'laptop-l', 'desktop'] as const

type MarkdownMode = 'source' | 'rich' | 'preview'
type BrowserMode = 'native' | 'watch'
type MobileWatchResult = { tab: MobileWorkspaceTab; watchId: string }
type BrowserControlAction = 'back' | 'forward' | 'reload' | 'stop' | 'find' | 'zoom' | 'viewport'
type EditorBufferState = {
  id: string
  worktreeId: string
  relativePath: string
  name: string
  kind: string
  mode: MarkdownMode
  readOnly: boolean
  dirty: boolean
  contentRevision: number
  contentBytes: number
  draftBytes: number | null
}
type EditorTabState = { tabId: string; bufferId: string; mode: 'edit' | 'preview'; group?: string }
type EditorState = { buffers: EditorBufferState[]; tabs: EditorTabState[] }
type BrowserPaneState = {
  id: string
  worktreeId: string
  mode: BrowserMode
  tabId: string
  title: string
  page: string | null
  viewport: typeof VIEWPORTS[number]
}
type OwnedBrowserWatch = {
  connectionId: number
  worktreeId: string
  tabId: string
  paneId: string
  pageId: string | null
  watchId: string | null
  previousViewport: typeof VIEWPORTS[number]
  pendingFrame: MobileBrowserFrame | null
  frameError: string | null
  disconnected: boolean
  closed: boolean
  removeConnectionClose: (() => void) | null
  operations: Promise<void>
  startPromise: Promise<MobileWatchResult> | null
}
type WorkspaceReply = { id: string }
type EditorMutation = { path: string }
type BrowserOpenResult = { id: string; worktreeId: string; mode: BrowserMode; page: string | null; title: string; tabId: string; viewport: string }
type BrowserOperationResult = { closed?: boolean; watchId?: string; acknowledged?: boolean; sent?: boolean }

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function requireString(context: PluginContext, params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim() === '') throw context.error('invalid-params', `${key} must be a non-empty string.`)
  return value
}

function requireRevision(context: PluginContext, params: Record<string, unknown>): number {
  const value = params.expectedRevision
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    throw context.error('invalid-params', 'expectedRevision must be a non-negative safe integer.')
  }
  return value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeTitle(value: string, fallback = 'Untitled'): string {
  const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 128)
  return title || fallback
}

function unavailableMethod(error: unknown, pluginId: string, method: string): boolean {
  const record = objectValue(error)
  const message = error instanceof Error ? error.message : ''
  if (record?.code === RpcErrorCode.NotFound && message.includes(`no contribution ${pluginId}/${method} is in effect`)) return true
  if (record?.code === RpcErrorCode.MethodNotFound && message === `unknown method: ${pluginId}/${method}`) return true
  return record?.code === RpcErrorCode.Conflict && (message === `${pluginId} is disabled` || message === `${pluginId} is invalid`)
}

function staleWatchLease(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Watch lease ID is stale')
}

function expectedShutdownProviderLoss(error: unknown): boolean {
  const record = objectValue(error)
  const message = error instanceof Error ? error.message : ''
  return (record?.code === RpcErrorCode.NotFound && message.includes('no contribution quirky.browser/')) ||
    (record?.code === RpcErrorCode.Conflict && message === 'the plugin host is stopped') ||
    message === 'browser pane service is shutting down' ||
    message === 'browser plugin is shutting down'
}

function editorStateValue(context: PluginContext, value: unknown, worktreeId: string): EditorState {
  const state = objectValue(value)
  if (!state || !Array.isArray(state.buffers) || !Array.isArray(state.tabs)) {
    throw context.error('conflict', 'The editor returned an invalid tab state.')
  }
  const buffers: EditorBufferState[] = []
  for (const item of state.buffers) {
    const buffer = objectValue(item)
    if (!buffer || typeof buffer.id !== 'string' || typeof buffer.worktreeId !== 'string' ||
      typeof buffer.relativePath !== 'string' || typeof buffer.name !== 'string' || typeof buffer.kind !== 'string' ||
      (buffer.mode !== 'source' && buffer.mode !== 'rich' && buffer.mode !== 'preview') ||
      typeof buffer.readOnly !== 'boolean' || typeof buffer.dirty !== 'boolean' ||
      !Number.isSafeInteger(buffer.contentRevision) || typeof buffer.contentRevision !== 'number' ||
      !Number.isSafeInteger(buffer.contentBytes) || typeof buffer.contentBytes !== 'number' ||
      (buffer.draftBytes !== null && (!Number.isSafeInteger(buffer.draftBytes) || typeof buffer.draftBytes !== 'number'))) {
      throw context.error('conflict', 'The editor returned invalid buffer metadata.')
    }
    if (buffer.worktreeId === worktreeId) {
      buffers.push({
        id: buffer.id,
        worktreeId: buffer.worktreeId,
        relativePath: buffer.relativePath,
        name: buffer.name,
        kind: buffer.kind,
        mode: buffer.mode,
        readOnly: buffer.readOnly,
        dirty: buffer.dirty,
        contentRevision: buffer.contentRevision,
        contentBytes: buffer.contentBytes,
        draftBytes: buffer.draftBytes
      })
    }
  }
  const tabs: EditorTabState[] = []
  for (const item of state.tabs) {
    const tab = objectValue(item)
    if (!tab || typeof tab.tabId !== 'string' || typeof tab.bufferId !== 'string' || (tab.mode !== 'edit' && tab.mode !== 'preview')) {
      throw context.error('conflict', 'The editor returned invalid UI tab metadata.')
    }
    if (tab.group !== undefined && typeof tab.group !== 'string') throw context.error('conflict', 'The editor returned an invalid UI tab group.')
    tabs.push({ tabId: tab.tabId, bufferId: tab.bufferId, mode: tab.mode, ...(typeof tab.group === 'string' ? { group: tab.group } : {}) })
  }
  return { buffers, tabs }
}

function browserPaneValue(context: PluginContext, value: unknown, worktreeId: string): BrowserPaneState[] {
  const state = objectValue(value)
  if (!state || !Array.isArray(state.tabs)) throw context.error('conflict', 'Browser returned an invalid pane state.')
  const panes: BrowserPaneState[] = []
  for (const item of state.tabs) {
    const pane = objectValue(item)
    if (!pane || typeof pane.id !== 'string' || typeof pane.worktreeId !== 'string' ||
      (pane.mode !== 'native' && pane.mode !== 'watch') || typeof pane.title !== 'string' ||
      (pane.page !== null && typeof pane.page !== 'string')) {
      throw context.error('conflict', 'Browser returned invalid hosted-tab metadata.')
    }
    if (typeof pane.tabId !== 'string') continue
    if (pane.viewport !== undefined && typeof pane.viewport !== 'string') throw context.error('conflict', 'Browser returned an invalid viewport.')
    if (pane.worktreeId === worktreeId) {
      panes.push({
        id: pane.id,
        worktreeId: pane.worktreeId,
        mode: pane.mode,
        tabId: pane.tabId,
        title: safeTitle(pane.title, 'Browser'),
        page: typeof pane.page === 'string' ? pane.page : null,
        viewport: (VIEWPORTS as readonly string[]).includes(pane.viewport as string) ? pane.viewport as BrowserPaneState['viewport'] : 'default'
      })
    }
  }
  return panes
}

function visitTerminalGroups(node: unknown, titles: Map<string, string>): void {
  const group = objectValue(node)
  if (!group) return
  if (Array.isArray(group.tabs)) {
    for (const item of group.tabs) {
      const tab = objectValue(item)
      if (typeof tab?.id === 'string' && typeof tab.title === 'string') titles.set(tab.id, safeTitle(tab.title))
    }
  }
  if (group.first !== undefined) visitTerminalGroups(group.first, titles)
  if (group.second !== undefined) visitTerminalGroups(group.second, titles)
}

function mobileMarkdownTab(tabId: string, worktreeId: string, title: string, dirty: boolean): MobileWorkspaceTab {
  return { tabId, worktreeId, kind: 'markdown', title: safeTitle(title), dirty }
}

function mobileBrowserTab(pane: BrowserPaneState, title = pane.title): MobileWorkspaceTab {
  return {
    tabId: pane.tabId,
    worktreeId: pane.worktreeId,
    kind: 'browser',
    title: safeTitle(title, 'Browser'),
    dirty: false,
    browserMode: pane.mode
  }
}

function paneByTabId(context: PluginContext, panes: BrowserPaneState[], worktreeId: string, tabId: string): BrowserPaneState {
  const pane = panes.find((item) => item.tabId === tabId && item.worktreeId === worktreeId)
  if (!pane) throw context.error('not-found', `Browser tab ${tabId} does not belong to worktree ${worktreeId}.`)
  return pane
}

function mobileDocumentText(context: PluginContext, value: unknown, expectedRevision: number): string {
  const result = objectValue(value)
  if (!result || typeof result.text !== 'string' || typeof result.eof !== 'boolean' ||
    !Number.isSafeInteger(result.contentRevision) || result.contentRevision !== expectedRevision) {
    throw context.error('conflict', 'The editor text changed while the phone was reading it.')
  }
  if (!result.eof || Buffer.byteLength(result.text, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw context.error('invalid-params', `Markdown document exceeds the phone limit of 64 KiB (${MAX_MARKDOWN_BYTES} UTF-8 bytes).`)
  }
  return result.text
}

function connectionId(context: PluginContext, caller: PluginCaller): number {
  if (caller.role === 'plugin') throw context.error('invalid-params', 'Browser Watch requires a connected client caller.')
  const id = caller.connection?.id
  if (!Number.isSafeInteger(id) || typeof id !== 'number' || id < 1) {
    throw context.error('invalid-params', 'Browser Watch requires the live caller connection identity.')
  }
  return id
}

function isBase64(value: string): boolean {
  const length = value.length
  if (length === 0 || length % 4 !== 0) return false
  let dataLength = length
  if (value.charCodeAt(length - 1) === 61) {
    dataLength--
    if (dataLength > 0 && value.charCodeAt(dataLength - 1) === 61) dataLength--
  }
  if (dataLength < length - 2) return false
  for (let index = 0; index < dataLength; index++) {
    const code = value.charCodeAt(index)
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47)) return false
  }
  for (let index = dataLength; index < length; index++) {
    if (value.charCodeAt(index) !== 61) return false
  }
  return true
}

function browserFrameEvent(value: unknown, lease: OwnedBrowserWatch): MobileBrowserFrame | null {
  const frame = objectValue(value)
  if (!frame || frame.pane !== lease.paneId || typeof frame.watchId !== 'string' ||
    !Number.isSafeInteger(frame.sequence) || typeof frame.sequence !== 'number' || frame.sequence < 1 ||
    !Number.isFinite(frame.width) || typeof frame.width !== 'number' || frame.width < 1 || frame.width > 8192 ||
    !Number.isFinite(frame.height) || typeof frame.height !== 'number' || frame.height < 1 || frame.height > 8192 ||
    typeof frame.data !== 'string') return null
  if (lease.watchId !== null && lease.watchId !== frame.watchId) return null
  if (frame.data.length > MAX_FRAME_BASE64_BYTES) {
    lease.frameError = `Browser Watch image exceeds the 512 KiB phone frame limit (${MAX_FRAME_BASE64_BYTES} base64 bytes).`
    return null
  }
  if (!isBase64(frame.data)) {
    lease.frameError = 'Browser returned an invalid Watch image.'
    return null
  }
  return {
    tabId: lease.tabId,
    worktreeId: lease.worktreeId,
    watchId: frame.watchId,
    sequence: frame.sequence,
    width: frame.width,
    height: frame.height,
    mimeType: 'image/jpeg',
    data: frame.data
  }
}

export function registerMobileSessionTabs(context: PluginContext): () => Promise<void> {
  const leasesByConnection = new Map<number, OwnedBrowserWatch>()
  const leasesByPane = new Map<string, OwnedBrowserWatch>()
  const pendingCleanup = new Set<Promise<void>>()
  const cleanupErrors: unknown[] = []
  let disposed = false

  const forgetLease = (lease: OwnedBrowserWatch) => {
    if (leasesByConnection.get(lease.connectionId) === lease) leasesByConnection.delete(lease.connectionId)
    if (lease.paneId && leasesByPane.get(lease.paneId) === lease) leasesByPane.delete(lease.paneId)
    lease.removeConnectionClose?.()
    lease.removeConnectionClose = null
    lease.closed = true
  }

  const browserParams = (lease: OwnedBrowserWatch) => ({ pane: lease.paneId, consumer: String(lease.connectionId) })

  const runLeaseOperation = <T>(lease: OwnedBrowserWatch, operation: () => Promise<T>): Promise<T> => {
    const current = lease.operations.then(operation)
    lease.operations = current.then(() => undefined, () => undefined)
    return current
  }

  const browserProviderActive = async (): Promise<boolean> => {
    let result: unknown
    try {
      result = await context.call('plugin.list', {})
    } catch (error) {
      if (expectedShutdownProviderLoss(error)) return false
      throw error
    }
    if (!Array.isArray(result)) throw context.error('conflict', 'The plugin list returned invalid state during Browser cleanup.')
    const browser = result.map(objectValue).find((plugin) => plugin?.id === 'quirky.browser')
    if (!browser || browser.state === 'inactive' || browser.state === 'disabled' || browser.state === 'invalid') return false
    if (browser.state === 'active') return true
    throw context.error('conflict', `Browser is ${String(browser.state)} while an owned Watch lease is being released.`)
  }

  const stopOwnedLease = async (lease: OwnedBrowserWatch): Promise<void> => {
    if (lease.closed) return
    if (lease.watchId === null || lease.paneId === '') {
      lease.disconnected = true
      return
    }
    if (!await browserProviderActive()) {
      forgetLease(lease)
      return
    }
    let restoreFailure: unknown
    try {
      await context.call('quirky.browser/paneControl', {
        ...browserParams(lease), action: 'viewport', preset: lease.previousViewport
      })
    } catch (error) {
      if (expectedShutdownProviderLoss(error)) {
        forgetLease(lease)
        return
      }
      restoreFailure = error
    }
    try {
      const result = objectValue(await context.call('quirky.browser/paneWatchStop', {
        ...browserParams(lease), watchId: lease.watchId
      })) as BrowserOperationResult | undefined
      if (result?.closed !== true) throw context.error('conflict', 'Browser did not confirm stopping the owned Watch lease.')
    } catch (error) {
      if (expectedShutdownProviderLoss(error) || staleWatchLease(error)) {
        forgetLease(lease)
        if (restoreFailure) throw context.error('conflict', `The Watch lease ended, but its Browser viewport could not be restored: ${messageOf(restoreFailure)}`)
        return
      }
      throw error
    }
    forgetLease(lease)
    if (restoreFailure) throw context.error('conflict', `Browser Watch stopped, but its original viewport could not be restored: ${messageOf(restoreFailure)}`)
  }

  const releaseLease = (lease: OwnedBrowserWatch): Promise<void> => runLeaseOperation(lease, () => stopOwnedLease(lease))

  const trackCleanup = (promise: Promise<void>): void => {
    const tracked = promise.then(() => undefined, (error: unknown) => {
      if (!expectedShutdownProviderLoss(error) && !staleWatchLease(error)) cleanupErrors.push(error)
      context.log(`mobile Browser Watch cleanup failed: ${messageOf(error)}`)
    })
    pendingCleanup.add(tracked)
    void tracked.then(() => pendingCleanup.delete(tracked))
  }

  const attachConnectionClose = (lease: OwnedBrowserWatch, caller: PluginCaller): void => {
    if (caller.role === 'plugin') throw context.error('invalid-params', 'Browser Watch requires a connected client caller.')
    const connection = caller.connection
    if (!connection) throw context.error('invalid-params', 'Browser Watch requires a live caller connection.')
    lease.removeConnectionClose = connection.onClose(() => {
      lease.disconnected = true
      trackCleanup(releaseLease(lease))
    })
  }

  const reserveLease = (caller: PluginCaller, worktreeId: string): OwnedBrowserWatch => {
    const id = connectionId(context, caller)
    if (disposed) throw context.error('conflict', 'Mobile tab services are stopping.')
    if (leasesByConnection.has(id)) throw context.error('conflict', 'This connection already owns a Browser Watch lease.')
    if (leasesByConnection.size >= MAX_WATCH_LEASES) throw context.error('conflict', 'The phone Watch limit has been reached.')
    const lease: OwnedBrowserWatch = {
      connectionId: id,
      worktreeId,
      tabId: '',
      paneId: '',
      pageId: null,
      watchId: null,
      previousViewport: 'default',
      pendingFrame: null,
      frameError: null,
      disconnected: false,
      closed: false,
      removeConnectionClose: null,
      operations: Promise.resolve(),
      startPromise: null
    }
    leasesByConnection.set(id, lease)
    attachConnectionClose(lease, caller)
    return lease
  }

  const setLeasePane = (lease: OwnedBrowserWatch, pane: BrowserPaneState): void => {
    const other = leasesByPane.get(pane.id)
    if (other && other !== lease) throw context.error('conflict', 'Another phone connection already owns this Browser pane.')
    lease.paneId = pane.id
    lease.tabId = pane.tabId
    lease.previousViewport = pane.viewport
    leasesByPane.set(pane.id, lease)
  }

  const currentBrowserPanes = async (worktreeId: string): Promise<BrowserPaneState[]> => {
    const result = await context.call('quirky.browser/paneState', { worktree: `id:${worktreeId}` })
    return browserPaneValue(context, result, worktreeId)
  }

  const browserTabForId = async (worktreeId: string, tabId: string): Promise<MobileWorkspaceTab> => {
    const pane = paneByTabId(context, await currentBrowserPanes(worktreeId), worktreeId, tabId)
    const titles = await terminalTabTitles(context, worktreeId)
    return mobileBrowserTab(pane, titles.get(tabId) ?? pane.title)
  }

  const findOwnedBrowserLease = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ lease: OwnedBrowserWatch; tab: BrowserPaneState }> => {
    const worktreeId = await resolveWorktree(context, requireString(context, params, 'worktree'))
    const tabId = requireString(context, params, 'tabId')
    const watchId = requireString(context, params, 'watchId')
    const id = connectionId(context, caller)
    const lease = leasesByConnection.get(id)
    if (!lease || lease.closed || lease.worktreeId !== worktreeId || lease.tabId !== tabId || lease.watchId !== watchId) {
      throw context.error('conflict', 'This connection does not own the requested Browser Watch lease.')
    }
    const tab = paneByTabId(context, await currentBrowserPanes(worktreeId), worktreeId, tabId)
    if (tab.id !== lease.paneId || tab.mode !== 'watch') throw context.error('conflict', 'The Browser Watch tab changed before the phone action.')
    return { lease, tab }
  }

  const performWatchStart = async (lease: OwnedBrowserWatch): Promise<MobileWatchResult> => {
    if (lease.disconnected) throw context.error('conflict', 'The Browser Watch connection closed during startup.')
    const started = objectValue(await context.call('quirky.browser/paneWatch', {
      pane: lease.paneId, consumer: String(lease.connectionId)
    })) as { watchId?: unknown } | undefined
    if (!started || typeof started.watchId !== 'string' || started.watchId.length === 0) {
      throw context.error('conflict', 'Browser did not return the owned Watch lease ID.')
    }
    lease.watchId = started.watchId
    if (lease.pendingFrame && lease.pendingFrame.watchId !== started.watchId) lease.pendingFrame = null
    if (lease.disconnected) {
      await context.call('quirky.browser/paneWatchStop', {
        pane: lease.paneId, watchId: lease.watchId, consumer: String(lease.connectionId)
      })
      forgetLease(lease)
      throw context.error('conflict', 'The Browser Watch connection closed during startup.')
    }
    await context.call('quirky.browser/paneControl', {
      pane: lease.paneId, consumer: String(lease.connectionId), action: 'viewport', preset: MOBILE_VIEWPORT
    })
    if (lease.disconnected) {
      await stopOwnedLease(lease)
      throw context.error('conflict', 'The Browser Watch connection closed during startup.')
    }
    return { tab: await browserTabForId(lease.worktreeId, lease.tabId), watchId: lease.watchId }
  }

  const startExistingWatch = async (caller: PluginCaller, worktreeId: string, tab: BrowserPaneState): Promise<MobileWatchResult> => {
    if (tab.mode !== 'watch') throw context.error('invalid-params', 'Native Browser tabs cannot stream to the phone; switch the tab to Watch explicitly on desktop.')
    const id = connectionId(context, caller)
    const existing = leasesByConnection.get(id)
    if (existing) {
      if (existing.worktreeId !== worktreeId || existing.tabId !== tab.tabId) {
        throw context.error('conflict', 'This connection already owns a different Browser Watch lease.')
      }
      if (existing.startPromise) return await existing.startPromise
      if (existing.watchId) return { tab: await browserTabForId(worktreeId, tab.tabId), watchId: existing.watchId }
      throw context.error('conflict', 'The Browser Watch lease is stopping.')
    }
    if (leasesByPane.has(tab.id)) throw context.error('conflict', 'Another phone connection already owns this Browser pane.')
    const lease = reserveLease(caller, worktreeId)
    try {
      setLeasePane(lease, tab)
    } catch (error) {
      forgetLease(lease)
      throw error
    }
    const startPromise = runLeaseOperation(lease, () => performWatchStart(lease))
    lease.startPromise = startPromise
    try {
      const result = await startPromise
      lease.startPromise = null
      return result
    } catch (error) {
      lease.startPromise = null
      if (lease.watchId) {
        try {
          await releaseLease(lease)
        } catch (cleanupError) {
          throw context.error('conflict', `Watch startup failed and its owned lease could not be cleaned up: ${messageOf(cleanupError)}`)
        }
      } else {
        forgetLease(lease)
      }
      throw error
    }
  }

  const closeCreatedBrowserPane = async (lease: OwnedBrowserWatch): Promise<void> => {
    if (!lease.paneId) return
    const consumer = String(lease.connectionId)
    let paneCloseFailure: unknown
    try {
      await context.call('quirky.browser/paneClose', { pane: lease.paneId, consumer })
    } catch (error) {
      if (!expectedShutdownProviderLoss(error)) paneCloseFailure = error
    }
    if (lease.pageId) {
      try { await context.call('quirky.browser/tabClose', { page: lease.pageId, yes: true }) } catch (error) {
        if (!expectedShutdownProviderLoss(error)) throw error
      }
    }
    if (paneCloseFailure) throw paneCloseFailure
  }

  const createBrowserWatch = async (params: Record<string, unknown>, caller: PluginCaller): Promise<MobileWatchResult> => {
    const worktreeId = await resolveWorktree(context, requireString(context, params, 'worktree'))
    const url = params.url
    if (url !== undefined && (typeof url !== 'string' || Buffer.byteLength(url, 'utf8') > MAX_NAVIGATION_BYTES)) {
      throw context.error('invalid-params', `url must be at most ${MAX_NAVIGATION_BYTES} UTF-8 bytes.`)
    }
    const lease = reserveLease(caller, worktreeId)
    const startPromise = runLeaseOperation(lease, async () => {
      const opened = objectValue(await context.call('quirky.browser/paneOpen', {
        worktree: `id:${worktreeId}`,
        mode: 'watch',
        consumer: String(lease.connectionId),
        ...(typeof url === 'string' ? { url } : {})
      })) as BrowserOpenResult | undefined
      if (!opened || typeof opened.id !== 'string' || typeof opened.tabId !== 'string' || opened.worktreeId !== worktreeId ||
        opened.mode !== 'watch' || (opened.page !== null && typeof opened.page !== 'string')) {
        throw context.error('conflict', 'Browser did not create a real Watch tab in the requested worktree.')
      }
      lease.paneId = opened.id
      lease.tabId = opened.tabId
      lease.pageId = typeof opened.page === 'string' ? opened.page : null
      lease.previousViewport = (VIEWPORTS as readonly string[]).includes(opened.viewport)
        ? opened.viewport as OwnedBrowserWatch['previousViewport']
        : 'default'
      leasesByPane.set(lease.paneId, lease)
      if (lease.disconnected) {
        await closeCreatedBrowserPane(lease)
        forgetLease(lease)
        throw context.error('conflict', 'The Browser Watch connection closed during creation.')
      }
      paneByTabId(context, await currentBrowserPanes(worktreeId), worktreeId, lease.tabId)
      return await performWatchStart(lease)
    })
    lease.startPromise = startPromise
    try {
      return await startPromise
    } catch (error) {
      lease.startPromise = null
      try {
        await closeCreatedBrowserPane(lease)
      } catch (cleanupError) {
        if (lease.watchId !== null && !lease.closed) {
          try {
            await releaseLease(lease)
          } catch (releaseError) {
            trackCleanup(releaseLease(lease))
            throw context.error(
              'conflict',
              `Browser Watch creation failed; its owned tab and lease could not be cleaned up: ${messageOf(cleanupError)}; ${messageOf(releaseError)}`
            )
          }
        }
        if (!lease.closed) forgetLease(lease)
        throw context.error('conflict', `Browser Watch creation failed; the owned tab could not be closed: ${messageOf(cleanupError)}`)
      }
      forgetLease(lease)
      throw error
    }
  }

  const sessionTabAction = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ tabId: string; closed: boolean }> => {
    const worktreeId = await resolveWorktree(context, requireString(context, params, 'worktree'))
    const tabId = requireString(context, params, 'tabId')
    const action = params.action
    if (action !== 'rename' && action !== 'close' && action !== 'refresh') throw context.error('invalid-params', 'action must be rename, close, or refresh.')
    if (params.discard !== undefined && typeof params.discard !== 'boolean') throw context.error('invalid-params', 'discard must be a boolean.')
    const name = action === 'rename' ? requireString(context, params, 'name').trim() : undefined
    if (name !== undefined && (name === '' || name.length > MAX_NAME_LENGTH)) {
      throw context.error('invalid-params', `name must contain 1–${MAX_NAME_LENGTH} characters.`)
    }

    let editorState: EditorState | null = null
    try {
      editorState = await readEditorState(context, worktreeId)
    } catch (error) {
      if (!unavailableMethod(error, 'quirky.editor', 'state')) throw error
    }
    const editorTab = editorState?.tabs.find((item) => item.tabId === tabId)
    if (editorTab) {
      const buffer = editorState!.buffers.find((item) => item.id === editorTab.bufferId)
      if (!buffer || buffer.worktreeId !== worktreeId || buffer.kind !== 'markdown') {
        throw context.error('not-found', `Markdown tab ${tabId} does not belong to worktree ${worktreeId}.`)
      }
      if (action === 'rename') {
        await context.call('quirky.terminal/renameTab', { tab: tabId, title: name! })
        return { tabId, closed: false }
      }
      if (action === 'refresh') {
        await context.call('quirky.editor/view', { bufferId: buffer.id, action: 'reveal' })
        return { tabId, closed: false }
      }
      const canClose = await context.call('quirky.editor/canClose', { bufferId: buffer.id, tabId })
      if (typeof canClose !== 'boolean') throw context.error('conflict', 'The editor returned an invalid close decision.')
      if (!canClose && params.discard !== true) return { tabId, closed: false }
      const closeParams = { bufferId: buffer.id, tabId, ...(!canClose ? { choice: 'discard' } : {}) }
      const result = objectValue(await context.call('quirky.editor/close', closeParams))
      return { tabId, closed: result?.closed === true }
    }

    const browserTab = paneByTabId(context, await currentBrowserPanes(worktreeId), worktreeId, tabId)
    if (action === 'rename') {
      await context.call('quirky.terminal/renameTab', { tab: tabId, title: name! })
      return { tabId, closed: false }
    }
    if (action === 'refresh') {
      if (browserTab.mode !== 'watch') {
        throw context.error('invalid-params', 'Native Browser tabs cannot refresh on the phone; switch the tab to Watch explicitly on desktop.')
      }
      const id = caller.role === 'plugin' ? undefined : caller.connection?.id
      const lease = typeof id === 'number' ? leasesByConnection.get(id) : undefined
      if (!lease || lease.tabId !== tabId || lease.worktreeId !== worktreeId || !lease.watchId) {
        throw context.error('conflict', 'Start this Browser Watch on the current connection before refreshing it.')
      }
      await runLeaseOperation(lease, async () => {
        await context.call('quirky.browser/paneControl', { ...browserParams(lease), action: 'reload' })
      })
      return { tabId, closed: false }
    }
    const id = caller.role === 'plugin' ? undefined : caller.connection?.id
    const lease = typeof id === 'number' ? leasesByConnection.get(id) : undefined
    if (lease && lease.tabId === tabId && lease.worktreeId === worktreeId) await releaseLease(lease)
    const result = await context.call('quirky.browser/paneClose', {
      pane: browserTab.id,
      ...(typeof id === 'number' ? { consumer: String(id) } : {})
    })
    return { tabId, closed: result === true }
  }

  const subscribeFrames = context.subscribe((event: QuirkyEvent) => {
    if (event.type !== 'quirky.browser/paneFrame' || !('data' in event)) return
    const frame = objectValue(event.data)
    if (!frame || typeof frame.pane !== 'string') return
    const lease = leasesByPane.get(frame.pane)
    if (!lease || lease.closed) return
    const projected = browserFrameEvent(frame, lease)
    if (!projected) {
      if (lease.frameError) trackCleanup(releaseLease(lease))
      return
    }
    lease.pendingFrame = projected
  })

  const browserWatchFrame = async (params: Record<string, unknown>, caller: PluginCaller): Promise<MobileBrowserFrame | null> => {
    const { lease } = await findOwnedBrowserLease(params, caller)
    if (lease.frameError) {
      const message = lease.frameError
      trackCleanup(releaseLease(lease))
      throw context.error('conflict', message)
    }
    return lease.pendingFrame
  }

  const browserWatchFrameAck = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ acknowledged: boolean }> => {
    const { lease } = await findOwnedBrowserLease(params, caller)
    const sequence = params.sequence
    if (!Number.isSafeInteger(sequence) || typeof sequence !== 'number' || sequence < 1 || lease.pendingFrame?.sequence !== sequence) {
      throw context.error('conflict', 'The phone can acknowledge only its exact loaded Watch frame.')
    }
    return await runLeaseOperation(lease, async () => {
      const result = objectValue(await context.call('quirky.browser/paneFrameAck', {
        ...browserParams(lease), watchId: lease.watchId!, sequence
      })) as BrowserOperationResult | undefined
      if (result?.acknowledged !== true) throw context.error('conflict', 'Browser did not confirm the Watch frame acknowledgement.')
      if (lease.pendingFrame?.sequence === sequence) lease.pendingFrame = null
      return { acknowledged: true }
    })
  }

  const browserWatchStop = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ closed: boolean }> => {
    const { lease } = await findOwnedBrowserLease(params, caller)
    await releaseLease(lease)
    return { closed: true }
  }

  const browserWatchNavigate = async (params: Record<string, unknown>, caller: PluginCaller): Promise<MobileWorkspaceTab> => {
    const input = requireString(context, params, 'input')
    if (Buffer.byteLength(input, 'utf8') > MAX_NAVIGATION_BYTES) throw context.error('invalid-params', `input exceeds ${MAX_NAVIGATION_BYTES} UTF-8 bytes.`)
    const { lease } = await findOwnedBrowserLease(params, caller)
    await runLeaseOperation(lease, async () => {
      await context.call('quirky.browser/paneNavigate', { ...browserParams(lease), input })
    })
    return await browserTabForId(lease.worktreeId, lease.tabId)
  }

  const browserWatchControl = async (params: Record<string, unknown>, caller: PluginCaller): Promise<MobileWorkspaceTab> => {
    const action = params.action
    if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop' && action !== 'find' && action !== 'zoom' && action !== 'viewport') {
      throw context.error('invalid-params', 'action must be back, forward, reload, stop, find, zoom, or viewport.')
    }
    const { lease } = await findOwnedBrowserLease(params, caller)
    if (action === 'find' && typeof params.text === 'string' && Buffer.byteLength(params.text, 'utf8') > MAX_NAVIGATION_BYTES) {
      throw context.error('invalid-params', `text exceeds ${MAX_NAVIGATION_BYTES} UTF-8 bytes.`)
    }
    if (action === 'viewport') {
      if (typeof params.preset !== 'string' || !(VIEWPORTS as readonly string[]).includes(params.preset)) {
        throw context.error('invalid-params', 'preset must be a supported Browser viewport.')
      }
    }
    await runLeaseOperation(lease, async () => {
      await context.call('quirky.browser/paneControl', {
        ...browserParams(lease), action,
        ...(typeof params.text === 'string' ? { text: params.text } : {}),
        ...(typeof params.forward === 'boolean' ? { forward: params.forward } : {}),
        ...(typeof params.level === 'number' ? { level: params.level } : {}),
        ...(typeof params.preset === 'string' ? { preset: params.preset } : {})
      })
    })
    return await browserTabForId(lease.worktreeId, lease.tabId)
  }

  const browserWatchInput = async (params: Record<string, unknown>, caller: PluginCaller): Promise<{ sent: boolean }> => {
    const kind = params.kind
    if (kind !== 'mouse' && kind !== 'key' && kind !== 'text' && kind !== 'wheel') throw context.error('invalid-params', 'kind must be mouse, key, text, or wheel.')
    if (kind === 'text' && (typeof params.text !== 'string' || Buffer.byteLength(params.text, 'utf8') > 4096)) {
      throw context.error('invalid-params', 'text input must be at most 4 KiB of UTF-8.')
    }
    if (kind === 'mouse' && (typeof params.x !== 'number' || !Number.isFinite(params.x) || params.x < 0 ||
      typeof params.y !== 'number' || !Number.isFinite(params.y) || params.y < 0 ||
      (params.type !== 'mousePressed' && params.type !== 'mouseReleased' && params.type !== 'mouseMoved'))) {
      throw context.error('invalid-params', 'mouse input requires a typed event and finite non-negative coordinates.')
    }
    if (kind === 'key' && (params.type !== 'keyDown' && params.type !== 'keyUp' ||
      typeof params.key !== 'string' || params.key.length > 64 || typeof params.code !== 'string' || params.code.length > 64)) {
      throw context.error('invalid-params', 'key input requires a typed keyDown/keyUp event and bounded key/code values.')
    }
    if (kind === 'wheel' && (typeof params.deltaX !== 'number' || !Number.isFinite(params.deltaX) || Math.abs(params.deltaX) > 5000 ||
      typeof params.deltaY !== 'number' || !Number.isFinite(params.deltaY) || Math.abs(params.deltaY) > 5000)) {
      throw context.error('invalid-params', 'wheel input requires finite deltas within 5,000 CSS pixels.')
    }
    const { lease } = await findOwnedBrowserLease(params, caller)
    await runLeaseOperation(lease, async () => {
      await context.call('quirky.browser/paneInput', {
        ...browserParams(lease), kind,
        ...(typeof params.type === 'string' ? { type: params.type } : {}),
        ...(typeof params.x === 'number' ? { x: params.x } : {}),
        ...(typeof params.y === 'number' ? { y: params.y } : {}),
        ...(typeof params.button === 'string' ? { button: params.button } : {}),
        ...(typeof params.key === 'string' ? { key: params.key } : {}),
        ...(typeof params.code === 'string' ? { code: params.code } : {}),
        ...(typeof params.text === 'string' ? { text: params.text } : {}),
        ...(typeof params.deltaX === 'number' ? { deltaX: params.deltaX } : {}),
        ...(typeof params.deltaY === 'number' ? { deltaY: params.deltaY } : {}),
        ...(Number.isSafeInteger(params.modifiers) ? { modifiers: params.modifiers as number } : {})
      })
    })
    return { sent: true }
  }

  const sessionTabs = async (params: Record<string, unknown>): Promise<MobileWorkspaceTab[]> => {
    const worktreeId = await resolveWorktree(context, requireString(context, params, 'worktree'))
    const titles = await terminalTabTitles(context, worktreeId)
    let markdown: MobileWorkspaceTab[] = []
    try {
      const state = await readEditorState(context, worktreeId)
      const bufferById = new Map(state.buffers.map((buffer) => [buffer.id, buffer]))
      markdown = state.tabs.flatMap((tab) => {
        const buffer = bufferById.get(tab.bufferId)
        return buffer?.kind === 'markdown' && buffer.worktreeId === worktreeId
          ? [mobileMarkdownTab(tab.tabId, worktreeId, titles.get(tab.tabId) ?? buffer.name, buffer.dirty)]
          : []
      })
    } catch (error) {
      if (!unavailableMethod(error, 'quirky.editor', 'state')) throw error
    }
    let browser: MobileWorkspaceTab[] = []
    try {
      browser = (await currentBrowserPanes(worktreeId)).map((pane) => mobileBrowserTab(pane, titles.get(pane.tabId) ?? pane.title))
    } catch (error) {
      if (!unavailableMethod(error, 'quirky.browser', 'paneState')) throw error
    }
    return [...markdown, ...browser]
  }

  const markdownCreate = async (params: Record<string, unknown>): Promise<MobileMarkdownDocument> => {
    const worktreeId = await resolveWorktree(context, requireString(context, params, 'worktree'))
    await readEditorState(context, worktreeId)
    const path = `${MARKDOWN_NOTE_PREFIX}${randomUUID()}.md`
    const created = objectValue(await context.call('quirky.editor/mutate', {
      worktree: `id:${worktreeId}`, action: 'createFile', path, content: ''
    })) as EditorMutation | undefined
    if (created?.path !== path) throw context.error('conflict', 'The editor did not create the requested Markdown note.')
    const opened = objectValue(await context.call('quirky.editor/open', {
      worktree: `id:${worktreeId}`, path, mode: 'source', focus: false
    }))
    if (typeof opened?.openedTabId !== 'string') throw context.error('conflict', 'The editor did not return the actual Markdown tab ID.')
    return await markdownDocument(context, worktreeId, opened.openedTabId)
  }

  const markdownRead = async (params: Record<string, unknown>): Promise<MobileMarkdownDocument> => {
    const worktreeId = await resolveWorktree(context, requireString(context, params, 'worktree'))
    return await markdownDocument(context, worktreeId, requireString(context, params, 'tabId'))
  }

  const markdownWrite = async (params: Record<string, unknown>): Promise<MobileMarkdownDocument> => {
    const worktreeId = await resolveWorktree(context, requireString(context, params, 'worktree'))
    const tabId = requireString(context, params, 'tabId')
    const text = params.text
    if (typeof text !== 'string') throw context.error('invalid-params', 'text must be a string.')
    if (Buffer.byteLength(text, 'utf8') > MAX_MARKDOWN_BYTES) {
      throw context.error('invalid-params', `Markdown text exceeds the phone limit of 64 KiB (${MAX_MARKDOWN_BYTES} UTF-8 bytes).`)
    }
    const expectedRevision = requireRevision(context, params)
    const { buffer } = findMarkdownTab(context, await readEditorState(context, worktreeId), worktreeId, tabId)
    if (buffer.readOnly) throw context.error('invalid-params', 'This Markdown tab is read-only.')
    await context.call('quirky.editor/draft', { bufferId: buffer.id, content: text, expectedRevision })
    return await markdownDocument(context, worktreeId, tabId)
  }

  const markdownSave = async (params: Record<string, unknown>): Promise<MobileMarkdownDocument> => {
    const worktreeId = await resolveWorktree(context, requireString(context, params, 'worktree'))
    const tabId = requireString(context, params, 'tabId')
    const expectedRevision = requireRevision(context, params)
    const { buffer } = findMarkdownTab(context, await readEditorState(context, worktreeId), worktreeId, tabId)
    if (buffer.readOnly) throw context.error('invalid-params', 'This Markdown tab is read-only.')
    await context.call('quirky.editor/save', { bufferId: buffer.id, trigger: 'user', expectedRevision })
    return await markdownDocument(context, worktreeId, tabId)
  }

  context.provide('method:quirky.mobile/sessionTabs', sessionTabs)
  context.provide('method:quirky.mobile/markdownCreate', markdownCreate)
  context.provide('method:quirky.mobile/markdownRead', markdownRead)
  context.provide('method:quirky.mobile/markdownWrite', markdownWrite)
  context.provide('method:quirky.mobile/markdownSave', markdownSave)
  context.provide('method:quirky.mobile/sessionTabAction', sessionTabAction)
  context.provide('method:quirky.mobile/browserWatchCreate', createBrowserWatch)
  context.provide('method:quirky.mobile/browserWatchStart', async (params: Record<string, unknown>, caller: PluginCaller) => {
    const worktreeId = await resolveWorktree(context, requireString(context, params, 'worktree'))
    const tabId = requireString(context, params, 'tabId')
    const pane = paneByTabId(context, await currentBrowserPanes(worktreeId), worktreeId, tabId)
    return await startExistingWatch(caller, worktreeId, pane)
  })
  context.provide('method:quirky.mobile/browserWatchFrame', browserWatchFrame)
  context.provide('method:quirky.mobile/browserWatchFrameAck', browserWatchFrameAck)
  context.provide('method:quirky.mobile/browserWatchStop', browserWatchStop)
  context.provide('method:quirky.mobile/browserWatchNavigate', browserWatchNavigate)
  context.provide('method:quirky.mobile/browserWatchControl', browserWatchControl)
  context.provide('method:quirky.mobile/browserWatchInput', browserWatchInput)

  return async () => {
    if (disposed) return
    disposed = true
    subscribeFrames()
    const failures: unknown[] = []
    for (const lease of [...leasesByConnection.values()]) {
      try {
        await lease.startPromise?.catch(() => undefined)
        await releaseLease(lease)
      } catch (error) {
        if (!expectedShutdownProviderLoss(error) && !staleWatchLease(error)) failures.push(error)
      }
    }
    await Promise.all([...pendingCleanup])
    if (failures.length > 0 || cleanupErrors.length > 0) {
      const messages = [...failures, ...cleanupErrors].map(messageOf).join('; ')
      throw context.error('conflict', `Mobile Browser Watch cleanup did not complete: ${messages}`)
    }
  }
}

async function resolveWorktree(context: PluginContext, value: string): Promise<string> {
  const result = objectValue(await context.call('quirky.worktree/show', { worktree: `id:${value}` })) as WorkspaceReply | undefined
  if (!result || result.id !== value) throw context.error('not-found', `Worktree ${value} could not be resolved.`)
  return value
}

async function readEditorState(context: PluginContext, worktreeId: string): Promise<EditorState> {
  const raw = await context.call('quirky.editor/state', { worktree: `id:${worktreeId}` })
  return editorStateValue(context, raw, worktreeId)
}

function findMarkdownTab(context: PluginContext, state: EditorState, worktreeId: string, tabId: string): { tab: EditorTabState; buffer: EditorBufferState } {
  const tab = state.tabs.find((item) => item.tabId === tabId)
  if (!tab) throw context.error('not-found', `Markdown tab ${tabId} does not belong to worktree ${worktreeId}.`)
  const buffer = state.buffers.find((item) => item.id === tab.bufferId)
  if (!buffer || buffer.worktreeId !== worktreeId || buffer.kind !== 'markdown') {
    throw context.error('not-found', `Markdown tab ${tabId} does not belong to worktree ${worktreeId}.`)
  }
  return { tab, buffer }
}

async function terminalTabTitles(context: PluginContext, worktreeId: string): Promise<Map<string, string>> {
  const result = objectValue(await context.call('quirky.terminal/workspace', { workspace: `id:${worktreeId}` }))
  const workspace = objectValue(result?.workspace)
  const titles = new Map<string, string>()
  if (workspace) visitTerminalGroups(workspace.root, titles)
  return titles
}

async function markdownDocument(context: PluginContext, worktreeId: string, tabId: string): Promise<MobileMarkdownDocument> {
  const { buffer } = findMarkdownTab(context, await readEditorState(context, worktreeId), worktreeId, tabId)
  const draftBytes = buffer.draftBytes
  const textBytes = draftBytes === null ? buffer.contentBytes : draftBytes
  if (textBytes > MAX_MARKDOWN_BYTES) {
    throw context.error('invalid-params', `Markdown document exceeds the phone limit of 64 KiB (${MAX_MARKDOWN_BYTES} UTF-8 bytes).`)
  }
  const kind = draftBytes === null ? 'content' : 'draft'
  const rawText = await context.call('quirky.editor/read', {
    bufferId: buffer.id,
    action: 'text',
    kind,
    offset: 0,
    length: MAX_MARKDOWN_BYTES,
    contentRevision: buffer.contentRevision
  })
  const text = mobileDocumentText(context, rawText, buffer.contentRevision)
  const titles = await terminalTabTitles(context, worktreeId)
  return {
    tabId,
    worktreeId,
    title: titles.get(tabId) ?? safeTitle(buffer.name),
    relativePath: buffer.relativePath,
    text,
    revision: buffer.contentRevision,
    dirty: buffer.dirty,
    readOnly: buffer.readOnly
  }
}
