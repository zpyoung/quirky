import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MobilePairingResult, MobileState, UiPluginContext } from '@quirky/protocol'
import { DeviceList } from '../src/window/DeviceList'
import { MobilePage } from '../src/window/MobilePage'
import { MobileSettings } from '../src/window/MobileSettings'
import { PairingPanel } from '../src/window/PairingPanel'
import { NetworkPicker } from '../src/window/NetworkPicker'
import { activate } from '../src/ui'

let root: Root | null = null
let container: HTMLDivElement
let clipboardDescriptor: PropertyDescriptor | undefined

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  root = null
  document.body.innerHTML = ''
})

async function render(node: ReactNode) {
  await act(async () => root!.render(node))
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const pairingUrl = 'quirky-mobile://pair/sensitive-offer-fixture'
const pairingResult: MobilePairingResult = {
  available: true,
  pairingUrl,
  endpoint: 'ws://192.168.1.20:6768',
  deviceId: 'pending-device',
  connectionMode: 'local-only',
  qrDataUrl: 'data:image/png;base64,AA==',
  qrSize: 128,
}

const mobileState: MobileState = {
  machineName: 'Test desktop',
  showMobileButton: true,
  onboardingSeen: true,
  autoRestoreFitMs: null,
  customAddresses: [],
  interfaces: [{ name: 'en0', address: '192.168.1.20', family: 'IPv4', kind: 'lan' }],
  devices: [],
  listener: { available: true, host: '192.168.1.20', port: 6768 },
  relay: 'unavailable',
}

function pluginContext(call: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>): UiPluginContext {
  const providers = new Map<string, (args: unknown) => unknown>()
  const context = {
    pluginId: 'quirky.mobile',
    provide: (id: string, provider: (args: unknown) => unknown) => { providers.set(id, provider) },
    executeCommand: async (id: string, args?: unknown) => {
      const provider = providers.get(id)
      if (!provider) throw new Error(`Missing command: ${id}`)
      return provider(args)
    },
    nativeBrowser: {} as UiPluginContext['nativeBrowser'],
    call: async (method: string, params?: Record<string, unknown>) => call(method, params ?? {}),
    subscribe: () => () => {},
    openView: () => {},
    onLayout: () => () => {},
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    toast: () => {},
  } as unknown as UiPluginContext
  activate(context)
  return context
}

function mobileCall(method: string, params: Record<string, unknown>) {
  if (method === 'quirky.mobile/state') return mobileState
  if (method === 'quirky.mobile/devices') return mobileState.devices
  if (method === 'quirky.mobile/interfaces') return mobileState.interfaces
  if (method === 'quirky.mobile/configure') return { ...mobileState, ...params }
  if (method === 'quirky.mobile/pair') return pairingResult
  if (method === 'quirky.mobile/revoke') return { revoked: true }
  throw new Error(`Unexpected Mobile RPC: ${method}`)
}

describe('Mobile desktop UI behavior', () => {
  test('generates one pairing offer per Continue and Pair another device click', async () => {
    let devices: MobileState['devices'] = []
    const pairs: Record<string, unknown>[] = []
    let changed!: Parameters<UiPluginContext['subscribe']>[0]
    const context = pluginContext((method, params) => {
      if (method === 'quirky.mobile/state') return { ...mobileState, devices }
      if (method === 'quirky.mobile/devices') return devices
      if (method === 'quirky.mobile/configure') return { ...mobileState, ...params, devices }
      if (method === 'quirky.mobile/pair') pairs.push(params)
      return mobileCall(method, params)
    })
    context.subscribe = (listener) => { changed = listener; return () => {} }
    await render(<MobilePage context={context} input={{ stage: 'intro' }} />)
    await act(async () => {
      const getStarted = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Get started')
      getStarted!.click()
    })
    expect(container.textContent).toContain('Step 1 of 2')
    expect(pairs).toEqual([])
    await act(async () => {
      const next = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Continue')
      next!.click()
    })
    await flushEffects()
    expect(pairs).toEqual([{ address: '192.168.1.20' }])
    expect(container.textContent).toContain('Step 2 of 2')
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe(pairingUrl)

    devices = [{ deviceId: 'phone-1', name: 'Phone', pairedAt: 1, lastSeenAt: 1 }]
    await act(async () => { await changed({ type: 'quirky.mobile/changed', data: {} }) })
    expect(container.textContent).toContain('Your phone is paired.')
    await act(async () => {
      const pairAnother = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Pair another device')
      pairAnother!.click()
    })
    await flushEffects()
    expect(pairs).toEqual([{ address: '192.168.1.20' }, { address: '192.168.1.20' }])
    expect(container.textContent).toContain('Step 2 of 2')
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe(pairingUrl)
  })

  test.each(['page', 'settings'] as const)('clears stale %s action errors after removing a custom address', async (view) => {
    let state = { ...mobileState, customAddresses: ['phone.local'] }
    const changes: Record<string, unknown>[] = []
    const context = pluginContext((method, params) => {
      if (method === 'quirky.mobile/state') return state
      if (method === 'quirky.mobile/pair') throw new Error('listener offline')
      if (method === 'quirky.mobile/configure') {
        changes.push(params)
        state = { ...state, ...params }
        return state
      }
      return mobileCall(method, params)
    })
    await render(view === 'page'
      ? <MobilePage context={context} input={{ stage: 'pair', address: 'phone.local' }} />
      : <MobileSettings context={context} />)
    if (view === 'settings') await act(async () => {
      const address = container.querySelector<HTMLSelectElement>('select[aria-label="Network address"]')!
      address.value = 'phone.local'
      address.dispatchEvent(new Event('change', { bubbles: true }))
      const generate = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Generate QR code')
      generate!.click()
    })
    await flushEffects()
    expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('listener offline')
    await act(async () => {
      const remove = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Remove selected custom address')
      remove!.click()
    })
    expect(changes).toEqual([{ customAddresses: [] }])
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Network address"]')?.value).toBe('192.168.1.20')
    expect(container.querySelector('.ui-inline-error')).toBeNull()
  })

  test('shows shared page loading, load retry and refresh errors', async () => {
    const { promise, reject: rejectLoad } = Promise.withResolvers<MobileState>()
    let calls = 0
    let changed!: Parameters<UiPluginContext['subscribe']>[0]
    const context = pluginContext((method, params) => {
      if (method === 'quirky.mobile/state') {
        calls++
        if (calls === 1) return promise
        if (calls === 3) throw new Error('refresh down')
      }
      return mobileCall(method, params)
    })
    context.subscribe = (listener) => { changed = listener; return () => {} }
    await render(<MobilePage context={context} input={{ stage: 'intro' }} />)
    expect(container.querySelector('.ui-notice-line')?.textContent).toBe('Loading Mobile…')
    expect(container.querySelector('p[role="status"]')).toBeNull()
    await act(async () => { rejectLoad(new Error('daemon down')) })
    expect(container.querySelector('.ui-notice-line')).toBeNull()
    expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Unable to load Mobile settings: daemon down')
    expect(container.querySelector('.ui-inline-error__action')?.textContent).toBe('Try again')
    await act(async () => { container.querySelector<HTMLButtonElement>('.ui-inline-error__action')!.click() })
    expect(calls).toBe(2)
    expect(container.querySelector('.ui-inline-error')).toBeNull()
    expect(container.textContent).toContain('Control terminals and agents from your phone.')
    await act(async () => { await changed({ type: 'quirky.mobile/changed', data: {} }) })
    expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Could not refresh Mobile state: refresh down')
    expect(container.querySelector('p.ui-error-text')).toBeNull()
    await render(<MobilePage key="empty-state-result" context={pluginContext(() => undefined)} />)
    expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Unable to load Mobile settings: The daemon returned no state.')
  })

  test('shows shared settings loading, load retry and refresh errors', async () => {
    const { promise, reject: rejectLoad } = Promise.withResolvers<MobileState>()
    let calls = 0
    let changed!: Parameters<UiPluginContext['subscribe']>[0]
    const context = pluginContext((method, params) => {
      if (method === 'quirky.mobile/state') {
        calls++
        if (calls === 1) return promise
        if (calls === 3) throw new Error('refresh down')
      }
      return mobileCall(method, params)
    })
    context.subscribe = (listener) => { changed = listener; return () => {} }
    await render(<MobileSettings context={context} />)
    expect(container.querySelector('.ui-notice-line')?.textContent).toBe('Loading Mobile settings…')
    expect(container.querySelector('p[role="status"]')).toBeNull()
    await act(async () => { rejectLoad(new Error('daemon down')) })
    expect(container.querySelector('.ui-notice-line')).toBeNull()
    expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Unable to load Mobile settings: daemon down')
    expect(container.querySelector('.ui-inline-error__action')?.textContent).toBe('Try again')
    await act(async () => { container.querySelector<HTMLButtonElement>('.ui-inline-error__action')!.click() })
    expect(calls).toBe(2)
    expect(container.querySelector('.ui-inline-error')).toBeNull()
    expect(container.textContent).toContain('Control terminals and agents from your phone.')
    await act(async () => { await changed({ type: 'quirky.mobile/changed', data: {} }) })
    expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Could not refresh Mobile state: refresh down')
    expect(container.querySelector('p.ui-error-text')).toBeNull()
  })

  test('shows pairing action failures through shared errors on both views', async () => {
    for (const view of ['page', 'settings']) {
      let pairs = 0
      const context = pluginContext((method, params) => {
        if (method === 'quirky.mobile/pair') { pairs++; throw new Error('listener offline') }
        return mobileCall(method, params)
      })
      await render(view === 'page'
        ? <MobilePage key={view} context={context} input={{ stage: 'pair' }} />
        : <MobileSettings key={view} context={context} />)
      if (view === 'settings') await act(async () => {
        const generate = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Generate QR code')
        generate!.click()
      })
      await flushEffects()
      expect(pairs).toBe(1)
      expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('listener offline')
      expect(container.querySelector('p.ui-error-text')).toBeNull()
    }
  })

  test('copies pairing codes through the registered command without exposing its URL in the result', async () => {
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
    const context = pluginContext(mobileCall)
    const executed: unknown[][] = []
    const executeCommand = context.executeCommand
    context.executeCommand = async (...args) => {
      executed.push(args)
      return executeCommand(...args)
    }
    await render(<PairingPanel context={context} offer={pairingResult} busy={false} buttonLabel="Generate QR code" onGenerate={async () => {}} />)
    await act(async () => {
      const copy = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Copy pairing code')
      copy!.click()
    })
    expect(executed).toEqual([['command:quirky.mobile/copy-pairing-code', { pairingUrl }, { activateOwner: false }]])
    expect(copied).toEqual([pairingUrl])
    expect(container.querySelector('p.ui-text-muted[role="status"]')?.textContent).toBe('Pairing code copied.')
    expect<unknown>(await context.executeCommand('command:quirky.mobile/copy-pairing-code')).toEqual({ copied: true })
    expect(copied).toEqual([pairingUrl, pairingUrl])
    const newerUrl = 'quirky-mobile://pair/newer-offer-fixture'
    await render(<>
      <PairingPanel key="first" context={context} offer={pairingResult} busy={false} buttonLabel="Generate QR code" onGenerate={async () => {}} />
      <PairingPanel key="second" context={context} offer={{ ...pairingResult, pairingUrl: newerUrl }} busy={false} buttonLabel="Generate QR code" onGenerate={async () => {}} />
    </>)
    expect<unknown>(await context.executeCommand('command:quirky.mobile/copy-pairing-code')).toEqual({ copied: true })
    expect(copied.at(-1)).toBe(newerUrl)
    await render(<PairingPanel key="first" context={context} offer={pairingResult} busy={false} buttonLabel="Generate QR code" onGenerate={async () => {}} />)
    expect<unknown>(await context.executeCommand('command:quirky.mobile/copy-pairing-code')).toEqual({ copied: true })
    expect(copied.at(-1)).toBe(pairingUrl)
    expect<unknown>(await context.executeCommand('command:quirky.mobile/copy-pairing-code', { pairingUrl: newerUrl })).toEqual({ copied: true })
    expect(copied.at(-1)).toBe(newerUrl)
    const beforeUnmount = [...copied]
    await render(<div />)
    await expect(context.executeCommand('command:quirky.mobile/copy-pairing-code')).rejects.toThrow('No pairing code is shown. Generate one on the Mobile page first.')
    expect(copied).toEqual(beforeUnmount)
  })

  test('shows a shared error when clipboard access is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await render(<PairingPanel context={pluginContext(mobileCall)} offer={pairingResult} busy={false} buttonLabel="Generate QR code" onGenerate={async () => {}} />)
    await act(async () => {
      const copy = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Copy pairing code')
      copy!.click()
    })
    expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Copy failed: Clipboard access is unavailable. Select the pairing code below and copy it manually.')
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  test('uses one shared error for unavailable or unrenderable pairing offers', async () => {
    const context = pluginContext(mobileCall)
    await render(<PairingPanel context={context} offer={{ available: false, reason: 'network_exposure_failed', guidance: 'Start the mobile listener first.' }} busy={false} buttonLabel="Generate QR code" onGenerate={async () => {}} />)
    expect(container.querySelectorAll('.ui-inline-error').length).toBe(1)
    expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Start the mobile listener first.')
    await render(<PairingPanel context={context} offer={{ ...pairingResult, qrDataUrl: null, qrError: 'encoding_failed' }} busy={true} buttonLabel="Generate QR code" onGenerate={async () => {}} />)
    expect(container.querySelectorAll('.ui-inline-error').length).toBe(1)
    expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('This pairing code couldn’t be rendered as a QR code. Copy it into Quirky Mobile instead.')
    expect(container.textContent).not.toContain('QR encoding failed')
    expect(container.querySelector('.ui-notice-line')?.textContent).toBe('Generating…')
  })

  test('owns address removal and reports network refresh failures inside the picker', async () => {
    const changes: unknown[] = []
    const selections: string[] = []
    const mobile = {
      configure: async (value: { customAddresses: string[] }) => {
        changes.push(value)
        return { ...mobileState, ...value }
      },
      refreshInterfaces: async () => { throw new Error('interfaces unavailable') },
    }
    await render(<NetworkPicker mobile={mobile} interfaces={mobileState.interfaces} customAddresses={['phone.local']} selectedAddress="phone.local" onAddressChange={(address) => selections.push(address)} />)
    await act(async () => {
      const remove = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Remove selected custom address')
      remove!.click()
    })
    expect(changes).toEqual([{ customAddresses: [] }])
    expect(selections).toEqual(['192.168.1.20'])
    await act(async () => {
      const refresh = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Refresh network interfaces')
      refresh!.click()
    })
    expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('interfaces unavailable')

    await render(<NetworkPicker mobile={mobile} interfaces={[]} customAddresses={[]} selectedAddress="" onAddressChange={(address) => selections.push(address)} />)
    expect(container.querySelector('.ui-empty-state')?.textContent).toContain('No reachable address is available yet.')
  })

  test('closes the enlarged pairing QR dialog by Escape and backdrop', async () => {
    await render(<PairingPanel context={pluginContext(mobileCall)} offer={pairingResult} busy={false} buttonLabel="Generate QR code" onGenerate={async () => {}} />)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Enlarge pairing QR code"]')!.click()
    })
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()

    await act(async () => {
      dialog!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Enlarge pairing QR code"]')!.click()
    })
    const backdrop = container.querySelector('[role="dialog"]')?.parentElement
    await act(async () => { backdrop?.click() })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  test('reports pairing availability without exposing the pending offer or URL', async () => {
    const reports: unknown[] = []
    const calls: string[] = []
    const context = pluginContext((method, params) => {
      calls.push(method)
      return mobileCall(method, params)
    })

    await render(<MobilePage context={context} input={{ stage: 'pair' }} report={(state) => reports.push(state)} />)
    await flushEffects()
    await flushEffects()

    expect(calls.filter((method) => method === 'quirky.mobile/pair')).toHaveLength(1)
    expect(reports.some((report) => {
      if (typeof report !== 'object' || report === null || !('pairingAvailable' in report)) return false
      return report.pairingAvailable === true
    })).toBe(true)
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe(pairingUrl)
    expect(container.querySelector('img[alt="Pairing QR code"]')).not.toBeNull()
  })

  test('generates a settings QR only after the explicit action', async () => {
    const calls: string[] = []
    const context = pluginContext((method, params) => {
      calls.push(method)
      return mobileCall(method, params)
    })

    await render(<MobileSettings context={context} />)
    await flushEffects()
    expect(calls).not.toContain('quirky.mobile/pair')
    expect(container.querySelector('input[readonly]')).toBeNull()
    expect(container.querySelector('img[alt="Pairing QR code"]')).toBeNull()

    await act(async () => {
      const generate = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Generate QR code')
      generate!.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls).toContain('quirky.mobile/pair')
    expect(container.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe(pairingUrl)
    expect(container.querySelector('img[alt="Pairing QR code"]')).not.toBeNull()

  })

  test('keeps a successful revoke distinct from a failed paired-device refresh', async () => {
    let revoked = false
    const context = pluginContext((method) => {
      if (method === 'quirky.mobile/revoke') {
        revoked = true
        return { revoked: true }
      }
      throw new Error(`Unexpected Mobile RPC: ${method}`)
    })

    await render(<DeviceList context={context} devices={[{ deviceId: 'phone-1', name: 'Phone', pairedAt: 1, lastSeenAt: 1 }]} onChanged={async () => { throw new Error('daemon unavailable') }} />)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Revoke device Phone"]')!.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(revoked).toBe(true)
    expect(container.querySelectorAll('.ui-inline-error').length).toBe(1)
    expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Device revoked, but the paired-device list could not refresh: daemon unavailable')
    expect(container.querySelector('[role="status"]')).toBeNull()

    const devices = [{ deviceId: 'phone-1', name: 'Phone', pairedAt: 1, lastSeenAt: 1 }]
    await render(<DeviceList context={context} devices={devices} onChanged={async () => {}} />)
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Revoke device Phone"]')!.click() })
    expect(container.querySelector('.ui-inline-error')).toBeNull()
    expect(container.querySelector('p.ui-text-muted[role="status"]')?.textContent).toBe('Device revoked.')

    const failingContext = pluginContext(() => { throw new Error('revoke unavailable') })
    await render(<DeviceList context={failingContext} devices={devices} onChanged={async () => {}} />)
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Revoke device Phone"]')!.click() })
    expect(container.querySelector('.ui-inline-error__message')?.textContent).toBe('Failed to revoke device: revoke unavailable')
    expect(container.querySelector('[role="status"]')).toBeNull()
    await render(<DeviceList key="no-devices" context={context} devices={[]} onChanged={async () => {}} />)
    expect(container.querySelector('.ui-empty-state')?.textContent).toBe('No devices paired yet.')
  })
})
