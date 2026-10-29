import { describe, expect, test } from 'bun:test'
import { NATIVE_BROWSER_NAVIGATION_RULES } from '@quirky/protocol'
import {
  createNativeBrowserHandlers,
  isNativeBrowserNavigationAllowed,
  type NativeBrowserViewPort
} from '../src/bun/native-browser'

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const PARTITION = `persist:quirky-browser-profile_${crypto.randomUUID().replaceAll('-', '')}`

class BrowserViewModel implements NativeBrowserViewPort {
  readonly id: number
  readonly windowId: number
  readonly hostWebviewId: number
  readonly sandbox: boolean
  readonly partition: string
  readonly renderer: 'native' | 'cef'
  readonly allowedProtocols: { views: boolean; appData: boolean }
  url: string
  navigationRules: string | null = null
  userAgent: string | null = null
  userAgentSupported = true
  zoom = 1
  removed = false
  calls: string[] = []

  constructor(options: {
    id: number
    windowId?: number
    hostWebviewId?: number
    sandbox?: boolean
    partition?: string
    renderer?: 'native' | 'cef'
    appData?: boolean
    url?: string
  }) {
    this.id = options.id
    this.windowId = options.windowId ?? 12
    this.hostWebviewId = options.hostWebviewId ?? 34
    this.sandbox = options.sandbox ?? true
    this.partition = options.partition ?? PARTITION
    this.renderer = options.renderer ?? 'native'
    this.allowedProtocols = { views: true, appData: options.appData ?? false }
    this.url = options.url ?? 'about:blank'
  }

  setNavigationRules(rules: string[]): void {
    this.calls.push('policy')
    this.navigationRules = JSON.stringify(rules)
  }

  setUserAgent(userAgent: string | null): boolean {
    if (!this.userAgentSupported) return false
    this.calls.push(`userAgent:${userAgent}`)
    this.userAgent = userAgent
    return true
  }

  loadURL(url: string): void {
    if (this.navigationRules !== JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES)) throw new Error('navigation policy is not ready')
    if (!isNativeBrowserNavigationAllowed(url)) throw new Error('navigation denied')
    this.calls.push(`load:${url}`)
    this.url = url
  }

  setPageZoom(factor: number): void {
    this.calls.push('zoom')
    this.zoom = factor
  }

  getPageZoom(): number {
    return this.zoom
  }

  remove(): void {
    this.calls.push('remove')
    this.removed = true
  }
}

function rig(views: BrowserViewModel[]) {
  const handlers = createNativeBrowserHandlers({
    getWindow: () => ({ id: 12, webview: { id: 34 } }),
    getView: (id) => views.find((view) => view.id === id && !view.removed),
    defaultUserAgent: () => DEFAULT_USER_AGENT
  })
  return { handlers }
}

describe('native browser host bridge model', () => {
  test('uses fail-closed SDK rules for supported URL protocols', () => {
    for (const url of ['https://example.test/', 'http://127.0.0.1:3000/', 'file:///tmp/index.html', 'about:blank']) {
      expect(isNativeBrowserNavigationAllowed(url)).toBe(true)
    }
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'views://app/index.html', 'appdata://private/file', 'mailto:test@example.test']) {
      expect(isNativeBrowserNavigationAllowed(url)).toBe(false)
    }
  })

  test('installs policy on an owned about:blank guest before any target load or zoom', async () => {
    const child = new BrowserViewModel({ id: 7 })
    const foreign = new BrowserViewModel({ id: 8, hostWebviewId: 99 })
    const { handlers } = rig([child, foreign])

    await expect(handlers.claim({ viewId: 8, owner: 'owner-a', partition: PARTITION, userAgent: null })).rejects.toBeInstanceOf(Error)
    expect(foreign.calls).toEqual([])

    const claim = await handlers.claim({ viewId: 7, owner: 'owner-a', partition: PARTITION, userAgent: null })
    expect(claim).toEqual({ zoomFactor: 1 })
    expect(child.calls).toEqual(['policy'])
    expect(child.navigationRules).toBe(JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES))
    expect(child.url).toBe('about:blank')
    child.loadURL('https://example.test/')
    expect(child.calls).toEqual(['policy', 'load:https://example.test/'])

    const zoom = await handlers.setZoom({ viewId: 7, owner: 'owner-a', level: 1.5 })
    expect(zoom.zoomFactor).toBeCloseTo(1.2 ** 1.5)
    expect(child.calls.at(-1)).toBe('zoom')
    await expect(handlers.setZoom({ viewId: 8, owner: 'owner-a', level: 2 })).rejects.toBeInstanceOf(Error)
    expect(foreign.calls).toEqual([])
  })

  test('rejects unsafe creation properties before policy or zoom is applied', async () => {
    for (const child of [
      new BrowserViewModel({ id: 1, sandbox: false }),
      new BrowserViewModel({ id: 2, partition: 'persist:default' }),
      new BrowserViewModel({ id: 3, appData: true }),
      new BrowserViewModel({ id: 4, renderer: 'cef' }),
      new BrowserViewModel({ id: 5, url: 'https://attacker.test/' })
    ]) {
      const { handlers } = rig([child])
      await expect(handlers.claim({ viewId: child.id, owner: `owner-${child.id}`, partition: PARTITION, userAgent: null })).rejects.toBeInstanceOf(Error)
      expect(child.calls).toEqual([])
    }
  })

  test('a second owner cannot claim a window until the current child is released', async () => {
    const first = new BrowserViewModel({ id: 10 })
    const second = new BrowserViewModel({ id: 11 })
    const { handlers } = rig([first, second])

    await handlers.claim({ viewId: 10, owner: 'first', partition: PARTITION, userAgent: null })
    await expect(handlers.claim({ viewId: 11, owner: 'second', partition: PARTITION, userAgent: null })).rejects.toBeInstanceOf(Error)
    expect(second.calls).toEqual([])
    await handlers.release({ viewId: 10, owner: 'first' })
    expect(first.removed).toBe(true)
    await handlers.claim({ viewId: 11, owner: 'second', partition: PARTITION, userAgent: null })
    expect(second.navigationRules).toBe(JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES))
  })

  test('a child removed by the SDK cannot leave a stale window claim', async () => {
    const first = new BrowserViewModel({ id: 12 })
    const second = new BrowserViewModel({ id: 13 })
    const { handlers } = rig([first, second])

    await handlers.claim({ viewId: 12, owner: 'old-owner', partition: PARTITION, userAgent: null })
    first.remove()
    await handlers.claim({ viewId: 13, owner: 'new-owner', partition: PARTITION, userAgent: null })

    expect(second.navigationRules).toBe(JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES))
    expect(first.removed).toBe(true)
  })


  test('a foreign owner cannot release another view', async () => {
    const child = new BrowserViewModel({ id: 17 })
    const { handlers } = rig([child])

    await handlers.claim({ viewId: 17, owner: 'actual-owner', partition: PARTITION, userAgent: null })
    await expect(handlers.release({ viewId: 17, owner: 'foreign-owner' })).rejects.toBeInstanceOf(Error)
    expect(child.removed).toBe(false)
    await handlers.release({ viewId: 17, owner: 'actual-owner' })
    expect(child.removed).toBe(true)
  })

  test('a claim applies the identity user agent after policy and before any target navigation', async () => {
    const view = new BrowserViewModel({ id: 21 })
    const { handlers } = rig([view])
    const cleaned = `${DEFAULT_USER_AGENT} Test/1`

    await handlers.claim({ viewId: 21, owner: 'owner-ua', partition: PARTITION, userAgent: cleaned })

    expect(view.userAgent).toBe(cleaned)
    expect(view.calls).toEqual(['policy', `userAgent:${cleaned}`])
    expect(await handlers.defaultUserAgent()).toEqual({ userAgent: DEFAULT_USER_AGENT })
  })

  test('a null user agent leaves the engine default untouched', async () => {
    const view = new BrowserViewModel({ id: 22 })
    const { handlers } = rig([view])

    await handlers.claim({ viewId: 22, owner: 'owner-native', partition: PARTITION, userAgent: null })

    expect(view.userAgent).toBeNull()
    expect(view.calls).toEqual(['policy'])
  })

  test('a host that cannot override the user agent fails the claim instead of pretending', async () => {
    const view = new BrowserViewModel({ id: 23 })
    view.userAgentSupported = false
    const { handlers } = rig([view])

    await expect(handlers.claim({ viewId: 23, owner: 'owner-ua', partition: PARTITION, userAgent: DEFAULT_USER_AGENT }))
      .rejects.toThrow('native browser user agent override is unavailable on this platform')
    await expect(handlers.setZoom({ viewId: 23, owner: 'owner-ua', level: 0 })).rejects.toBeInstanceOf(Error)
  })

  test('a user agent with header-breaking characters is rejected before touching the view', async () => {
    const view = new BrowserViewModel({ id: 24 })
    const { handlers } = rig([view])

    await expect(handlers.claim({ viewId: 24, owner: 'owner-ua', partition: PARTITION, userAgent: 'UA\r\nX-Injected: 1' }))
      .rejects.toThrow('invalid native browser user agent')
    expect(view.calls).toEqual([])
  })
})
