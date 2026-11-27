import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { cancelAskOnInterrupt } from './ask-cli-interrupt'

describe('cancelAskOnInterrupt', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ])('cancels the ask and exits on %s', async (signal, exitCode) => {
    const call = vi.fn().mockResolvedValue({ result: {} })
    const exit = vi.fn()
    const signals = new EventEmitter()
    cancelAskOnInterrupt({ call }, 'ask_1', exit, signals)

    signals.emit(signal)

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(exitCode))
    expect(call).toHaveBeenCalledWith('ask.cancel', { askId: 'ask_1' }, expect.any(Object))
  })

  it('still exits when the cancel call fails', async () => {
    const call = vi.fn().mockRejectedValue(new Error('host gone'))
    const exit = vi.fn()
    const signals = new EventEmitter()
    cancelAskOnInterrupt({ call }, 'ask_1', exit, signals)

    signals.emit('SIGTERM')

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143))
  })

  it('stops reacting to signals once disposed', () => {
    const exit = vi.fn()
    const signals = new EventEmitter()
    const dispose = cancelAskOnInterrupt({ call: vi.fn() }, 'ask_1', exit, signals)

    dispose()
    signals.emit('SIGINT')

    expect(signals.listenerCount('SIGINT')).toBe(0)
    expect(exit).not.toHaveBeenCalled()
  })
})
