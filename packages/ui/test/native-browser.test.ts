import { describe, expect, test } from 'bun:test'
import type {
  NativeBrowserOptions,
  NativeBrowserRequest,
  NativeBrowserState
} from '@quirky/protocol'
import {
  createNativeBrowserCapability,
  type NativeBrowserAdapter,
  type NativeBrowserAdapterHandle
} from '../src/native-browser'

const TEST_PARTITION = `persist:quirky-browser-profile_${crypto.randomUUID().replaceAll('-', '')}`
const element = {} as HTMLElement

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }
type ModelChild = {
  state: NativeBrowserState
  history: string[]
  cursor: number
  partition: string
  disposed: boolean
  released: boolean
  claimStarted: Deferred<void>
  disposalComplete: Deferred<void>
  firstNavigation?: Deferred<NativeBrowserState>
}

function options(overrides: Partial<NativeBrowserOptions> = {}): NativeBrowserOptions {
  return {
    id: 'pane-1',
    url: 'https://example.test/first',
    zoom: 0,
    partition: TEST_PARTITION,
    onState() {},
    ...overrides
  }
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

/** Stateful model of one isolated view, history, and the trusted shell bridge. */
class BrowserBridgeModel implements NativeBrowserAdapter {
  readonly clearPartitionAvailable = false
  readonly children = new Map<string, ModelChild>()
  readonly clearCalls: string[] = []
  slowFirstNavigation = false
  nextClaim: Deferred<void> | null = null
  nextDispose: Deferred<void> | null = null
  releaseCount = 0
  private activeId: string | null = null
  get activeChildId(): string | null {
    return this.activeId
  }

  mount(
    _element: HTMLElement,
    options: NativeBrowserOptions,
    afterDispose: Promise<void>,
    onState: (state: NativeBrowserState) => void
  ): NativeBrowserAdapterHandle {
    const child: ModelChild = {
      state: {
        id: options.id,
        url: 'about:blank',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        zoom: options.zoom,
        error: null,
        findCurrent: 0,
        findTotal: 0
      },
      history: ['about:blank'],
      cursor: 0,
      partition: options.partition,
      disposed: false,
      released: false,
      claimStarted: deferred<void>(),
      disposalComplete: deferred<void>()
    }
    this.children.set(options.id, child)
    const claimGate = this.nextClaim
    this.nextClaim = null
    const ready = afterDispose.then(async () => {
      if (child.disposed) throw new Error('native browser view disposed')
      if (this.activeId !== null) throw new Error('window already has a native browser view')
      this.activeId = options.id
      child.claimStarted.resolve()
      if (claimGate) await claimGate.promise
      if (child.disposed) {
        this.release(child, options.id)
        throw new Error('native browser view disposed')
      }
    })
    const snapshot = () => ({ ...child.state })
    const emit = () => onState(snapshot())
    const showHistoryEntry = (url: string) => {
      child.state = {
        ...child.state,
        url,
        title: url === 'about:blank' ? 'New Tab' : new URL(url).hostname,
        loading: false,
        canGoBack: child.cursor > 0,
        canGoForward: child.cursor + 1 < child.history.length,
        error: null,
        findCurrent: 0,
        findTotal: 0
      }
      emit()
    }
    const navigate = (url: string) => {
      child.history.splice(child.cursor + 1)
      child.history.push(url)
      child.cursor = child.history.length - 1
      showHistoryEntry(url)
    }

    return {
      evaluate: async (script: string): Promise<unknown> => {
        await ready
        if (child.disposed) throw new Error('native browser view disposed')
        return JSON.parse(script)
      },
      request: async (command: NativeBrowserRequest): Promise<NativeBrowserState> => {
        await ready
        if (child.disposed) throw new Error('native browser view disposed')
        if (command.action === 'navigate') {
          navigate(command.url)
          const result = snapshot()
          if (this.slowFirstNavigation && command.url.endsWith('/first')) {
            child.firstNavigation = deferred<NativeBrowserState>()
            return child.firstNavigation.promise
          }
          return result
        }
        throw new Error('test adapter only models navigation')
      },
      dispose: async () => {
        const disposeGate = this.nextDispose
        this.nextDispose = null
        child.disposed = true
        await ready.catch(() => undefined)
        if (disposeGate) await disposeGate.promise
        this.release(child, options.id)
        child.disposalComplete.resolve()
      }
    }
  }

  async clearPartition(partition: string): Promise<void> {
    this.clearCalls.push(partition)
    throw new Error('test model does not clear native website data')
  }

  private release(child: ModelChild, id: string): void {
    if (child.released) return
    child.released = true
    if (this.activeId === id) this.activeId = null
    this.releaseCount++
  }
}

describe('native browser capability', () => {

  test('plain web is unavailable and never claims partition cleanup succeeded', async () => {
    const capability = createNativeBrowserCapability()

    expect(capability.available).toBe(false)
    expect(capability.clearPartitionAvailable).toBe(false)
    expect(() => capability.mount(element, options())).toThrow()
    await expect(capability.clearPartition(TEST_PARTITION)).rejects.toBeInstanceOf(Error)
  })

  test('rejects unsafe protocols and non-browser partitions before creating a child', () => {
    const bridge = new BrowserBridgeModel()
    const capability = createNativeBrowserCapability(bridge)

    expect(() => capability.mount(element, options({ url: 'javascript:alert(1)' }))).toThrow()
    expect(() => capability.mount(element, options({ url: 'data:text/html,hi' }))).toThrow()
    expect(() => capability.mount(element, options({ partition: 'persist:default' }))).toThrow()
    expect(bridge.children.size).toBe(0)
  })

  test('replacement disposes the old child and rejects its later requests before claiming another', async () => {
    const bridge = new BrowserBridgeModel()
    const capability = createNativeBrowserCapability(bridge)
    const first = capability.mount(element, options())
    await first.request({ action: 'navigate', url: 'https://example.test/initial' })
    const firstChild = bridge.children.get('pane-1')!

    const second = capability.mount(element, options({ id: 'pane-2', url: 'about:blank' }))
    await second.request({ action: 'navigate', url: 'https://example.test/second' })
    const secondChild = bridge.children.get('pane-2')!

    expect(firstChild.disposed).toBe(true)
    expect(secondChild.disposed).toBe(false)
    await expect(first.request({ action: 'navigate', url: 'https://example.test/stale' })).rejects.toBeInstanceOf(Error)
    expect(bridge.activeChildId).toBe('pane-2')
    second.dispose()
    expect(secondChild.disposed).toBe(true)
  })
  test('evaluates only on the current browser handle', async () => {
    const bridge = new BrowserBridgeModel()
    const capability = createNativeBrowserCapability(bridge)
    const first = capability.mount(element, options())

    await expect(first.evaluate('{"selected":true}')).resolves.toEqual({ selected: true })

    const second = capability.mount(element, options({ id: 'pane-2', url: 'about:blank' }))
    await expect(first.evaluate('{"stale":true}')).rejects.toThrow(/disposed/i)
    await expect(second.evaluate('null')).resolves.toBeNull()
    second.dispose()
    await expect(second.evaluate('null')).rejects.toThrow(/disposed/i)
  })

  test('explicit unmount completes before a later native view claims the window', async () => {
    const bridge = new BrowserBridgeModel()
    const capability = createNativeBrowserCapability(bridge)
    const first = capability.mount(element, options())
    const firstChild = bridge.children.get('pane-1')!
    await firstChild.claimStarted.promise

    const disposeGate = deferred<void>()
    bridge.nextDispose = disposeGate
    first.dispose()
    capability.mount(element, options({ id: 'pane-2' }))
    const secondChild = bridge.children.get('pane-2')!
    expect(bridge.activeChildId).toBe('pane-1')

    disposeGate.resolve()
    await secondChild.claimStarted.promise
    await firstChild.disposalComplete.promise
    expect(bridge.activeChildId).toBe('pane-2')
  })


  test('late native navigation completion cannot overwrite a newer state', async () => {
    const bridge = new BrowserBridgeModel()
    bridge.slowFirstNavigation = true
    const capability = createNativeBrowserCapability(bridge)
    const states: NativeBrowserState[] = []
    const handle = capability.mount(element, options({ onState: (state) => states.push(state) }))
    const slow = handle.request({ action: 'navigate', url: 'https://example.test/first' })
    const latest = await handle.request({ action: 'navigate', url: 'https://example.test/second' })
    bridge.children.get('pane-1')!.firstNavigation!.resolve({
      ...latest,
      url: 'https://example.test/first',
      title: 'example.test'
    })

    expect((await slow).url).toBe('https://example.test/second')
    expect(states.at(-1)?.url).toBe('https://example.test/second')
  })

  test('disposal releases a child whose asynchronous claim completes late', async () => {
    const bridge = new BrowserBridgeModel()
    const claim = deferred<void>()
    bridge.nextClaim = claim
    const capability = createNativeBrowserCapability(bridge)
    const handle = capability.mount(element, options())
    const child = bridge.children.get('pane-1')!
    await child.claimStarted.promise

    handle.dispose()
    claim.resolve()
    await child.disposalComplete.promise

    expect(child.disposed).toBe(true)
    expect(child.released).toBe(true)
    expect(bridge.releaseCount).toBe(1)
    expect(bridge.clearCalls).toEqual([])
  })

  test('native clear is unavailable until the SDK can confirm completion', async () => {
    const bridge = new BrowserBridgeModel()
    const capability = createNativeBrowserCapability(bridge)

    expect(capability.clearPartitionAvailable).toBe(false)
    await expect(capability.clearPartition(TEST_PARTITION)).rejects.toThrow(/no completion signal/i)
    await expect(capability.clearPartition('persist:default')).rejects.toThrow(/unsupported browser partition/i)
    expect(bridge.clearCalls).toEqual([])
  })
})
