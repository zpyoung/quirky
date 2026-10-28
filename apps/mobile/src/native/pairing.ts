import { decodeBase64Url, decodeBase64 } from '@quirky/protocol/paired-client'

const OFFER_KEYS = ['v', 'endpoint', 'deviceToken', 'publicKeyB64', 'pairedDeviceId', 'scope'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN = /^[0-9a-f]{48}$/
const STANDARD_KEY = /^[A-Za-z0-9+/]{43}=$/
const MAX_INPUT_LENGTH = 16 * 1024

export type MobilePairOffer = {
  v: 2
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  pairedDeviceId: string
  scope: 'mobile'
}
export type MobileOfferPreview = { endpoint: string; pairedDeviceId: string; desktopAddress: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function extractCode(input: string): string {
  const value = input.trim()
  if (value.length === 0 || value.length > MAX_INPUT_LENGTH) throw new Error('Pairing code is empty or too large')
  if (value.startsWith('quirky://')) {
    let url: URL
    try { url = new URL(value) } catch { throw new Error('Invalid Quirky pairing link') }
    const keys = [...url.searchParams.keys()]
    const codes = url.searchParams.getAll('code')
    if (url.protocol !== 'quirky:' || url.hostname !== 'pair' || url.pathname !== '' || url.username || url.password || url.hash || keys.length !== 1 || codes.length !== 1 || !codes[0]) throw new Error('Invalid Quirky pairing link')
    return codes[0]
  }
  if (value.includes('://') || value.includes('?') || value.includes('#')) throw new Error('Paste a pairing code or a quirky://pair link')
  return value
}

function normalizeEndpoint(value: string): string {
  if (value.length > 2048) throw new Error('Desktop address is invalid')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Desktop address is invalid') }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || !url.hostname || url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) throw new Error('Pairing requires a direct ws:// or wss:// endpoint')
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error('Desktop port is invalid')
  return url.origin
}

function decodeOffer(input: string): MobilePairOffer {
  const code = extractCode(input)
  const bytes = decodeBase64Url(code, 4096)
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown } catch { throw new Error('Pairing code is malformed') }
  if (!isRecord(value) || !exactKeys(value, OFFER_KEYS) || value.v !== 2 || value.scope !== 'mobile') throw new Error('Pairing code is not a supported mobile v2 offer')
  if (typeof value.endpoint !== 'string' || typeof value.deviceToken !== 'string' || !TOKEN.test(value.deviceToken) ||
    typeof value.publicKeyB64 !== 'string' || !STANDARD_KEY.test(value.publicKeyB64) || typeof value.pairedDeviceId !== 'string' || !UUID.test(value.pairedDeviceId)) {
    throw new Error('Pairing offer fields are invalid')
  }
  try { decodeBase64(value.publicKeyB64, 32) } catch { throw new Error('Pairing public key is invalid') }
  return {
    v: 2,
    endpoint: normalizeEndpoint(value.endpoint),
    deviceToken: value.deviceToken,
    publicKeyB64: value.publicKeyB64,
    pairedDeviceId: value.pairedDeviceId,
    scope: 'mobile'
  }
}

export function previewMobileOffer(input: string): MobileOfferPreview {
  const offer = decodeOffer(input)
  return { endpoint: offer.endpoint, pairedDeviceId: offer.pairedDeviceId, desktopAddress: new URL(offer.endpoint).host }
}

export function parseMobileOffer(input: string): MobilePairOffer {
  return decodeOffer(input)
}

export function normalizeEditedEndpoint(input: string, currentEndpoint: string): string {
  const current = new URL(normalizeEndpoint(currentEndpoint))
  const raw = input.trim()
  if (raw.length === 0 || raw.length > 2048) throw new Error('Desktop address is invalid')
  const candidate = raw.includes('://') ? raw : `${current.protocol}//${raw}`
  let next: URL
  try { next = new URL(candidate) } catch { throw new Error('Desktop address is invalid') }
  if (next.protocol !== 'ws:' && next.protocol !== 'wss:') throw new Error('Desktop address must use ws:// or wss://')
  if (!next.hostname || next.username || next.password || next.search || next.hash || (next.pathname !== '' && next.pathname !== '/')) throw new Error('Desktop address must be a host and optional port')
  if (!next.port) next.port = current.port
  return normalizeEndpoint(next.origin)
}
