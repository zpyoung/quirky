import { describe, expect, it } from 'vitest'
import {
  bindHostIsNetworkExposed,
  describeQuirkydBindExposure,
  QUIRKYD_LOOPBACK_BIND_HOST,
  QuirkydBindAddressError,
  resolveQuirkydBindHost
} from './quirkyd-bind-address'

describe('resolveQuirkydBindHost', () => {
  it('defaults to loopback when the operator asked for nothing', () => {
    expect(resolveQuirkydBindHost()).toBe(QUIRKYD_LOOPBACK_BIND_HOST)
    expect(QUIRKYD_LOOPBACK_BIND_HOST).toBe('127.0.0.1')
  })

  it('accepts literal IPv4 and IPv6 addresses, including explicit wide binds', () => {
    expect(resolveQuirkydBindHost('0.0.0.0')).toBe('0.0.0.0')
    expect(resolveQuirkydBindHost('10.1.2.3')).toBe('10.1.2.3')
    expect(resolveQuirkydBindHost('::1')).toBe('::1')
    expect(resolveQuirkydBindHost('localhost')).toBe('127.0.0.1')
    expect(resolveQuirkydBindHost(' 127.0.0.1 ')).toBe('127.0.0.1')
  })

  it('refuses hostnames, because DNS would decide which interface got bound', () => {
    expect(() => resolveQuirkydBindHost('internal.example')).toThrow(QuirkydBindAddressError)
    expect(() => resolveQuirkydBindHost('')).toThrow(QuirkydBindAddressError)
    expect(() => resolveQuirkydBindHost('0.0.0.0:80')).toThrow(QuirkydBindAddressError)
  })
})

describe('bindHostIsNetworkExposed', () => {
  it('separates local-only addresses from network-reachable ones', () => {
    expect(bindHostIsNetworkExposed('127.0.0.1')).toBe(false)
    expect(bindHostIsNetworkExposed('127.5.5.5')).toBe(false)
    expect(bindHostIsNetworkExposed('::1')).toBe(false)
    expect(bindHostIsNetworkExposed('0.0.0.0')).toBe(true)
    expect(bindHostIsNetworkExposed('::')).toBe(true)
    expect(bindHostIsNetworkExposed('10.1.2.3')).toBe(true)
  })

  it('says out loud when a deployment is reachable from the network', () => {
    expect(describeQuirkydBindExposure('0.0.0.0')).toContain('reachable from the network')
    expect(describeQuirkydBindExposure('127.0.0.1')).toContain('local only')
  })
})
