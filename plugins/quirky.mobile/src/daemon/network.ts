import { isIP } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { MobileNetworkInterface } from '@quirky/protocol'

export type NetworkInterfaceMap = Record<string, readonly NetworkInterfaceInfo[] | undefined>

const VIRTUAL_BRIDGE_PATTERN = /^(?:docker|br-|virbr|vmnet|vboxnet|veth|lxcbr|cni|flannel|cali|bridge)|VMware Network Adapter|VirtualBox Host-Only/i
const HYPER_V_PATTERN = /^vEthernet /i
const HOST_LOCAL_HYPER_V_PATTERN = /^vEthernet \((?:Default Switch|WSL(?: \(Hyper-V firewall\))?)\)$/i

export function isVirtualBridgeInterface(name: string, hasDefaultRoute?: boolean): boolean {
  if (HOST_LOCAL_HYPER_V_PATTERN.test(name)) return true
  if (HYPER_V_PATTERN.test(name)) return hasDefaultRoute !== true
  return VIRTUAL_BRIDGE_PATTERN.test(name)
}

function isTailnetIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
}

function isProxyFakeIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  return parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)
}

function isIPv4LinkLocal(address: string): boolean {
  return address.startsWith('169.254.')
}

function isIPv6LinkLocal(address: string): boolean {
  return /^fe[89ab][0-9a-f]:/i.test(address)
}

function isLoopbackAddress(address: string): boolean {
  const version = isIP(address)
  return version === 4 ? address.startsWith('127.') : version === 6 && address.toLowerCase() === '::1'
}

function rankInterface(item: MobileNetworkInterface): number {
  if (item.kind === 'tailscale') return 0
  const familyRank = item.family === 'IPv4' ? 1 : 2
  return familyRank + (item.kind === 'virtual' ? 2 : 0)
}

export function rankNetworkInterfaces(interfaces: NetworkInterfaceMap = networkInterfaces()): MobileNetworkInterface[] {
  const result: MobileNetworkInterface[] = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const info of addresses ?? []) {
      const family = info.family
      if (info.internal || isLoopbackAddress(info.address) || isProxyFakeIPv4(info.address)) continue
      if (family === 'IPv4') {
        if (isIPv4LinkLocal(info.address) || isIP(info.address) !== 4) continue
      } else if (family === 'IPv6') {
        if (isIPv6LinkLocal(info.address) || isIP(info.address) !== 6) continue
      } else {
        continue
      }
      const kind = isTailnetIPv4(info.address) ? 'tailscale' : isVirtualBridgeInterface(name) ? 'virtual' : 'lan'
      result.push({ name, address: info.address, family, kind })
    }
  }
  return result.sort((left, right) => rankInterface(left) - rankInterface(right))
}

export function bestNetworkAddress(interfaces: readonly MobileNetworkInterface[]): string | null {
  return interfaces.find((item) => item.kind !== 'virtual')?.address ?? null
}

function bracketIPv6(hostname: string): string {
  const unbracketed = hostname.replace(/^\[|\]$/g, '')
  return unbracketed.includes(':') ? `[${unbracketed}]` : unbracketed
}

function unbracketIPv6(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '')
}

function wildcardHost(hostname: string): boolean {
  const normalized = unbracketIPv6(hostname).toLowerCase()
  return normalized === '*' || normalized === '0.0.0.0' || normalized === '::' || normalized === '::ffff:0:0'
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) return true
  }
  return false
}

function normalizeUrl(value: string): string | null {
  if (value.length > 16_384 || containsControlCharacter(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol === 'http:') url.protocol = 'ws:'
    else if (url.protocol === 'https:') url.protocol = 'wss:'
    if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || !url.hostname || url.username || url.password || url.hash || url.port === '0' || wildcardHost(url.hostname)) return null
    const endpoint = url.toString()
    return url.pathname === '/' && !url.search ? endpoint.replace(/\/$/, '') : endpoint
  } catch {
    return null
  }
}

function parseHostOverride(value: string): { hostname: string; port?: number } | null {
  try {
    const rawIpVersion = isIP(value)
    let hostnameInput = value
    let port: number | undefined
    if (value.startsWith('[')) {
      const match = value.match(/^\[([^\]]+)\](?::(\d+))?$/)
      if (!match || isIP(match[1]!) !== 6) return null
      hostnameInput = match[1]!
      if (match[2] !== undefined) port = Number(match[2])
    } else if (rawIpVersion === 6) {
      hostnameInput = value
    } else {
      const match = value.match(/^([^:]+)(?::(\d+))?$/)
      if (!match) return null
      hostnameInput = match[1]!
      if (match[2] !== undefined) port = Number(match[2])
    }
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null
    const url = new URL(`ws://${bracketIPv6(hostnameInput)}`)
    if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash || wildcardHost(url.hostname)) return null
    const host = unbracketIPv6(url.hostname)
    return { hostname: host, ...(port === undefined ? {} : { port }) }
  } catch {
    return null
  }
}

export function normalizeAdvertisedEndpoint(address: string | null | undefined, boundPort: number): string | null {
  if (!Number.isInteger(boundPort) || boundPort < 1 || boundPort > 65535) return null
  const override = address?.trim()
  if (!override) return `ws://127.0.0.1:${boundPort}`
  if (override.length > 16_384 || containsControlCharacter(override)) return null
  if (override.includes('://')) return normalizeUrl(override)
  const parsed = parseHostOverride(override)
  if (!parsed) return null
  const port = parsed.port ?? boundPort
  const host = bracketIPv6(parsed.hostname)
  return `ws://${host}:${port}`
}

export function endpointHost(endpoint: string): string | null {
  try {
    return unbracketIPv6(new URL(endpoint).hostname).toLowerCase()
  } catch {
    return null
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = unbracketIPv6(hostname).toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const version = isIP(host)
  return version === 4 ? host.startsWith('127.') : version === 6 && host === '::1'
}

export function candidatePorts(preferredPort: number, fallbackPort?: number, pinned = false): number[] {
  if (!Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535) throw new Error('Invalid mobile port')
  if (preferredPort === 0 || pinned) return [preferredPort]
  const candidates: number[] = []
  if (fallbackPort !== undefined && Number.isInteger(fallbackPort) && fallbackPort > 0 && fallbackPort <= 65535) candidates.push(fallbackPort)
  if (!candidates.includes(preferredPort)) candidates.push(preferredPort)
  for (let offset = 1; offset <= 31; offset++) {
    const port = preferredPort + offset
    if (port > 65535) break
    if (!candidates.includes(port)) candidates.push(port)
  }
  candidates.push(0)
  return candidates
}
