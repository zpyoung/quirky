import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { ensureDaemon, quirkyHome, rpcUrl, type RuntimeInfo } from '@quirky/protocol/node'
import { ApplicationMenu, BrowserView, BrowserWindow, Tray, Updater, Utils, app, type ApplicationMenuItemConfig } from 'electrobun/main'
import { maintainConnection } from './connection'
import { setDockBadge } from './dock'
import { desktopWindowRouteUrl, folderPickerResult } from './desktop-window-route'
import {
  TRAY_MENU,
  attentionIn,
  badgeLabel,
  createBadgeUpdater,
  loadBadge,
  loadShowMenuBarIcon,
  notificationFor,
  shouldRefreshBadge,
  showMenuBarIconIn,
  soundIn,
  trayState,
  type TrayInput,
  type TrayState
} from './events'
import { daemonUrl, errorPageHtml } from './page'
import { findRepoRoot, resolveRuntimeEnv, trayDotPath } from './paths'
import { createNativeBrowserHandlers, type NativeBrowserHostRPC } from './native-browser'
import { playSound } from './sound'
import {
  UPDATE_APPLY_ACTION,
  UPDATE_CHECK_ACTION,
  createUpdateController,
  trayMenuWithUpdates,
  updateActionFromEvent
} from './updates'
import { loadViewMenuSettings, toggleViewMenuSetting, viewMenuSettingFromEvent, type ViewMenuSetting } from './view-menu'

const WINDOW_TITLE = 'Quirky'
const SETTINGS_VIEW_ID = 'view:quirky.notifications/settings'

const pathOptions = {
  packaged: app.isPackaged,
  moduleDir: import.meta.dir,
  env: process.env,
  exists: existsSync
}

Object.assign(process.env, resolveRuntimeEnv(pathOptions))

async function loadNativeBrowserPreload(): Promise<string> {
  const repoRoot = process.env.QUIRKY_REPO_ROOT || findRepoRoot(import.meta.dir, existsSync)
  const resourceDir = app.isPackaged
    ? dirname(process.env.QUIRKY_UI_DIR ?? '')
    : repoRoot ? join(repoRoot, 'apps', 'desktop', 'resources') : ''
  if (!resourceDir) throw new Error('cannot locate native browser preload resources')
  const preloadPath = join(resourceDir, 'native-browser-preload.js')
  if (existsSync(preloadPath)) return readFileSync(preloadPath, 'utf8')
  if (app.isPackaged || !repoRoot) throw new Error('native browser preload bundle is missing')

  const entry = join(repoRoot, 'apps', 'desktop', 'src', 'bun', 'native-browser-preload.ts')
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife', minify: true })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('failed to bundle trusted native browser preload')
  }
  const output = result.outputs[0]
  if (!output) throw new Error('trusted native browser preload bundle is empty')
  return output.text()
}

const nativeBrowserPreload = await loadNativeBrowserPreload()

const logPath = join(quirkyHome(), 'logs', 'daemon.log')
let stopping = false
let currentUrl: string | null = null
let shownError: string | null = null
let window: BrowserWindow | null = null

type WindowLifecycle =
  | { kind: 'main' }
  | { kind: 'auxiliary'; windowId: string; ownerWindowId: number; ownerShellConnId: number; title: string }

const auxiliaryWindows = new Map<string, { ownerWindowId: number; ownerShellConnId: number; window: BrowserWindow }>()
const pendingAuxiliaryCloses = new Map<string, { windowId: string; ownerShellConnId: number }>()

function notifyAuxiliaryWindowClosed(windowId: string, ownerShellConnId: number): void {
  pendingAuxiliaryCloses.set(windowId, { windowId, ownerShellConnId })
  void flushAuxiliaryWindowCloses()
}

async function flushAuxiliaryWindowCloses(connected = client): Promise<void> {
  if (!connected) return
  for (const [windowId, notice] of pendingAuxiliaryCloses) {
    if (client !== connected) return
    try {
      await connected.callAny('desktop.window.closed', notice)
      pendingAuxiliaryCloses.delete(windowId)
    } catch (error) {
      console.warn('reporting auxiliary window close failed:', error)
      return
    }
  }
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (message === shownError && window) return
  console.error('daemon unavailable:', message)
  shownError = message
  currentUrl = null
  const html = errorPageHtml(message, logPath)
  if (!window) {
    window = createWindow({ html, url: null })
    return
  }
  window.webview.loadHTML(html)
}

function showDaemon(info: RuntimeInfo): void {
  const url = daemonUrl(info)
  if (url === currentUrl) return
  currentUrl = url
  shownError = null
  if (!window) {
    window = createWindow({ html: null, url })
    return
  }
  window.webview.loadURL(url)
}

function createWindow(
  content: { html: string | null; url: string | null },
  lifecycle: WindowLifecycle = { kind: 'main' }
): BrowserWindow {
  let created: BrowserWindow | null = null
  const nativeBrowserHandlers = createNativeBrowserHandlers({
    getWindow: () => created ? { id: created.id, webview: created.webview } : null,
    getView: (id) => BrowserView.getById(id)
  })
  const pickFolder = async (request: NativeBrowserHostRPC['bun']['requests']['pickFolder']['params']) => {
    if (process.platform !== 'darwin') throw new Error('native directory selection is unavailable on this platform')
    const paths = await Utils.openFileDialog({
      ...(request.startingFolder === undefined ? {} : { startingFolder: request.startingFolder }),
      canChooseFiles: false,
      canChooseDirectory: true,
      allowsMultipleSelection: request.multiple ?? false
    })
    return folderPickerResult(paths)
  }
  const openWindow = (input: NativeBrowserHostRPC['bun']['requests']['openWindow']['params']) => {
    if (process.platform !== 'darwin') throw new Error('native auxiliary windows are unavailable on this platform')
    if (!created || !currentUrl) throw new Error('the native desktop view is not ready')
    const { request, ownerShell } = input
    const windowId = randomUUID()
    const routeUrl = desktopWindowRouteUrl(currentUrl, request, windowId, ownerShell)
    const child = createWindow(
      { html: null, url: routeUrl },
      { kind: 'auxiliary', windowId, ownerWindowId: created.id, ownerShellConnId: ownerShell.connId, title: request.title ?? WINDOW_TITLE }
    )
    child.show()
    child.activate()
    return { windowId }
  }
  const closeWindow = (request: NativeBrowserHostRPC['bun']['requests']['closeWindow']['params']) => {
    const owned = auxiliaryWindows.get(request.windowId)
    if (!owned || owned.ownerWindowId !== created?.id) return { closed: false }
    owned.window.close()
    return { closed: true }
  }
  const activateOwner = (request: NativeBrowserHostRPC['bun']['requests']['activateOwner']['params']) => {
    if (lifecycle.kind !== 'auxiliary' || lifecycle.windowId !== request.windowId) return { activated: false }
    const child = auxiliaryWindows.get(request.windowId)
    if (!child || child.window.id !== created?.id || child.ownerWindowId !== lifecycle.ownerWindowId) return { activated: false }
    const ownerWindow = window?.id === child.ownerWindowId
      ? window
      : [...auxiliaryWindows.values()].find((entry) => entry.window.id === child.ownerWindowId)?.window ?? null
    if (!ownerWindow) return { activated: false }
    ownerWindow.show()
    ownerWindow.activate()
    return { activated: true }
  }
  const revealItem = (request: NativeBrowserHostRPC['bun']['requests']['revealItem']['params']) => {
    if (process.platform !== 'darwin') throw new Error('native item reveal is unavailable on this platform')
    Utils.showItemInFolder(request.path)
    return { requested: true as const }
  }
  const rpc = BrowserView.defineRPC<NativeBrowserHostRPC>({
    handlers: {
      requests: {
        claimNativeBrowserView: nativeBrowserHandlers.claim,
        setNativeBrowserZoom: nativeBrowserHandlers.setZoom,
        releaseNativeBrowserView: nativeBrowserHandlers.release,
        pickFolder,
        openWindow,
        closeWindow,
        readClipboardText: () => Utils.clipboardReadText() ?? '',
        revealItem,
        activateOwner
      }
    }
  })
  const nativeBrowserWindowOptions = process.platform === 'darwin' ? { preload: nativeBrowserPreload, rpc } : {}
  created = new BrowserWindow({
    title: lifecycle.kind === 'auxiliary' ? lifecycle.title : WINDOW_TITLE,
    frame: { width: 1400, height: 900, x: 80, y: 80 },
    ...content,
    ...nativeBrowserWindowOptions
  })
  const ownedWindow = created
  if (lifecycle.kind === 'auxiliary') {
    auxiliaryWindows.set(lifecycle.windowId, {
      ownerWindowId: lifecycle.ownerWindowId,
      ownerShellConnId: lifecycle.ownerShellConnId,
      window: ownedWindow
    })
  }
  ownedWindow.on('close', () => {
    nativeBrowserHandlers.dispose()
    if (lifecycle.kind === 'main') {
      for (const child of auxiliaryWindows.values()) {
        if (child.ownerWindowId === ownedWindow.id) child.window.close()
      }
      stopping = true
      window = null
    } else {
      auxiliaryWindows.delete(lifecycle.windowId)
      notifyAuxiliaryWindowClosed(lifecycle.windowId, lifecycle.ownerShellConnId)
    }
  })
  ownedWindow.on('focus', () => applyTray({ type: 'focus' }))
  return ownedWindow
}

function showWindow(): void {
  if (window) {
    window.show()
    window.activate()
  }
}

function onTrayClicked(event: unknown): void {
  const action = (event as { data?: { action?: string } }).data?.action
  if (action === 'show') showWindow()
  if (action === 'settings') {
    showWindow()
    void client?.callAny('ui.view.open', { id: SETTINGS_VIEW_ID }).catch((error) => {
      console.warn('opening notification settings failed:', error)
    })
  }
  if (action === 'quit') {
    stopping = true
    app.quit()
  }
  runUpdateAction(updateActionFromEvent(event))
}

const trayDotImage = trayDotPath(pathOptions)
let trayModel: TrayState = { visible: true, dot: false }
let tray: Tray | null = null
let trayShowsDot = false
let readyUpdateVersion: string | null = null

function createTray(dot: boolean): Tray {
  const created = dot
    ? new Tray({ title: 'Q', image: trayDotImage, template: false, width: 16, height: 16 })
    : new Tray({ title: 'Q' })
  created.setMenu(trayMenuWithUpdates(TRAY_MENU, readyUpdateVersion))
  created.on('tray-clicked', onTrayClicked)
  return created
}

function renderTray(): void {
  if (!tray || trayShowsDot !== trayModel.dot) {
    tray?.remove()
    tray = createTray(trayModel.dot)
    trayShowsDot = trayModel.dot
  }
  tray.setVisible(trayModel.visible)
}

function applyTray(input: TrayInput): void {
  trayModel = trayState(trayModel, input)
  renderTray()
}

function windowIsVisible(): boolean {
  return window !== null && window.isVisible() && !window.isMinimized()
}

renderTray()

app.on('before-quit', () => setDockBadge(''))

let client: QuirkyClient | null = null
const badge = createBadgeUpdater({
  load: async () => {
    const connected = client
    if (!connected) throw new Error('not connected')
    return loadBadge((method, params) => connected.callAny(method, params))
  },
  apply: (count) => setDockBadge(badgeLabel(count))
})

async function refreshShowMenuBarIcon(connected: QuirkyClient): Promise<void> {
  try {
    const value = await loadShowMenuBarIcon((method, params) => connected.callAny(method, params))
    applyTray({ type: 'showMenuBarIcon', value })
  } catch (error) {
    console.warn('reading Show Menu Bar Icon failed:', error)
  }
}

const nativeViewMenu: ApplicationMenuItemConfig & { submenu: ApplicationMenuItemConfig[] } = { label: 'View', submenu: [] }
const quirkyMenu: ApplicationMenuItemConfig & { submenu: ApplicationMenuItemConfig[] } = { label: 'Quirky', submenu: [] }
const applicationMenu: ApplicationMenuItemConfig[] = [
  quirkyMenu,
  { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'divider' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  nativeViewMenu,
  { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] }
]
let menuRequest = 0
function renderQuirkyMenu(): void {
  quirkyMenu.submenu = [
    { role: 'about' },
    { label: 'Check for Updates…', action: UPDATE_CHECK_ACTION },
    { label: 'Restart to Update', action: UPDATE_APPLY_ACTION, hidden: readyUpdateVersion === null },
    { type: 'divider' },
    { role: 'hide' },
    { role: 'hideOthers' },
    { role: 'showAll' },
    { type: 'divider' },
    { role: 'quit' }
  ]
}
let viewMenuItems: ViewMenuSetting[] = []
function renderApplicationMenu(items: ViewMenuSetting[]): void {
  viewMenuItems = items
  renderQuirkyMenu()
  nativeViewMenu.submenu = items.map(item => ({ label: item.label, checked: item.checked, action: `view-setting:${encodeURIComponent(item.id)}` }))
  if (items.length > 0) nativeViewMenu.submenu.push({ type: 'divider' })
  nativeViewMenu.submenu.push({ role: 'toggleFullScreen' })
  ApplicationMenu.setApplicationMenu(applicationMenu)
}
async function refreshViewMenu(connected: QuirkyClient): Promise<void> {
  const request = ++menuRequest
  try {
    const items = await loadViewMenuSettings((method, params) => connected.callAny(method, params))
    if (request === menuRequest && client === connected) renderApplicationMenu(items)
  } catch (error) { console.warn('reading View menu settings failed:', error) }
}
ApplicationMenu.on('application-menu-clicked', event => {
  const updateAction = updateActionFromEvent(event)
  if (updateAction) {
    runUpdateAction(updateAction)
    return
  }
  const setting = viewMenuSettingFromEvent(event)
  const connected = client
  if (!setting || !connected) return
  void toggleViewMenuSetting((method, params) => connected.callAny(method, params), setting)
    .then(() => refreshViewMenu(connected))
    .catch(error => {
      console.warn('updating View menu setting failed:', error)
      Utils.showNotification({ title: 'Could not update View setting', body: error instanceof Error ? error.message : String(error), silent: true })
    })
})
renderApplicationMenu([])

const updates = createUpdateController({
  updater: Updater,
  notify: ({ title, body }) => Utils.showNotification({ title, body, silent: true }),
  onReady: (version) => {
    readyUpdateVersion = version
    tray?.setMenu(trayMenuWithUpdates(TRAY_MENU, version))
    renderApplicationMenu(viewMenuItems)
  },
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  }
})

function runUpdateAction(action: ReturnType<typeof updateActionFromEvent>): void {
  if (action === UPDATE_CHECK_ACTION) void updates.checkNow()
  if (action === UPDATE_APPLY_ACTION) void updates.restart()
}

void updates.start()

let latest: RuntimeInfo | null = null

try {
  latest = await ensureDaemon({ replaceStale: true })
  showDaemon(latest)
} catch (error) {
  showError(error)
}

void maintainConnection({
  ensure: async () => {
    latest = await ensureDaemon({ replaceStale: true })
    showDaemon(latest)
  },
  connect: () =>
    QuirkyClient.connect(rpcUrl(latest as RuntimeInfo), {
      role: 'desktop',
      name: 'Quirky desktop',
      subscribe: true
    }),
  onConnected: (connected) => {
    client = connected
    void flushAuxiliaryWindowCloses(connected)
    connected.onEvent((event) => {
      const notification = notificationFor(event)
      if (notification) {
        Utils.showNotification({ title: notification.title, body: notification.body, silent: notification.silent })
        if (notification.soundFile) playSound(notification.soundFile, notification.volume)
      }
      const sound = soundIn(event)
      if (sound) playSound(sound.file, sound.volume)
      if (attentionIn(event)) applyTray({ type: 'attention', windowVisible: windowIsVisible() })
      const showMenuBarIcon = showMenuBarIconIn(event)
      if (showMenuBarIcon !== null) applyTray({ type: 'showMenuBarIcon', value: showMenuBarIcon })
      if (event.type === 'plugin.changed') void refreshShowMenuBarIcon(connected)
      if (event.type === 'plugin.changed' || event.type === 'setting.changed') void refreshViewMenu(connected)
      if (shouldRefreshBadge(event)) void badge.refresh()
    })
    void refreshShowMenuBarIcon(connected)
    void refreshViewMenu(connected)
    void badge.refresh()
  },
  onDisconnected: () => {
    client = null
    menuRequest++
    renderApplicationMenu([])
  },
  onError: showError,
  sleep: (ms) => Bun.sleep(ms),
  shouldStop: () => stopping
})
