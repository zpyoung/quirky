import type {
  BrowserHostPrompt,
  DesktopWindowOwner,
  DesktopWindowRequest,
  FolderListing,
  FolderPickerRequest,
  FolderPickerResult,
  Methods,
  NativeDesktopCapabilities,
  QuirkyEvent
} from '@quirky/protocol'
import type { DesktopWindowRoute } from './desktop-bridge'

export const BROWSER_HOST_LEASE_MS = 25_000
export const BROWSER_FOLDER_PAGE_SIZE = 100

export const BROWSER_HOST_CAPABILITIES: NativeDesktopCapabilities = {
  directoryPicker: true,
  auxiliaryWindows: true,
  revealItem: false,
  notifications: { permission: false, click: false, dismiss: false }
}

export type BrowserHostCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

type BrowserPopup = Pick<Window, 'closed' | 'close' | 'focus'> & {
  location: Pick<Location, 'href' | 'replace'>
}

type Timer = ReturnType<typeof setTimeout>

export type BrowserHostOptions = {
  /** The first blank tab must be requested here, synchronously from the opening attempt. */
  openWindow(url: string, target: string): BrowserPopup | null
  /** The current shell URL, including its bearer fragment and any stale auxiliary route. */
  currentUrl(): string
  randomUUID?: () => string
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => unknown
  clearTimer?: (timer: unknown) => void
  windowRoute?: DesktopWindowRoute | null
  /** Focuses the exact owner tab and observes the browser's resulting focus state. */
  focusOwner?: () => Promise<boolean> | boolean
}

type ShellRequestEvent = Extract<QuirkyEvent, { type: 'desktop.shell.request' }>
export type BrowserHostControlParams = Methods['ui.browserHost.control']['params']
type ControlParams = BrowserHostControlParams
type ControlAction = ControlParams['action']
type FolderRequest = {
  kind: 'folder-picker'
  generation: number
  requestId: string
  title: string
  ownerShell: DesktopWindowOwner
  expiresAt: number
  timer?: unknown
  call: BrowserHostCall
  busy: boolean
  confirming: boolean
  error: string | null
  draftPath: string
  hasPathDraft: boolean
  directory?: FolderListing
  selectedPaths: string[]
  multiple: boolean
  readGeneration: number
  settled: boolean
  resolve: (result: FolderPickerResult) => void
  reject: (error: Error) => void
}
type WindowRequest = {
  kind: 'window-open'
  generation: number
  requestId: string
  title: 'Open tab'
  ownerShell: DesktopWindowOwner
  expiresAt: number
  timer?: unknown
  call: BrowserHostCall
  busy: boolean
  error: string | null
  request: DesktopWindowRequest
  windowId?: string
  child?: BrowserPopup
  settled: boolean
  resolve: (result: { windowId: string }) => void
  reject: (error: Error) => void
}
type ActiveRequest = FolderRequest | WindowRequest

type OwnedChild = {
  child: BrowserPopup
  ownerShell: DesktopWindowOwner
  request: DesktopWindowRequest
  requestId: string
  generation: number
  committed: boolean
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function conflict(message: string): Error {
  return new Error(message)
}

function invalidParams(message: string): Error {
  return new Error(`InvalidParams: ${message}`)
}

function folderListing(value: unknown): FolderListing {
  if (!isRecord(value) || typeof value.path !== 'string' ||
    !(typeof value.parent === 'string' || value.parent === null) ||
    !Array.isArray(value.entries) || !Number.isSafeInteger(value.offset) ||
    !Number.isSafeInteger(value.limit) || typeof value.hasMore !== 'boolean' ||
    value.entries.some((entry) => !isRecord(entry) || typeof entry.name !== 'string' || typeof entry.path !== 'string')) {
    throw new Error('the daemon returned an invalid folder listing')
  }
  return value as unknown as FolderListing
}


function replaceRouteFields(url: URL, request: DesktopWindowRequest, windowId: string, owner: DesktopWindowOwner): string {
  for (const key of [
    'quirkyWindowId',
    'quirkyOwnerShellConnId',
    'quirkyOwnerShellName',
    'quirkyView',
    'quirkyInput',
    'quirkyTitle'
  ]) url.searchParams.delete(key)
  url.searchParams.set('quirkyWindowId', windowId)
  url.searchParams.set('quirkyOwnerShellConnId', String(owner.connId))
  if (owner.name !== undefined) url.searchParams.set('quirkyOwnerShellName', owner.name)
  url.searchParams.set('quirkyView', request.view)
  if (request.input !== undefined) url.searchParams.set('quirkyInput', JSON.stringify(request.input))
  if (request.title !== undefined) url.searchParams.set('quirkyTitle', request.title)
  return url.toString()
}

/** Builds the same-origin auxiliary route without carrying stale owner/window fields forward. */
export function browserWindowRouteUrl(baseUrl: string, request: DesktopWindowRequest, windowId: string, owner: DesktopWindowOwner): string {
  if (!windowId || !request.view || !Number.isSafeInteger(owner.connId) || owner.connId < 1) {
    throw new Error('browser window route identity is incomplete')
  }
  return replaceRouteFields(new URL(baseUrl), request, windowId, owner)
}

/** Owns the browser-only subset of desktop shell operations and its one transient prompt. */
export class BrowserHostController {
  readonly capabilities: NativeDesktopCapabilities = {
    ...BROWSER_HOST_CAPABILITIES,
    notifications: { ...BROWSER_HOST_CAPABILITIES.notifications }
  }
  private readonly listeners = new Set<() => void>()
  private readonly children = new Map<string, OwnedChild>()
  private active: ActiveRequest | null = null
  private snapshot: BrowserHostPrompt | null = null
  private nextGeneration = 0
  private lastCall: BrowserHostCall | null = null
  private disposed = false

  constructor(private readonly options: BrowserHostOptions) {}

  getSnapshot = (): BrowserHostPrompt | null => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Starts a host request using the daemon's original identity and transport. */
  async handleShellRequest(event: ShellRequestEvent, call: BrowserHostCall): Promise<unknown> {
    if (this.disposed) {
      if (event.action.kind === 'window-close') {
        return this.closeAuxiliaryWindow(event.action.request.windowId, event.ownerShell)
      }
      throw conflict('browser host is unavailable')
    }
    this.lastCall = call
    const action = event.action
    switch (action.kind) {
      case 'folder-picker':
        return this.openFolderPicker(event.requestId, action.request, event.ownerShell, call)
      case 'file-picker':
        throw conflict('native file selection is unavailable in a browser tab')
      case 'window-open':
        return this.openAuxiliaryWindow(event.requestId, action.request, event.ownerShell, call)
      case 'window-close':
        return this.closeAuxiliaryWindow(action.request.windowId, event.ownerShell)
      case 'window-activate-owner':
        return this.activateOwner(action.request.windowId)
      case 'reveal-item':
        throw conflict('native item reveal is unavailable in a browser tab')
    }
  }

  /** Implements the reserved exact-window `ui.browserHost.control` command. */
  async control(params: ControlParams, call?: BrowserHostCall): Promise<{ active: BrowserHostPrompt | null }> {
    if (this.disposed) throw conflict('browser host is unavailable')
    const { action, connId } = this.validateControl(params)
    if (action === 'state') {
      const current = this.active
      if (current) {
        if (current.ownerShell.connId !== connId) throw conflict('browser host request belongs to a different UI connection')
        return { active: this.snapshot }
      }
      const rpc = call ?? this.lastCall
      if (!rpc) throw conflict('the target UI connection is not connected')
      const route = await rpc('ui.window.self', {})
      if (!isRecord(route) || route.connId !== connId) throw conflict('the target UI connection is not connected')
      return { active: null }
    }

    const current = this.active
    if (!current || params.requestId !== current.requestId) throw conflict('browser host request is no longer active')
    if (connId !== current.ownerShell.connId) throw conflict('browser host request belongs to a different UI connection')
    if (!this.actionMatchesRequest(current, action)) throw conflict('action is not valid for this browser host request')

    if (action === 'cancel') {
      this.cancel(current, 'browser tab opening cancelled')
      return { active: null }
    }
    if (action === 'open-popup') {
      const request = current as WindowRequest
      if (!request.windowId) this.tryOpenPopup(request)
      return { active: this.snapshot }
    }

    const folder = current as FolderRequest
    switch (action) {
      case 'set-path': {
        const path = params.path as string
        if (folder.confirming) throw conflict('folder confirmation is in progress')
        if (path !== folder.draftPath) {
          if (!folder.multiple) folder.selectedPaths = []
          folder.readGeneration += 1
          folder.busy = false
        }
        folder.draftPath = path
        folder.hasPathDraft = true
        folder.error = null
        this.publish(folder)
        return { active: this.snapshot }
      }
      case 'navigate': {
        if (folder.confirming) throw conflict('folder confirmation is in progress')
        const path = params.path as string
        const offset = params.offset ?? 0
        const samePath = path === folder.draftPath && folder.directory?.path === path
        if (!folder.multiple && !samePath) folder.selectedPaths = []
        folder.hasPathDraft = true
        folder.draftPath = path
        await this.readDirectory(folder, path, offset)
        if (!this.isCurrent(folder)) throw conflict('browser host request is no longer active')
        return { active: this.snapshot }
      }
      case 'select': {
        const path = params.path as string
        const selected = params.selected as boolean
        if (folder.busy) throw conflict('the folder request is still working')
        if (!selected) {
          if (folder.selectedPaths.includes(path)) {
            folder.selectedPaths = folder.selectedPaths.filter((selectedPath) => selectedPath !== path)
            if (folder.directory?.path === folder.draftPath) folder.error = null
            this.publish(folder)
          }
          return { active: this.snapshot }
        }
        if (folder.error || folder.directory?.path !== folder.draftPath) {
          throw conflict('the displayed directory is not ready for selection')
        }
        if (folder.multiple && folder.selectedPaths.includes(path)) return { active: this.snapshot }
        const isCurrentFolder = path === folder.directory.path
        const isListedFolder = folder.directory.entries.some((entry) => entry.path === path)
        if (!isCurrentFolder && !isListedFolder) throw conflict('the folder is not on the current directory page')
        folder.selectedPaths = folder.multiple ? [...folder.selectedPaths, path] : [path]
        folder.error = null
        this.publish(folder)
        return { active: this.snapshot }
      }
      case 'confirm':
        return this.confirmFolder(folder)
      default:
        throw invalidParams(`unsupported browser host action ${action}`)
    }
  }

  /** UI controls carry the rendered request identity through the same validated action path. */
  controlCurrent(
    requestId: string,
    action: Exclude<ControlAction, 'state'>,
    fields: Partial<Pick<ControlParams, 'path' | 'selected' | 'offset'>> = {}
  ): Promise<{ active: BrowserHostPrompt | null }> {
    const current = this.active
    if (!current || current.requestId !== requestId) return Promise.reject(conflict('browser host request is no longer active'))
    return this.control({ connId: current.ownerShell.connId, action, requestId, ...fields }, current.call)
  }
  /** Adds the routed window's local identity after checking the request before and after the lookup. */
  async controlRouted(
    params: Omit<ControlParams, 'connId'>,
    call: BrowserHostCall
  ): Promise<{ active: BrowserHostPrompt | null }> {
    const candidate = { ...params, connId: 1 } as ControlParams
    const { action } = this.validateControl(candidate)
    const current = this.active
    if (action !== 'state') {
      if (!current || params.requestId !== current.requestId) throw conflict('browser host request is no longer active')
      if (!this.actionMatchesRequest(current, action)) throw conflict('action is not valid for this browser host request')
    }
    const route = await call('ui.window.self', {})
    if (!isRecord(route) || !Number.isSafeInteger(route.connId) || Number(route.connId) < 1) {
      throw conflict('the target UI connection is not connected')
    }
    if (action !== 'state' && this.active !== current) throw conflict('browser host request is no longer active')
    return this.control({ ...params, connId: Number(route.connId) } as ControlParams, call)
  }

  /** Retries the current path, or the daemon's default home when its initial read had no path. */
  retryDirectory(requestId: string): Promise<void> {
    const current = this.active
    if (!current || current.kind !== 'folder-picker' || current.requestId !== requestId) {
      return Promise.reject(conflict('browser host request is no longer active'))
    }
    if (current.busy) return Promise.resolve()
    return this.readDirectory(current, current.hasPathDraft ? current.draftPath : undefined, 0)
  }


  /** Navigates a verified blank child only after the shell has acknowledged and checked its route. */
  commitWindowOpen(windowId: string): void {
    const current = this.active
    const child = this.children.get(windowId)
    if (!current || current.kind !== 'window-open' || current.windowId !== windowId || !child || child.generation !== current.generation) {
      throw conflict('browser tab opening is no longer active')
    }
    if (child.child.closed) throw conflict('the browser tab closed before it could be registered')
    child.child.location.replace(browserWindowRouteUrl(this.options.currentUrl(), child.request, windowId, child.ownerShell))
    child.committed = true
    this.finishActive(current)
  }

  /** Closes an uncommitted child and removes a route only through the owner's existing close RPC. */
  async discardWindowOpen(windowId: string, call: BrowserHostCall, registered?: boolean): Promise<void> {
    const owned = this.children.get(windowId)
    if (!owned) return
    let routeRemoved = registered === false
    if (registered !== false) {
      try {
        const result = await call('desktop.window.close', { windowId })
        if (!isRecord(result) || result.closed !== true) throw conflict('the registered browser tab route could not be removed')
        routeRemoved = true
      } catch (error) {
        if (!this.children.has(windowId)) return
        if (registered === true || registered === undefined) {
          try {
            const routes = await call('desktop.window.list', {})
            if (!Array.isArray(routes) || routes.some((route) => isRecord(route) && route.windowId === windowId)) throw error
            routeRemoved = true
          } catch {
            if (!this.children.has(windowId)) return
            throw error
          }
        } else {
          throw error
        }
      }
    }
    this.closeChild(owned.child)
    if (!owned.child.closed) throw conflict('the browser tab could not be closed')
    this.children.delete(windowId)
    const current = this.active
    if (current?.kind === 'window-open' && current.windowId === windowId) this.finishActive(current)
  }

  /** A lost owner connection invalidates all pending work; the daemon prunes its routes. */
  disconnect(): void {
    const current = this.active
    if (current) {
      if (current.kind === 'folder-picker') current.readGeneration += 1
      if (!current.settled) {
        current.settled = true
        if (current.kind === 'folder-picker') current.resolve({ cancelled: true, paths: [] })
        else current.reject(conflict('browser tab opening cancelled'))
      }
      this.clearActive(current)
    }
    for (const [windowId, owned] of [...this.children]) {
      this.closeChild(owned.child)
      if (owned.committed) this.children.delete(windowId)
    }
  }

  /** App teardown closes browser-owned tabs and requests owner-targeted route cleanup when possible. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.active) this.cancel(this.active, 'browser tab opening cancelled')
    const call = this.lastCall
    for (const [windowId, owned] of [...this.children]) {
      this.closeChild(owned.child)
      if (owned.committed && call) {
        void this.discardWindowOpen(windowId, call, true).catch(() => undefined)
      }
    }
    this.listeners.clear()
  }

  private openFolderPicker(
    requestId: string,
    request: FolderPickerRequest,
    ownerShell: DesktopWindowOwner,
    call: BrowserHostCall
  ): Promise<FolderPickerResult> {
    this.requireIdle()
    const deferred = Promise.withResolvers<FolderPickerResult>()
    const active: FolderRequest = {
      kind: 'folder-picker',
      generation: ++this.nextGeneration,
      requestId,
      title: request.title ?? 'Choose folder',
      ownerShell,
      expiresAt: this.now() + BROWSER_HOST_LEASE_MS,
      call,
      busy: true,
      confirming: false,
      error: null,
      draftPath: request.startingFolder ?? '',
      hasPathDraft: request.startingFolder !== undefined,
      selectedPaths: [],
      multiple: request.multiple === true,
      readGeneration: 0,
      settled: false,
      resolve: deferred.resolve,
      reject: deferred.reject
    }
    this.active = active
    this.arm(active)
    this.publish(active)
    void this.readDirectory(active, request.startingFolder, 0)
    return deferred.promise
  }

  private openAuxiliaryWindow(
    requestId: string,
    request: DesktopWindowRequest,
    ownerShell: DesktopWindowOwner,
    call: BrowserHostCall
  ): Promise<{ windowId: string }> {
    this.requireIdle()
    const deferred = Promise.withResolvers<{ windowId: string }>()
    const active: WindowRequest = {
      kind: 'window-open',
      generation: ++this.nextGeneration,
      requestId,
      title: 'Open tab',
      ownerShell,
      expiresAt: this.now() + BROWSER_HOST_LEASE_MS,
      call,
      busy: false,
      error: null,
      request,
      settled: false,
      resolve: deferred.resolve,
      reject: deferred.reject
    }
    this.active = active
    this.arm(active)
    this.publish(active)
    this.tryOpenPopup(active)
    return deferred.promise
  }

  private tryOpenPopup(active: WindowRequest): void {
    if (!this.isCurrent(active) || active.windowId) return
    let windowId: string
    try {
      windowId = this.options.randomUUID ? this.options.randomUUID() : crypto.randomUUID()
      if (!windowId || this.children.has(windowId)) throw new Error('the browser tab ID was not unique')
    } catch (error) {
      active.busy = false
      active.error = `The browser could not prepare this tab: ${errorMessage(error)}`
      this.publish(active)
      return
    }
    active.busy = true
    active.error = null
    this.publish(active)
    let child: BrowserPopup | null
    try {
      child = this.options.openWindow('', '_blank')
    } catch (error) {
      child = null
      active.error = `The browser blocked this popup: ${errorMessage(error)}`
    }
    if (!child) {
      active.busy = false
      active.error ??= 'The browser blocked this popup. Choose Open tab to retry.'
      this.publish(active)
      return
    }
    active.child = child
    active.windowId = windowId
    active.error = null
    active.busy = false
    this.children.set(windowId, {
      child,
      ownerShell: active.ownerShell,
      request: active.request,
      requestId: active.requestId,
      generation: active.generation,
      committed: false
    })
    if (!active.settled) {
      active.settled = true
      active.resolve({ windowId })
    }
    this.publish(active)
  }

  private async readDirectory(active: FolderRequest, path: string | undefined, offset: number): Promise<void> {
    const readGeneration = ++active.readGeneration
    active.busy = true
    active.error = null
    if (path !== undefined) {
      active.hasPathDraft = true
      if (path !== active.draftPath && !active.multiple) active.selectedPaths = []
      active.draftPath = path
    }
    this.publish(active)
    try {
      const result = await active.call('ui.folder.list', {
        ...(path === undefined ? {} : { path }),
        offset,
        limit: BROWSER_FOLDER_PAGE_SIZE
      })
      if (!this.isCurrent(active) || active.readGeneration !== readGeneration) return
      active.directory = folderListing(result)
      active.hasPathDraft = true
      active.draftPath = active.directory.path
      active.busy = false
      active.error = null
      this.publish(active)
    } catch (error) {
      if (!this.isCurrent(active) || active.readGeneration !== readGeneration) return
      active.busy = false
      active.error = errorMessage(error)
      if (!active.multiple) active.selectedPaths = []
      this.publish(active)
    }
  }

  private async confirmFolder(active: FolderRequest): Promise<{ active: BrowserHostPrompt | null }> {
    if (active.busy) throw conflict('the folder request is still working')
    if (active.error || active.directory?.path !== active.draftPath) {
      throw conflict('navigate to a readable folder before confirming')
    }
    if (active.selectedPaths.length === 0) throw conflict('select a folder before confirming')
    if (!active.multiple && active.selectedPaths.length !== 1) throw conflict('choose exactly one folder')
    active.busy = true
    active.confirming = true
    active.error = null
    this.publish(active)
    const paths: string[] = []
    const seen = new Set<string>()
    for (const selectedPath of active.selectedPaths) {
      try {
        const value = await active.call('ui.folder.list', {
          path: selectedPath,
          offset: 0,
          limit: BROWSER_FOLDER_PAGE_SIZE
        })
        if (!this.isCurrent(active)) throw conflict('browser host request is no longer active')
        const canonicalPath = folderListing(value).path
        if (!seen.has(canonicalPath)) {
          seen.add(canonicalPath)
          paths.push(canonicalPath)
        }
      } catch (error) {
        if (!this.isCurrent(active)) throw conflict('browser host request is no longer active')
        active.busy = false
        active.confirming = false
        active.error = errorMessage(error)
        this.publish(active)
        return { active: this.snapshot }
      }
    }
    if (!this.isCurrent(active)) throw conflict('browser host request is no longer active')
    if (paths.length === 0) {
      active.busy = false
      active.confirming = false
      active.error = 'No selected folder is still available.'
      this.publish(active)
      return { active: this.snapshot }
    }
    this.finishFolder(active, { cancelled: false, paths })
    return { active: null }
  }

  private closeAuxiliaryWindow(windowId: string, ownerShell: DesktopWindowOwner): { closed: boolean } {
    const owned = this.children.get(windowId)
    if (!owned || owned.ownerShell.connId !== ownerShell.connId) {
      throw conflict('this browser tab is not owned by the selected shell')
    }
    if (!owned.child.closed) this.closeChild(owned.child)
    return { closed: owned.child.closed }
  }

  private async activateOwner(windowId: string): Promise<{ activated: true }> {
    if (!this.options.windowRoute || this.options.windowRoute.windowId !== windowId) {
      throw conflict('the browser tab route does not identify this owner')
    }
    if (!this.options.focusOwner || !(await this.options.focusOwner())) {
      throw conflict('the owning browser tab could not be focused')
    }
    return { activated: true }
  }

  private validateControl(params: ControlParams): { action: ControlAction; connId: number } {
    if (!isRecord(params) || !Number.isSafeInteger(params.connId) || Number(params.connId) < 1 || typeof params.action !== 'string') {
      throw invalidParams('connId and action are required')
    }
    const actions: readonly string[] = ['state', 'set-path', 'navigate', 'select', 'confirm', 'cancel', 'open-popup']
    if (!actions.includes(params.action)) throw invalidParams('unknown browser host action')
    const action = params.action as ControlAction
    const allowed = new Set(['connId', 'action'])
    if (action !== 'state') allowed.add('requestId')
    if (action === 'set-path' || action === 'navigate' || action === 'select') allowed.add('path')
    if (action === 'navigate') allowed.add('offset')
    if (action === 'select') allowed.add('selected')
    for (const key of Object.keys(params)) {
      if (!allowed.has(key)) throw invalidParams(`${key} is not valid for ${action}`)
    }
    if (action !== 'state' && (typeof params.requestId !== 'string' || params.requestId.length === 0)) {
      throw invalidParams('requestId is required for this browser host action')
    }
    if (action === 'set-path' && typeof params.path !== 'string') throw invalidParams('path is required')
    if (action === 'navigate' && typeof params.path !== 'string') throw invalidParams('path is required')
    if (action === 'select' && (typeof params.path !== 'string' || params.path.length === 0)) {
      throw invalidParams('path must be a non-empty string')
    }
    if (action === 'navigate' && params.offset !== undefined && (!Number.isSafeInteger(params.offset) || Number(params.offset) < 0)) {
      throw invalidParams('offset must be a non-negative integer')
    }
    if (action === 'select' && typeof params.selected !== 'boolean') throw invalidParams('selected must be a boolean')
    return { action, connId: Number(params.connId) }
  }

  private actionMatchesRequest(active: ActiveRequest, action: ControlAction): boolean {
    if (action === 'cancel') return true
    if (active.kind === 'folder-picker') return action === 'set-path' || action === 'navigate' || action === 'select' || action === 'confirm'
    return action === 'open-popup'
  }

  private requireIdle(): void {
    if (this.disposed) throw conflict('browser host is unavailable')
    if (this.active) throw conflict('another browser host request is already open')
  }

  private arm(active: ActiveRequest): void {
    const schedule = this.options.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay))
    active.timer = schedule(() => this.expire(active), BROWSER_HOST_LEASE_MS)
  }

  private expire(active: ActiveRequest): void {
    if (!this.isCurrent(active)) return
    if (active.kind === 'folder-picker') {
      this.finishFolder(active, { cancelled: true, paths: [] })
      return
    }
    if (active.child) this.closeChild(active.child)
    if (!active.settled) {
      active.settled = true
      active.reject(conflict('browser tab opening expired'))
    }
    this.clearActive(active)
  }

  private cancel(active: ActiveRequest, message: string): void {
    if (!this.isCurrent(active)) return
    if (active.kind === 'folder-picker') {
      this.finishFolder(active, { cancelled: true, paths: [] })
      return
    }
    if (active.child) this.closeChild(active.child)
    if (!active.settled) {
      active.settled = true
      active.reject(conflict(message))
    }
    this.clearActive(active)
  }

  private finishFolder(active: FolderRequest, result: FolderPickerResult): void {
    if (!this.isCurrent(active)) return
    active.settled = true
    active.resolve(result)
    this.clearActive(active)
  }

  private finishActive(active: ActiveRequest): void {
    if (!this.isCurrent(active)) return
    this.clearActive(active)
  }

  private clearActive(active: ActiveRequest): void {
    if (active.timer !== undefined) {
      const cancelTimer = this.options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as Timer))
      cancelTimer(active.timer)
      active.timer = undefined
    }
    if (this.active !== active) return
    this.active = null
    this.snapshot = null
    this.notify()
  }

  private isCurrent(active: ActiveRequest): boolean {
    return this.active === active
  }

  private publish(active: ActiveRequest): void {
    if (this.active !== active) return
    if (active.kind === 'window-open' && active.windowId) {
      this.snapshot = null
    } else {
      this.snapshot = {
        requestId: active.requestId,
        kind: active.kind,
        title: active.title,
        expiresAt: active.expiresAt,
        busy: active.busy,
        error: active.error,
        ...(active.kind === 'folder-picker' ? {
          draftPath: active.draftPath,
          ...(active.directory ? { directory: active.directory } : {}),
          selectedPaths: [...active.selectedPaths],
          multiple: active.multiple
        } : {})
      }
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* one surface cannot interrupt another */ }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private closeChild(child: BrowserPopup): void {
    if (child.closed) return
    try { child.close() } catch { /* a closed or browser-owned tab cannot be reopened */ }
  }
}

export function createBrowserHost(options: BrowserHostOptions): BrowserHostController {
  return new BrowserHostController(options)
}
