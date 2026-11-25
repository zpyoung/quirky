import { describe, expect, it } from 'vitest'
import {
  deriveBrowserRoutePartition,
  deriveBrowserRoutePartitionStorageScope,
  isBrowserRoutePartition
} from './browser-route-identity'

const identity = {
  quirkyProfileId: 'quirky/profile:alpha',
  browserProfileId: 'browser/profile:default',
  authorityConnectionIdentity: 'paired/runtime:authority',
  executionHostIdentity: 'ssh/target:private.example'
}

/** Shipping-shaped inputs whose derived names are frozen: both are persisted on disk. */
const pinnedIdentity = {
  quirkyProfileId: 'quirky/profile:alpha',
  browserProfileId: 'browser/profile:default',
  authorityConnectionIdentity: 'paired-runtime:authority-a',
  executionHostIdentity: '["quirky-browser-execution-host-storage",1,"authority","env-a"]'
}

describe('browser route partition identity', () => {
  it('derives a stable opaque cross-platform partition and binding fingerprint', () => {
    const first = deriveBrowserRoutePartition(identity)
    const second = deriveBrowserRoutePartition({ ...identity })

    expect(second).toEqual(first)
    expect(first.partition).toMatch(/^persist:quirky-browser-v1-[a-f0-9]{64}$/)
    expect(first.bindingFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(first.partition.slice('persist:'.length)).toMatch(/^[a-z0-9-]+$/)
    for (const rawIdentity of Object.values(identity)) {
      expect(first.partition).not.toContain(rawIdentity)
    }
    expect(first.partition).not.toContain('private.example')
  })

  it('keeps delimiter-containing components structurally distinct', () => {
    const left = deriveBrowserRoutePartition({
      ...identity,
      quirkyProfileId: 'a',
      browserProfileId: 'b:c'
    })
    const right = deriveBrowserRoutePartition({
      ...identity,
      quirkyProfileId: 'a:b',
      browserProfileId: 'c'
    })

    expect(left).not.toEqual(right)
  })

  it('does not expose equality of individual identity components', () => {
    const baseline = deriveBrowserRoutePartition(identity).partition
    const sameProfile = deriveBrowserRoutePartition({
      ...identity,
      executionHostIdentity: 'ssh/target:other.example'
    }).partition

    expect(baseline.split('-').at(-1)).not.toBe(sameProfile.split('-').at(-1))
    expect(baseline).not.toMatch(/:[a-f0-9]{16}:/)
  })

  // Why: a component dropped from the hash silently merges two jars -- another browser
  // profile's or another paired server's cookies answer to this identity.
  it('makes every identity component load-bearing', () => {
    const derived = [
      identity,
      { ...identity, quirkyProfileId: 'quirky/profile:beta' },
      { ...identity, browserProfileId: 'browser/profile:work' },
      { ...identity, authorityConnectionIdentity: 'paired/runtime:other' },
      { ...identity, executionHostIdentity: 'ssh/target:other.example' }
    ].map((entry) => deriveBrowserRoutePartition(entry))

    expect(new Set(derived.map((entry) => entry.partition)).size).toBe(derived.length)
    expect(new Set(derived.map((entry) => entry.bindingFingerprint)).size).toBe(derived.length)
  })

  // Why: both names are persisted, so a changed hash input, order, tag, or version relocates
  // every existing user's cookie jar instead of failing.
  it('pins the derived partition and fingerprint against silent relocation', () => {
    expect(deriveBrowserRoutePartition(pinnedIdentity)).toEqual({
      partition:
        'persist:quirky-browser-v1-26f876431e59545a98b647c2dcf864d8ca3bb7cdfd34be0e0912fdc0d8b59574',
      bindingFingerprint: '533bf3372267eec75ed35d4ba83c5b9048643a4032aa399b82da457c09a9db2c'
    })
  })

  it('keeps the partition name and the binding fingerprint in separate digest domains', () => {
    const derived = deriveBrowserRoutePartition(identity)

    expect(derived.partition).not.toContain(derived.bindingFingerprint)
  })

  // Why: removal deletes every partition carrying the scope, so a scope missing either
  // component wipes storage the removed record never owned.
  it('scopes partition ownership to one quirky profile and one environment', () => {
    const scope = deriveBrowserRoutePartitionStorageScope({
      quirkyProfileId: 'quirky/profile:alpha',
      environmentId: 'environment-a'
    })

    expect(scope).toBe('91fa6750d685a2582cd78b2912cde48895d45fb308e76074848fe48834571996')
    expect(
      deriveBrowserRoutePartitionStorageScope({
        quirkyProfileId: 'quirky/profile:alpha',
        environmentId: 'environment-b'
      })
    ).not.toBe(scope)
    expect(
      deriveBrowserRoutePartitionStorageScope({
        quirkyProfileId: 'quirky/profile:beta',
        environmentId: 'environment-a'
      })
    ).not.toBe(scope)
  })

  // Why: an accepted name is joined onto the partition data root and that directory removed.
  it('recognizes a route partition only as a whole name', () => {
    const valid = deriveBrowserRoutePartition(pinnedIdentity).partition

    expect(isBrowserRoutePartition(valid)).toBe(true)
    for (const value of [
      `../../${valid}`,
      `${valid}/../../escape`,
      `${valid}extra`,
      valid.replace('persist:', '')
    ]) {
      expect(isBrowserRoutePartition(value)).toBe(false)
    }
  })

  it('rejects empty and unbounded identity components', () => {
    expect(() => deriveBrowserRoutePartition({ ...identity, executionHostIdentity: '' })).toThrow(
      'browser_route_partition_identity_invalid'
    )
    expect(() =>
      deriveBrowserRoutePartition({ ...identity, authorityConnectionIdentity: 'x'.repeat(513) })
    ).toThrow('browser_route_partition_identity_invalid')
    expect(() =>
      deriveBrowserRoutePartition({ ...identity, authorityConnectionIdentity: 'é'.repeat(257) })
    ).toThrow('browser_route_partition_identity_invalid')
    expect(() =>
      deriveBrowserRoutePartition({ ...identity, authorityConnectionIdentity: 'é'.repeat(256) })
    ).not.toThrow()
  })
})
