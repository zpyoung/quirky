import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { MobileDevice, MobileNetworkInterface, MobilePairingResult, MobileState, QuirkyEvent, UiPluginContext } from '@quirky/protocol'

const PAGE = 'view:quirky.mobile/page'
const SETTINGS = 'view:quirky.mobile/settings'
const OPEN = 'command:quirky.mobile/open'
const OPEN_SETTINGS = 'command:quirky.mobile/open-settings'

type Call = { method: string; params: Record<string, unknown> }
type Mount = (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void

type MobileTestWorld = {
  calls: Call[]
  interfaces: MobileNetworkInterface[]
  state: MobileState
  pairResult: MobilePairingResult
  pairFailure: Error | null
  revokeFailure: Error | null
  confirmCount: number
  device: MobileDevice
}
let activate: (context: UiPluginContext) => void
let act: (callback: () => unknown) => Promise<void>
let container: HTMLDivElement
let cleanup: (() => void) | undefined
let world: MobileTestWorld
let provided: Map<string, unknown>
let openViews: { id: string; input?: unknown }[]
let eventListeners: Set<(event: QuirkyEvent) => void | Promise<void>>
let clipboardDescriptor: PropertyDescriptor | undefined

// Load ReactDOM and the plugin view only after Happy DOM has installed its browser globals.
beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act = (await import('react')).act as typeof act
  activate = (await import('../src/ui')).activate
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  container = document.createElement('div')
  document.body.append(container)
  world = createWorld()
  provided = new Map()
  openViews = []
  eventListeners = new Set()
  const layout = { view: null, panel: null, sidebar: true, focus: null }
  const context = {
    pluginId: 'quirky.mobile',
    log() {},
    provide(id: string, implementation: unknown) {
      provided.set(id, implementation)
    },
    async call(method: string, params: Record<string, unknown> = {}) {
      world.calls.push({ method, params })
      switch (method) {
        case 'quirky.mobile/state':
          return structuredClone(world.state)
        case 'quirky.mobile/interfaces':
          return structuredClone(world.interfaces)
        case 'quirky.mobile/devices':
          return structuredClone(world.state.devices)
        case 'quirky.mobile/configure':
          world.state = { ...world.state, ...params }
          return structuredClone(world.state)
        case 'quirky.mobile/pair':
          if (world.pairFailure) throw world.pairFailure
          return world.pairResult
        case 'quirky.mobile/revoke':
          if (world.revokeFailure) throw world.revokeFailure
          world.state = { ...world.state, devices: world.state.devices.filter((device) => device.deviceId !== params.deviceId) }
          return { revoked: true }
        default:
          throw new Error(`unexpected method ${method}`)
      }
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    getSetting() {},
    async executeCommand() {},
    openView(id: string, input?: unknown) {
      openViews.push(input === undefined ? { id } : { id, input })
    },
    closeView() {},
    togglePanel() {},
    getLayout: () => layout,
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection: () => () => {},
    confirm: async () => {
      world.confirmCount++
      return true
    },
    toast() {},
    setPanelBadge() {},
    setContext() {},
    mountView: () => () => {}
  } as unknown as UiPluginContext
  activate(context)
})

afterEach(async () => {
  if (cleanup) {
    await act(async () => cleanup?.())
    cleanup = undefined
  }
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  container.remove()
})

function createWorld(): MobileTestWorld {
  const interfaces: MobileNetworkInterface[] = [
    { name: 'tailscale0', address: '100.64.0.7', family: 'IPv4', kind: 'tailscale' },
    { name: 'en0', address: '192.168.1.4', family: 'IPv4', kind: 'lan' }
  ]
  const device: MobileDevice = {
    deviceId: 'device-1',
    name: 'Phone',
    pairedAt: Date.UTC(2026, 9, 27, 12),
    lastSeenAt: Date.UTC(2026, 9, 27, 12)
  }
  const state: MobileState = {
    machineName: 'Mac',
    showMobileButton: true,
    onboardingSeen: false,
    autoRestoreFitMs: null,
    customAddresses: [],
    interfaces,
    devices: [],
    listener: { available: true, host: '127.0.0.1', port: 6768 },
    relay: 'unavailable'
  }
  const pairResult: MobilePairingResult = {
    available: true,
    pairingUrl: 'quirky://pair?code=offer',
    endpoint: 'ws://100.64.0.7:6768',
    deviceId: 'pending-1',
    connectionMode: 'local-only',
    qrDataUrl: 'data:image/png;base64,qr',
    qrSize: 33
  }
  return {
    calls: [] as Call[],
    interfaces,
    state,
    pairResult,
    pairFailure: null as Error | null,
    revokeFailure: null as Error | null,
    confirmCount: 0,
    device
  }
}

async function mount(id: string): Promise<void> {
  const implementation = provided.get(id) as Mount | undefined
  if (!implementation) throw new Error(`missing mount ${id}`)
  await act(async () => {
    cleanup = implementation(container, {}) ?? undefined
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  if (!found) throw new Error(`missing button: ${label}`)
  return found
}

async function click(label: string): Promise<void> {
  await act(async () => button(label).click())
}

async function changeInput(selector: string, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)
  if (!input) throw new Error(`missing input ${selector}`)
  await act(async () => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('mobile desktop flow', () => {
  test('opens declared views through commands and advances intro → truthful install → auto-generated pairing', async () => {
    const open = provided.get(OPEN) as () => void
    const openSettings = provided.get(OPEN_SETTINGS) as () => void
    open()
    openSettings()
    expect(openViews).toEqual([{ id: PAGE }, { id: SETTINGS }])

    await mount(PAGE)
    expect(container.textContent).toContain('Your workspaces, in your pocket.')
    await click('Get started')
    expect(container.textContent).toContain('Get the app')
    expect(container.textContent).toContain('Quirky mobile app is not available yet')
    expect(container.textContent).not.toContain('App Store')
    expect(container.textContent).not.toContain('Download APK')

    await click('Android')
    await click('Preview')
    await click('Continue')

    const pair = world.calls.find((call) => call.method === 'quirky.mobile/pair')
    expect(pair?.params).toEqual({ address: '100.64.0.7' })
    expect(container.textContent).toContain('ws://100.64.0.7:6768')
    expect(container.textContent).toContain('Copy pairing code')
    expect(container.querySelector('img[alt="Pairing QR code"]')?.getAttribute('src')).toBe('data:image/png;base64,qr')
  })

  test('shows actionable reachable-address guidance when automatic pairing has no address', async () => {
    world.interfaces = []
    world.state = { ...world.state, interfaces: [] }
    world.pairResult = {
      available: false,
      reason: 'invalid_advertised_endpoint',
      guidance: 'No reachable network address is available. Connect to Wi-Fi or Tailscale, or add an address manually.'
    }
    await mount(PAGE)
    await click('Get started')
    await click('Continue')
    expect(container.textContent).toContain('No reachable network address is available')
    expect(container.textContent).toContain('Refresh network interfaces')
    expect(container.textContent).toContain('Add custom address')
    expect(container.querySelector('img[alt="Pairing QR code"]')).toBeNull()
  })

  test('settings calls configure and pair only on their controls, reports revoke errors, and formats paired dates with a space', async () => {
    world.state = { ...world.state, devices: [world.device] }
    world.revokeFailure = new Error('registry unavailable')
    await mount(SETTINGS)
    expect(container.textContent).toContain('Control terminals and agents from your phone.')
    expect(container.textContent).toContain('Quirky Relay isn’t available in this build. Use LAN.')
    expect(container.textContent).toMatch(/Paired \S/)
    expect(world.calls.some((call) => call.method === 'quirky.mobile/pair')).toBe(false)

    await changeInput('input[name="machineName"]', 'Studio Mac')
    await click('Save machine name')
    expect(world.calls).toContainEqual({ method: 'quirky.mobile/configure', params: { machineName: 'Studio Mac' } })

    await click('Revoke device')
    expect(world.confirmCount).toBe(0)
    expect(container.textContent).toContain('Failed to revoke device: registry unavailable')
    const showMobile = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (!showMobile) throw new Error('missing Show Mobile in the sidebar checkbox')
    await act(async () => {
      showMobile.checked = false
      showMobile.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(world.calls).toContainEqual({ method: 'quirky.mobile/configure', params: { showMobileButton: false } })

    await click('Generate QR code')
    expect(world.calls.find((call) => call.method === 'quirky.mobile/pair')?.params).toEqual({ address: '100.64.0.7' })
    expect(container.textContent).toContain('ws://100.64.0.7:6768')
  })

  test('reacts to mobile changed events and updates the paired stage from the device API', async () => {
    await mount(PAGE)
    await click('Get started')
    await click('Continue')
    world.state = { ...world.state, devices: [world.device] }
    await act(async () => {
      await Promise.all([...eventListeners].map((listener) => listener({ type: 'quirky.mobile/changed', data: {} })))
    })
    expect(container.textContent).toContain('Your phone is paired.')
    expect(world.calls.some((call) => call.method === 'quirky.mobile/devices')).toBe(true)
  })
})
test('pairing QR enlarges and rotates; clipboard failure leaves a selectable URL fallback', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => { throw new Error('clipboard denied') } }
  })
  await mount(PAGE)
  await click('Get started')
  await click('Continue')

  const enlarge = container.querySelector<HTMLButtonElement>('[aria-label="Enlarge pairing QR code"]')
  await act(async () => enlarge?.click())
  expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  await click('Close')
  await click('Regenerate code')
  expect(world.calls.filter((call) => call.method === 'quirky.mobile/pair').at(-1)?.params).toEqual({ address: '100.64.0.7', rotate: true })

  await click('Copy pairing code')
  expect(container.textContent).toContain('Copy failed: clipboard denied')
  expect(container.querySelector<HTMLInputElement>('[aria-label="Pairing code URL"]')?.value).toBe('quirky://pair?code=offer')
})

test('settings persist fit restoration choices and custom pairing addresses', async () => {
  await mount(SETTINGS)
  await changeInput('select[aria-label="When you leave the mobile app"]', '1800000')
  expect(world.calls).toContainEqual({ method: 'quirky.mobile/configure', params: { autoRestoreFitMs: 1800000 } })

  await changeInput('input[aria-label="Custom address"]', 'pairing.example:6768')
  await click('Add custom address')
  expect(world.calls).toContainEqual({
    method: 'quirky.mobile/configure',
    params: { customAddresses: ['pairing.example:6768'] }
  })
  await click('Generate QR code')
  expect(world.calls.filter((call) => call.method === 'quirky.mobile/pair').at(-1)?.params).toEqual({ address: 'pairing.example:6768' })
})
test('sidebar Try it opens the intro, records onboarding seen, and removes the badge', async () => {
  await mount('sidebar-section:quirky.mobile/mobile')
  expect(container.textContent).toContain('Try it')
  const mobileButton = container.querySelector<HTMLButtonElement>('[aria-label="Mobile"]')
  await act(async () => mobileButton?.click())
  expect(world.calls).toContainEqual({ method: 'quirky.mobile/configure', params: { onboardingSeen: true } })
  expect(openViews).toContainEqual({ id: PAGE, input: { stage: 'intro' } })
  expect(container.textContent).not.toContain('Try it')
})
test('QR encoding failure still exposes a selectable and copyable pairing URL', async () => {
  world.pairResult = { ...world.pairResult, qrDataUrl: null, qrSize: null, qrError: 'encoding_failed' }
  await mount(PAGE)
  await click('Get started')
  await click('Continue')
  expect(container.textContent).toContain('couldn’t be rendered as a QR code')
  expect(container.textContent).toContain('QR encoding failed; the pairing URL is still available to copy.')
  expect(container.querySelector('img[alt="Pairing QR code"]')).toBeNull()
  expect(container.querySelector<HTMLInputElement>('[aria-label="Pairing code URL"]')?.value).toBe('quirky://pair?code=offer')
  expect(container.textContent).toContain('Copy pairing code')
})
