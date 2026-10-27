import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { ensureDaemon, quirkyHome, rpcUrl, type RuntimeInfo } from '@quirky/protocol/node'
import { BrowserWindow, Tray, Utils, app } from 'electrobun/main'
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
import { resolveRuntimeEnv, trayDotPath } from './paths'
import { playSound } from './sound'

const WINDOW_TITLE = 'Quirky'
const SETTINGS_VIEW_ID = 'view:quirky.notifications/settings'

const pathOptions = {
  packaged: app.isPackaged,
  moduleDir: import.meta.dir,
  env: process.env,
  exists: existsSync
}

Object.assign(process.env, resolveRuntimeEnv(pathOptions))

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
  const created = new BrowserWindow({
    title: WINDOW_TITLE,
    frame: { width: 1400, height: 900, x: 80, y: 80 },
    ...content
  })
  created.on('close', () => {
    stopping = true
    window = null
  })
  created.on('focus', () => applyTray({ type: 'focus' }))
  return created
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
      if (shouldRefreshBadge(event)) void badge.refresh()
    })
    void refreshShowMenuBarIcon(connected)
    void badge.refresh()
  },
  onDisconnected: () => {
    client = null
  },
  onError: showError,
  sleep: (ms) => Bun.sleep(ms),
  shouldStop: () => stopping
})
