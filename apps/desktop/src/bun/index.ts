import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { ensureDaemon, quirkyHome, rpcUrl, type RuntimeInfo } from '@quirky/protocol/node'
import { BrowserWindow, Tray, Utils, app } from 'electrobun/main'
import { maintainConnection } from './connection'
import { setDockBadge } from './dock'
import { badgeLabel, createBadgeUpdater, notificationFor, shouldRefreshBadge } from './events'
import { daemonUrl, errorPageHtml } from './page'
import { resolveRuntimeEnv } from './paths'

const WINDOW_TITLE = 'Quirky'

Object.assign(
  process.env,
  resolveRuntimeEnv({
    packaged: app.isPackaged,
    moduleDir: import.meta.dir,
    env: process.env,
    exists: existsSync
  })
)

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
  return created
}

function showWindow(): void {
  if (window) {
    window.show()
    window.activate()
  }
}

const tray = new Tray({ title: 'Q' })
tray.setMenu([
  { type: 'normal', label: 'Show Quirky', action: 'show' },
  { type: 'divider' },
  { type: 'normal', label: 'Quit Quirky', action: 'quit' }
])
tray.on('tray-clicked', (event) => {
  const action = (event as { data?: { action?: string } }).data?.action
  if (action === 'show') showWindow()
  if (action === 'quit') {
    stopping = true
    app.quit()
  }
})

let client: QuirkyClient | null = null
const badge = createBadgeUpdater({
  load: async () => {
    if (!client) throw new Error('not connected')
    const [sessions, asks] = await Promise.all([
      client.call('session.list', {}),
      client.call('ask.list', { pendingOnly: true })
    ])
    return { sessions, asks }
  },
  apply: (count) => setDockBadge(badgeLabel(count))
})

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
      if (notification) Utils.showNotification(notification)
      if (shouldRefreshBadge(event)) void badge.refresh()
    })
    void badge.refresh()
  },
  onDisconnected: () => {
    client = null
  },
  onError: showError,
  sleep: (ms) => Bun.sleep(ms),
  shouldStop: () => stopping
})
