import { describe, expect, test } from 'bun:test'
import type { HostPowerTransition, NativeHostPowerSource } from '../src/host-power-contracts'
import { HostPowerService } from '../src/host-power'

function controlledSource() {
  let deliver: ((transition: HostPowerTransition) => void) | null = null
  let disposeCount = 0
  const source: NativeHostPowerSource = {
    start(listener) {
      deliver = listener
      return () => { disposeCount++ }
    }
  }
  return {
    source,
    emit(transition: HostPowerTransition, afterDelivery?: () => void) {
      if (!deliver) throw new Error('source has not started')
      deliver(transition)
      afterDelivery?.()
    },
    get disposeCount() { return disposeCount }
  }
}

describe('host power lifecycle', () => {
  test('suspends every consumer synchronously before the native source can acknowledge', () => {
    const source = controlledSource()
    const service = new HostPowerService(() => {}, source.source)
    const power = service.forPlugin('acme.runner', () => false)
    expect(power.supported).toBe(true)
    const order: string[] = []
    power.subscribe({
      suspend() { order.push('fence-one') },
      resume() {}
    })
    power.subscribe({
      suspend() { order.push('fence-two') },
      resume() {}
    })

    source.emit('suspend', () => order.push('native-ack'))

    expect(order).toEqual(['fence-one', 'fence-two', 'native-ack'])
    expect(power.suspended).toBe(true)
    service.dispose()
  })

  test('ignores duplicate transitions and replays suspension to late subscribers before return', () => {
    const source = controlledSource()
    const service = new HostPowerService(() => {}, source.source)
    const power = service.forPlugin('acme.runner', () => false)
    const order: string[] = []
    power.subscribe({
      suspend() { order.push('first-suspend') },
      resume() { order.push('first-resume') }
    })

    source.emit('suspend')
    source.emit('suspend')
    order.push('before-late-subscribe')
    const disposeLate = power.subscribe({
      suspend() { order.push('late-suspend') },
      resume() { order.push('late-resume') }
    })
    order.push('after-late-subscribe')
    source.emit('resume')
    source.emit('resume')

    expect(order).toEqual([
      'first-suspend',
      'before-late-subscribe',
      'late-suspend',
      'after-late-subscribe',
      'first-resume',
      'late-resume'
    ])
    expect(power.suspended).toBe(false)
    disposeLate()
    service.dispose()
  })

  test('revoking a plugin removes all activation callbacks and rejects stale capabilities', () => {
    const source = controlledSource()
    const service = new HostPowerService(() => {}, source.source)
    const first = service.forPlugin('acme.runner', () => false)
    const second = service.forPlugin('acme.runner', () => false)
    let externallyRevoked = false
    const externalPower = service.forPlugin('acme.external', () => externallyRevoked)
    let externalCalls = 0
    externalPower.subscribe({ suspend() { externalCalls++ }, resume() {} })
    let calls = 0
    const disposeFirst = first.subscribe({ suspend() { calls++ }, resume() {} })
    second.subscribe({ suspend() { calls++ }, resume() {} })

    service.revoke('acme.runner')
    externallyRevoked = true
    source.emit('suspend')

    expect(calls).toBe(0)
    expect(externalCalls).toBe(0)
    expect(() => externalPower.suspended).toThrow(/revoked/i)
    expect(() => first.supported).toThrow(/revoked/i)
    expect(() => second.suspended).toThrow(/revoked/i)
    expect(() => first.subscribe({ suspend() {}, resume() {} })).toThrow(/revoked/i)
    disposeFirst()
    service.dispose()
  })

  test('dispose is idempotent, stops delivery, and releases the trusted source once', () => {
    const source = controlledSource()
    const service = new HostPowerService(() => {}, source.source)
    const power = service.forPlugin('acme.runner', () => false)
    let calls = 0
    power.subscribe({ suspend() { calls++ }, resume() {} })

    service.dispose()
    service.dispose()
    source.emit('suspend')

    expect(source.disposeCount).toBe(1)
    expect(calls).toBe(0)
    expect(() => power.suspended).toThrow(/disposed/i)
  })

  test('continues after a listener throws and logs the failed fence without claiming success', () => {
    const source = controlledSource()
    const logs: string[] = []
    const service = new HostPowerService(message => logs.push(message), source.source)
    const power = service.forPlugin('acme.runner', () => false)
    const order: string[] = []
    power.subscribe({
      suspend() { throw new Error('fence exploded') },
      resume() {}
    })
    power.subscribe({
      suspend() { order.push('remaining-fence') },
      resume() {}
    })

    source.emit('suspend', () => order.push('native-ack'))

    expect(order).toEqual(['remaining-fence', 'native-ack'])
    expect(logs.some(message => message.includes('acme.runner') && message.includes('suspend') && message.includes('fence exploded'))).toBe(true)
    service.dispose()
  })

  test('detects asynchronous listener results and handles their rejection outside the sync boundary', async () => {
    const source = controlledSource()
    const logs: string[] = []
    const rejectionLogged = Promise.withResolvers<void>()
    const service = new HostPowerService(message => {
      logs.push(message)
      if (message.includes('late rejection')) rejectionLogged.resolve()
    }, source.source)
    const power = service.forPlugin('acme.runner', () => false)
    const order: string[] = []
    power.subscribe({
      suspend() { return Promise.reject(new Error('late rejection')) as never },
      resume() {}
    })
    power.subscribe({
      suspend() { order.push('synchronous-fence') },
      resume() {}
    })

    source.emit('suspend', () => order.push('native-ack'))
    await rejectionLogged.promise

    expect(order).toEqual(['synchronous-fence', 'native-ack'])
    expect(logs.some(message => message.includes('late rejection'))).toBe(true)
    service.dispose()
  })

  test('reports support only when a trusted native source exists', () => {
    const service = new HostPowerService(() => {}, null)
    const power = service.forPlugin('acme.runner', () => false)

    expect(power.supported).toBe(false)
    expect(power.suspended).toBe(false)
    service.dispose()
  })
})
