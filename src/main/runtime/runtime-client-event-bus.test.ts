import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import { RuntimeClientEventBus } from './runtime-client-event-bus'

const BATCH_EVENT: RuntimeClientEvent = {
  type: 'terminalSideEffects',
  batch: { ptyId: 'pty-1', seq: 1, facts: [{ kind: 'bell' }] }
}

function createBus() {
  const onConsumerAvailabilityChanged = vi.fn()
  const bus = new RuntimeClientEventBus({
    makeTitleGateKey: (raw, normalized) => `${raw}|${normalized}`,
    onConsumerAvailabilityChanged
  })
  return { bus, onConsumerAvailabilityChanged }
}

describe('RuntimeClientEventBus terminal side-effect delivery', () => {
  it('delivers batches to consumers and observers but not to plain opted-out listeners', () => {
    const { bus } = createBus()
    const consumer: RuntimeClientEvent[] = []
    const observer: RuntimeClientEvent[] = []
    const optedOut: RuntimeClientEvent[] = []
    bus.on((event) => consumer.push(event))
    bus.on((event) => observer.push(event), {
      consumesTerminalSideEffects: false,
      observesTerminalSideEffects: true
    })
    bus.on((event) => optedOut.push(event), { consumesTerminalSideEffects: false })

    bus.emit(BATCH_EVENT)
    bus.emit({ type: 'workspaceViewChanged' })

    expect(consumer.map((event) => event.type)).toEqual([
      'terminalSideEffects',
      'workspaceViewChanged'
    ])
    expect(observer.map((event) => event.type)).toEqual([
      'terminalSideEffects',
      'workspaceViewChanged'
    ])
    expect(optedOut.map((event) => event.type)).toEqual(['workspaceViewChanged'])
  })

  it('never counts an observer as a consumer, so it cannot start the scanners', () => {
    const { bus, onConsumerAvailabilityChanged } = createBus()

    const stopObserver = bus.on(() => {}, {
      consumesTerminalSideEffects: false,
      observesTerminalSideEffects: true
    })
    expect(bus.countTerminalSideEffectConsumers()).toBe(0)
    expect(onConsumerAvailabilityChanged).toHaveBeenCalledTimes(1)

    const stopConsumer = bus.on(() => {})
    expect(bus.countTerminalSideEffectConsumers()).toBe(1)
    stopConsumer()
    stopObserver()
    expect(bus.countTerminalSideEffectConsumers()).toBe(0)
  })

  it('stops delivering to an observer once it unsubscribes', () => {
    const { bus } = createBus()
    const seen: RuntimeClientEvent[] = []
    const stop = bus.on((event) => seen.push(event), {
      consumesTerminalSideEffects: false,
      observesTerminalSideEffects: true
    })

    stop()
    bus.emit(BATCH_EVENT)

    expect(seen).toEqual([])
  })
})
