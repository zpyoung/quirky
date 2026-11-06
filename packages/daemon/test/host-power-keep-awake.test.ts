import { describe, expect, test } from 'bun:test'
import type { HostPowerState, NativeHostPowerSource } from '../src/host-power-contracts'
import { HostPowerService } from '../src/host-power'

function fakeSource(state: HostPowerState = { onBattery: false, externalDisplay: null }) {
  let nextId = 100
  const live = new Set<number>()
  const created: string[] = []
  const released: number[] = []
  const control = { failCreate: false, state }
  const source: NativeHostPowerSource = {
    start: () => () => {},
    createAssertion(reason) {
      if (control.failCreate) return null
      const id = nextId++
      created.push(reason)
      live.add(id)
      return id
    },
    releaseAssertion(id) {
      released.push(id)
      live.delete(id)
    },
    powerState: () => control.state
  }
  return { source, live, created, released, control }
}

describe('host power keep-awake', () => {
  test('holds one native assertion while any holder is live and releases on the last disposal', () => {
    const fake = fakeSource()
    const service = new HostPowerService(() => {}, fake.source)
    const a = service.forPlugin('acme.a', () => false)
    const b = service.forPlugin('acme.b', () => false)

    const releaseA = a.keepAwake('working')
    const releaseB = b.keepAwake('also working')
    expect(fake.created).toEqual(['working'])
    expect(fake.live.size).toBe(1)

    releaseA()
    expect(fake.live.size).toBe(1)
    releaseB()
    expect(fake.live.size).toBe(0)
    expect(fake.released).toHaveLength(1)
    service.dispose()
  })

  test('a disposer is idempotent and cannot release another holder', () => {
    const fake = fakeSource()
    const service = new HostPowerService(() => {}, fake.source)
    const power = service.forPlugin('acme.a', () => false)

    const first = power.keepAwake('one')
    const second = power.keepAwake('two')
    first()
    first()
    first()
    expect(fake.live.size).toBe(1)
    second()
    second()
    expect(fake.live.size).toBe(0)
    expect(fake.released).toHaveLength(1)
    service.dispose()
  })

  test('re-acquires a fresh assertion after the count returned to zero', () => {
    const fake = fakeSource()
    const service = new HostPowerService(() => {}, fake.source)
    const power = service.forPlugin('acme.a', () => false)

    power.keepAwake('one')()
    power.keepAwake('two')
    expect(fake.created).toEqual(['one', 'two'])
    expect(fake.live.size).toBe(1)
    service.dispose()
    expect(fake.live.size).toBe(0)
  })

  test('revoking a plugin releases its holds but leaves other plugins holding', () => {
    const fake = fakeSource()
    const service = new HostPowerService(() => {}, fake.source)
    const a = service.forPlugin('acme.a', () => false)
    const b = service.forPlugin('acme.b', () => false)
    const releaseA1 = a.keepAwake('a1')
    a.keepAwake('a2')
    b.keepAwake('b1')

    service.revoke('acme.a')
    expect(fake.live.size).toBe(1)
    releaseA1()
    expect(fake.live.size).toBe(1)
    expect(() => a.keepAwake('late')).toThrow(/revoked/)

    service.revoke('acme.b')
    expect(fake.live.size).toBe(0)
    service.dispose()
  })

  test('an external revocation signal releases the activation holds', () => {
    const fake = fakeSource()
    let revoked = false
    const service = new HostPowerService(() => {}, fake.source)
    const power = service.forPlugin('acme.a', () => revoked)
    power.keepAwake('work')
    revoked = true

    expect(() => power.powerState()).toThrow(/revoked/)
    expect(fake.live.size).toBe(0)
    service.dispose()
  })

  test('disposing the service releases the assertion', () => {
    const fake = fakeSource()
    const service = new HostPowerService(() => {}, fake.source)
    service.forPlugin('acme.a', () => false).keepAwake('work')
    service.dispose()
    expect(fake.live.size).toBe(0)
  })

  test('service-level holds are ref-counted with plugin holds and released on revoke', () => {
    const fake = fakeSource()
    const service = new HostPowerService(() => {}, fake.source)
    const release = service.keepAwake('acme.a', 'direct')
    service.forPlugin('acme.b', () => false).keepAwake('plugin')
    expect(fake.live.size).toBe(1)
    release()
    release()
    expect(fake.live.size).toBe(1)
    service.dispose()
    expect(fake.live.size).toBe(0)
  })

  test('a failed native create degrades to a no-op hold and the next hold retries', () => {
    const fake = fakeSource()
    const logs: string[] = []
    const service = new HostPowerService(message => logs.push(message), fake.source)
    const power = service.forPlugin('acme.a', () => false)

    fake.control.failCreate = true
    const release = power.keepAwake('fails')
    expect(fake.live.size).toBe(0)
    expect(logs.length).toBeGreaterThan(0)

    fake.control.failCreate = false
    power.keepAwake('works')
    expect(fake.live.size).toBe(1)
    release()
    expect(fake.live.size).toBe(1)
    service.dispose()
    expect(fake.live.size).toBe(0)
  })

  test('native failures do not escape keepAwake or its disposer', () => {
    const source: NativeHostPowerSource = {
      start: () => () => {},
      createAssertion() { throw new Error('boom') },
      releaseAssertion() { throw new Error('boom') },
      powerState() { throw new Error('boom') }
    }
    const logs: string[] = []
    const service = new HostPowerService(message => logs.push(message), source)
    const power = service.forPlugin('acme.a', () => false)

    expect(() => power.keepAwake('x')()).not.toThrow()
    expect(power.powerState()).toEqual({ onBattery: false, externalDisplay: null })
    expect(logs.length).toBeGreaterThan(0)
    service.dispose()
  })

  test('powerState reflects the native source', () => {
    const fake = fakeSource({ onBattery: true, externalDisplay: false })
    const service = new HostPowerService(() => {}, fake.source)
    const power = service.forPlugin('acme.a', () => false)
    expect(power.powerState()).toEqual({ onBattery: true, externalDisplay: false })
    fake.control.state = { onBattery: false, externalDisplay: true }
    expect(power.powerState()).toEqual({ onBattery: false, externalDisplay: true })
    service.dispose()
  })

  test('unsupported platforms get a no-op keepAwake and the default power state', () => {
    const service = new HostPowerService(() => {}, null)
    const power = service.forPlugin('acme.a', () => false)
    const release = power.keepAwake('nothing to hold')
    expect(() => release()).not.toThrow()
    expect(power.powerState()).toEqual({ onBattery: false, externalDisplay: null })
    service.dispose()
  })

  test('a source without assertion support behaves as unsupported for keep-awake', () => {
    const source: NativeHostPowerSource = { start: () => () => {} }
    const service = new HostPowerService(() => {}, source)
    const power = service.forPlugin('acme.a', () => false)
    expect(() => power.keepAwake('x')()).not.toThrow()
    expect(power.powerState()).toEqual({ onBattery: false, externalDisplay: null })
    service.dispose()
  })

  test('a source that can create but not release assertions never takes one', () => {
    const created: string[] = []
    const source: NativeHostPowerSource = {
      start: () => () => {},
      createAssertion(reason) {
        created.push(reason)
        return 1
      }
    }
    const service = new HostPowerService(() => {}, source)
    const power = service.forPlugin('acme.a', () => false)
    const release = power.keepAwake('x')
    expect(created).toEqual([])
    expect(() => release()).not.toThrow()
    expect(() => service.keepAwake('acme.b', 'y')()).not.toThrow()
    expect(created).toEqual([])
    service.dispose()
  })
})
