import { describe, expect, test } from 'bun:test'
import { NATIVE_BROWSER_NAVIGATION_RULES } from '@quirky/protocol'
import {
  createNativeBrowserHandlers,
  isNativeBrowserNavigationAllowed,
  nativeBrowserPreloadSource,
  type NativeBrowserHostDeps,
  type NativeBrowserViewPort
} from '../src/bun/native-browser'

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
  storageIdentifier: string | null
  navigationRules: string | null = null
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
    storageIdentifier?: string | null
  }) {
    this.id = options.id
    this.windowId = options.windowId ?? 12
    this.hostWebviewId = options.hostWebviewId ?? 34
    this.sandbox = options.sandbox ?? true
    this.partition = options.partition ?? PARTITION
    this.renderer = options.renderer ?? 'native'
    this.allowedProtocols = { views: true, appData: options.appData ?? false }
    this.url = options.url ?? 'about:blank'
    this.storageIdentifier = options.storageIdentifier ?? null
  }

  setNavigationRules(rules: string[]): void {
    this.calls.push('policy')
    this.navigationRules = JSON.stringify(rules)
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

  getStorageIdentifier(): string | null {
    return this.storageIdentifier
  }

  remove(): void {
    this.calls.push('remove')
    this.removed = true
  }
}

const UNSUPPORTED_STORAGE: NativeBrowserHostDeps['storage'] = {
  identifierFor: () => null,
  prepare: () => ({ storageIdentifier: null }),
  clear: () => { throw new Error('Native browser profile clearing is unavailable') }
}

function rig(views: BrowserViewModel[], storage = UNSUPPORTED_STORAGE) {
  const handlers = createNativeBrowserHandlers({
    getWindow: () => ({ id: 12, webview: { id: 34 } }),
    getView: (id) => views.find((view) => view.id === id && !view.removed),
    storage
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

    await expect(handlers.claim({ viewId: 8, owner: 'owner-a', partition: PARTITION })).rejects.toBeInstanceOf(Error)
    expect(foreign.calls).toEqual([])

    const claim = await handlers.claim({ viewId: 7, owner: 'owner-a', partition: PARTITION })
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
      await expect(handlers.claim({ viewId: child.id, owner: `owner-${child.id}`, partition: PARTITION })).rejects.toBeInstanceOf(Error)
      expect(child.calls).toEqual([])
    }
  })

  test('a second owner cannot claim a window until the current child is released', async () => {
    const first = new BrowserViewModel({ id: 10 })
    const second = new BrowserViewModel({ id: 11 })
    const { handlers } = rig([first, second])

    await handlers.claim({ viewId: 10, owner: 'first', partition: PARTITION })
    await expect(handlers.claim({ viewId: 11, owner: 'second', partition: PARTITION })).rejects.toBeInstanceOf(Error)
    expect(second.calls).toEqual([])
    await handlers.release({ viewId: 10, owner: 'first' })
    expect(first.removed).toBe(true)
    await handlers.claim({ viewId: 11, owner: 'second', partition: PARTITION })
    expect(second.navigationRules).toBe(JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES))
  })

  test('a child removed by the SDK cannot leave a stale window claim', async () => {
    const first = new BrowserViewModel({ id: 12 })
    const second = new BrowserViewModel({ id: 13 })
    const { handlers } = rig([first, second])

    await handlers.claim({ viewId: 12, owner: 'old-owner', partition: PARTITION })
    first.remove()
    await handlers.claim({ viewId: 13, owner: 'new-owner', partition: PARTITION })

    expect(second.navigationRules).toBe(JSON.stringify(NATIVE_BROWSER_NAVIGATION_RULES))
    expect(first.removed).toBe(true)
  })


  test('a foreign owner cannot release another view', async () => {
    const child = new BrowserViewModel({ id: 17 })
    const { handlers } = rig([child])

    await handlers.claim({ viewId: 17, owner: 'actual-owner', partition: PARTITION })
    await expect(handlers.release({ viewId: 17, owner: 'foreign-owner' })).rejects.toBeInstanceOf(Error)
    expect(child.removed).toBe(false)
    await handlers.release({ viewId: 17, owner: 'actual-owner' })
    expect(child.removed).toBe(true)
  })

  test('a view whose native store is not its profile store is never claimed', async () => {
    const identifier = '9B0C5E52-8F3A-4C1D-9E7B-2A6F4D8C1E35'
    const storage: NativeBrowserHostDeps['storage'] = { ...UNSUPPORTED_STORAGE, identifierFor: () => identifier }
    for (const child of [
      new BrowserViewModel({ id: 20 }),
      new BrowserViewModel({ id: 21, storageIdentifier: crypto.randomUUID() })
    ]) {
      const { handlers } = rig([child], storage)
      await expect(handlers.claim({ viewId: child.id, owner: 'owner', partition: PARTITION })).rejects.toThrow(/not using its profile storage/)
      expect(child.calls).toEqual([])
    }

    const owned = new BrowserViewModel({ id: 22, storageIdentifier: identifier.toLowerCase() })
    const { handlers } = rig([owned], storage)
    await handlers.claim({ viewId: 22, owner: 'owner', partition: PARTITION })
    expect(owned.calls).toEqual(['policy'])
  })

  test('prepare and clear go to the shared profile storage', async () => {
    const calls: string[] = []
    const { handlers } = rig([], {
      identifierFor: () => null,
      prepare: (partition) => { calls.push(`prepare:${partition}`); return { storageIdentifier: 'id' } },
      clear: (partition) => { calls.push(`clear:${partition}`); return { cleared: true } }
    })

    await expect(handlers.prepare({ partition: PARTITION })).resolves.toEqual({ storageIdentifier: 'id' })
    await expect(handlers.clear({ partition: PARTITION })).resolves.toEqual({ cleared: true })
    expect(calls).toEqual([`prepare:${PARTITION}`, `clear:${PARTITION}`])
  })

  test('the trusted preload learns whether native clears are confirmed', () => {
    const bundle = '(()=>{globalThis.seen=QUIRKY_NATIVE_BROWSER_CLEAR_AVAILABLE})();'
    for (const available of [true, false]) {
      const scope: { seen?: boolean } = {}
      new Function('globalThis', nativeBrowserPreloadSource(bundle, available))(scope)
      expect(scope.seen).toBe(available)
    }
  })
})
