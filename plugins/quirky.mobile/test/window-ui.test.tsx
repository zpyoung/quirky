import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MobilePairingResult, MobileState, UiPluginContext } from '@quirky/protocol'
import { DeviceList } from '../src/window/DeviceList'
import { MobilePage } from '../src/window/MobilePage'
import { MobileSettings } from '../src/window/MobileSettings'
import { PairingPanel } from '../src/window/PairingPanel'

let root: Root | null = null
let container: HTMLDivElement

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
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
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
  return {
    pluginId: 'quirky.mobile',
    nativeBrowser: {} as UiPluginContext['nativeBrowser'],
    call: async (method: string, params?: Record<string, unknown>) => call(method, params ?? {}),
    subscribe: () => () => {},
    openView: () => {},
    onLayout: () => () => {},
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    toast: () => {},
  } as unknown as UiPluginContext
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
  test('closes the enlarged pairing QR dialog by Escape and backdrop', async () => {
    await render(<PairingPanel offer={pairingResult} busy={false} error={null} buttonLabel="Generate QR code" onGenerate={async () => {}} />)
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

    expect(calls).toContain('quirky.mobile/pair')
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
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })
})
