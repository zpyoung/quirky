import { describe, expect, test } from 'bun:test'
import type { NetworkInterfaceInfo } from 'node:os'
import { normalizeAdvertisedEndpoint, rankNetworkInterfaces } from '../src/daemon/network'

describe('mobile network selection', () => {
  test('ranks Tailscale before IPv4 and IPv6 and filters loopback, link-local, and fake proxy ranges', () => {
    const interfaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00', netmask: '255.0.0.0', cidr: '127.0.0.1/8' }],
      en0: [
        { address: '192.168.1.5', family: 'IPv4', internal: false, mac: 'a', netmask: '255.255.255.0', cidr: '192.168.1.5/24' },
        { address: '198.18.0.7', family: 'IPv4', internal: false, mac: 'b', netmask: '255.255.0.0', cidr: '198.18.0.7/15' },
        { address: 'fe80::5', family: 'IPv6', internal: false, mac: 'c', netmask: 'ffff:ffff:ffff:ffff::', cidr: 'fe80::5/64', scopeid: 4 }
      ],
      tailscale0: [{ address: '100.75.2.9', family: 'IPv4', internal: false, mac: 'd', netmask: '255.192.0.0', cidr: '100.75.2.9/10' }],
      utun5: [{ address: '2001:db8::1', family: 'IPv6', internal: false, mac: 'e', netmask: 'ffff:ffff:ffff:ffff::', cidr: '2001:db8::1/64', scopeid: 0 }],
      bridge0: [{ address: '172.20.0.1', family: 'IPv4', internal: false, mac: 'f', netmask: '255.255.0.0', cidr: '172.20.0.1/16' }]
    } satisfies Record<string, NetworkInterfaceInfo[]>
    expect(rankNetworkInterfaces(interfaces).map((item) => item.address)).toEqual(['100.75.2.9', '192.168.1.5', '2001:db8::1', '172.20.0.1'])
  })

  test('normalizes host, explicit host:port, bracketed IPv6, and HTTP/WS URLs', () => {
    expect(normalizeAdvertisedEndpoint('192.168.1.8', 6768)).toBe('ws://192.168.1.8:6768')
    expect(normalizeAdvertisedEndpoint('box.local:7000', 6768)).toBe('ws://box.local:7000')
    expect(normalizeAdvertisedEndpoint('[2001:db8::2]:6769', 6768)).toBe('ws://[2001:db8::2]:6769')
    expect(normalizeAdvertisedEndpoint('https://box.local/pair', 6768)).toBe('wss://box.local/pair')
    expect(normalizeAdvertisedEndpoint('ws://box.local:6769/rpc', 6768)).toBe('ws://box.local:6769/rpc')
  })

  test('rejects wildcard, zero or invalid ports, credentials, and malformed URLs', () => {
    for (const value of ['0.0.0.0', '::', '[::]:0', 'box.local:0', 'box.local:65536', 'ws://user:pass@box.local', 'user@box.local', 'box.local/path', 'box.local?token=x', 'http://', 'https://0.0.0.0:6768']) {
      expect(normalizeAdvertisedEndpoint(value, 6768)).toBeNull()
    }
  })
})
