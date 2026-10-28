import type { MobileState, PluginContext } from '@quirky/protocol'

type RpcResponse = { id?: number; result?: unknown; error?: { code: number; message: string } }
type PendingCall = { resolve(value: unknown): void; reject(error: Error): void }
type AdmittedMobileClient = { readonly id: number; receive(text: string): Promise<void>; disconnect(): void }
type Phone = {
  client: AdmittedMobileClient
  pending: Map<number, PendingCall>
  closed: boolean
  closeTransport(): void
}

const DEVICES = {
  'phone-a': { deviceId: 'device-a', name: 'Phone A' },
  'phone-a-reconnect': { deviceId: 'device-a', name: 'Phone A' },
  'phone-b': { deviceId: 'device-b', name: 'Phone B' }
} as const

let context: PluginContext
let nextRequestId = 1
let autoRestoreFitMs: number | null = null
const phones = new Map<string, Phone>()

function state(): MobileState {
  return {
    machineName: 'Test desktop',
    showMobileButton: true,
    onboardingSeen: true,
    autoRestoreFitMs,
    customAddresses: [],
    interfaces: [],
    devices: [],
    listener: { available: true, host: '127.0.0.1', port: 0 },
    relay: 'unavailable'
  }
}

function phoneFor(slot: unknown): Phone {
  if (typeof slot !== 'string') throw context.error('invalid-params', 'slot is required')
  const phone = phones.get(slot)
  if (!phone || phone.closed) throw context.error('not-found', `no connected test phone ${slot}`)
  return phone
}

function admit(params: Record<string, unknown>): { connected: true } {
  const slot = params.slot
  if (typeof slot !== 'string' || !Object.hasOwn(DEVICES, slot)) throw context.error('invalid-params', 'unknown test phone slot')
  const identity = DEVICES[slot as keyof typeof DEVICES]
  let phone: Phone
  const closeTransport = () => {
    phone.closed = true
  }
  const client = context.clients.accept({
    role: 'mobile',
    deviceId: identity.deviceId,
    name: identity.name,
    authorize(method) {
      if (method.startsWith('quirky.terminal/')) return
      throw context.error('invalid-params', `test mobile method is forbidden: ${method}`)
    },
    sendText(text) {
      const response = JSON.parse(text) as RpcResponse
      if (response.id === undefined) return
      const pending = phone.pending.get(response.id)
      if (!pending) return
      phone.pending.delete(response.id)
      if (response.error) pending.reject(context.error('conflict', response.error.message))
      else pending.resolve(response.result)
    },
    sendBinary() {},
    close: closeTransport
  })
  phone = { client, pending: new Map(), closed: false, closeTransport }
  phones.set(slot, phone)
  return { connected: true }
}

async function callAsPhone(params: Record<string, unknown>): Promise<unknown> {
  const phone = phoneFor(params.slot)
  if (typeof params.method !== 'string' || !params.method.startsWith('quirky.terminal/')) {
    throw context.error('invalid-params', 'a terminal method is required')
  }
  const requestId = nextRequestId++
  const callParams = params.params && typeof params.params === 'object' ? params.params : {}
  const response = Promise.withResolvers<unknown>()
  phone.pending.set(requestId, { resolve: response.resolve, reject: response.reject })
  try {
    await phone.client.receive(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: params.method, params: callParams }))
  } catch (error) {
    phone.pending.delete(requestId)
    response.reject(error instanceof Error ? error : new Error(String(error)))
  }
  return response.promise
}

function disconnect(params: Record<string, unknown>): { ok: true } {
  const phone = phoneFor(params.slot)
  phone.closed = true
  phone.client.disconnect()
  phones.delete(params.slot as string)
  return { ok: true }
}
function revoke(params: Record<string, unknown>): { ok: true } {
  const phone = phoneFor(params.slot)
  phone.closeTransport()
  phone.client.disconnect()
  phones.delete(params.slot as string)
  return { ok: true }
}

export function activate(pluginContext: PluginContext): void {
  context = pluginContext
  nextRequestId = 1
  autoRestoreFitMs = null
  phones.clear()
  context.provide('method:quirky.mobile/state', () => state())
  context.provide('method:quirky.mobile/configure', (params) => {
    if (typeof params.autoRestoreFitMs === 'number' || params.autoRestoreFitMs === null) autoRestoreFitMs = params.autoRestoreFitMs as number | null
    return state()
  })
  context.provide('method:quirky.mobile/testAdmit', admit)
  context.provide('method:quirky.mobile/testCall', callAsPhone)
  context.provide('method:quirky.mobile/testDisconnect', disconnect)
  context.provide('method:quirky.mobile/testRevoke', revoke)
}

export function deactivate(): void {
  for (const phone of phones.values()) phone.client.disconnect()
  phones.clear()
  autoRestoreFitMs = null
  nextRequestId = 1
}
