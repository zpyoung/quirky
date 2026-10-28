import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { ensureDaemon, quirkyHome, rpcUrl, type RuntimeInfo } from '@quirky/protocol/node'
import { ApplicationMenu, BrowserView, BrowserWindow, Tray, Utils, app, type ApplicationMenuItemConfig } from 'electrobun/main'
import { maintainConnection } from './connection'
import { setDockBadge } from './dock'
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

function createWindow(content: { html: string | null; url: string | null }): BrowserWindow {
  let created: BrowserWindow | null = null
  const nativeBrowserHandlers = createNativeBrowserHandlers({
    getWindow: () => created ? { id: created.id, webview: created.webview } : null,
    getView: (id) => BrowserView.getById(id)
  })
  const rpc = BrowserView.defineRPC<NativeBrowserHostRPC>({
    handlers: {
      requests: {
        claimNativeBrowserView: nativeBrowserHandlers.claim,
        setNativeBrowserZoom: nativeBrowserHandlers.setZoom,
        releaseNativeBrowserView: nativeBrowserHandlers.release
      }
    }
  })
  const nativeBrowserWindowOptions = process.platform === 'darwin' ? { preload: nativeBrowserPreload, rpc } : {}
  created = new BrowserWindow({
    title: WINDOW_TITLE,
    frame: { width: 1400, height: 900, x: 80, y: 80 },
    ...content,
    ...nativeBrowserWindowOptions
  })
  const ownedWindow = created
  ownedWindow.on('close', () => {
    nativeBrowserHandlers.dispose()
    stopping = true
    window = null
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
}

const trayDotImage = trayDotPath(pathOptions)
let trayModel: TrayState = { visible: true, dot: false }
let tray: Tray | null = null
let trayShowsDot = false

function createTray(dot: boolean): Tray {
  const created = dot
    ? new Tray({ title: 'Q', image: trayDotImage, template: false, width: 16, height: 16 })
    : new Tray({ title: 'Q' })
  created.setMenu(TRAY_MENU)
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
const applicationMenu: ApplicationMenuItemConfig[] = [
  { label: 'Quirky', submenu: [{ role: 'about' }, { type: 'divider' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'showAll' }, { type: 'divider' }, { role: 'quit' }] },
  { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'divider' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
  nativeViewMenu,
  { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] }
]
let menuRequest = 0
function renderApplicationMenu(items: ViewMenuSetting[]): void {
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

let latest: RuntimeInfo | null = null

try {
  latest = await ensureDaemon()
  showDaemon(latest)
} catch (error) {
  showError(error)
}

void maintainConnection({
  ensure: async () => {
    latest = await ensureDaemon()
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
