import { describe, expect, test } from 'bun:test'
import { describeDirectPath } from '../src/native/network'

describe('direct host path description', () => {
  test('recognizes Tailscale DNS names and the complete 100.64.0.0/10 address range', () => {
    expect(describeDirectPath('wss://desk.tailnet.ts.net:6768')).toBe('Direct · Tailscale')
    expect(describeDirectPath('ws://100.64.0.1:6768')).toBe('Direct · Tailscale')
    expect(describeDirectPath('ws://100.127.255.255:6768')).toBe('Direct · Tailscale')
  })

  test('does not mislabel neighboring shared-address space or arbitrary 100.x addresses', () => {
    expect(describeDirectPath('ws://100.63.255.255:6768')).toBe('Direct · LAN or configured address')
    expect(describeDirectPath('ws://100.128.0.0:6768')).toBe('Direct · LAN or configured address')
    expect(describeDirectPath('ws://192.168.1.2:6768')).toBe('Direct · LAN or configured address')
    expect(describeDirectPath('not-an-endpoint')).toBe('Direct endpoint')
  })
})
