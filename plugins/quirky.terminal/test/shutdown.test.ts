import { describe, expect, test } from 'bun:test'
import type { ClientStream, PluginCaller, PluginContext } from '@quirky/protocol'
import { TerminalService } from '../src/terminal'

function setup() {
  let releaseSubscribe!: (value: { replay: string; offset: number }) => void
  const subscribeStarted = Promise.withResolvers<void>()
  const unsubscribed: string[] = []
  const streams: { closes: number; sent: Uint8Array[] }[] = []
  const closeHandlers: (() => void)[] = []

  const context = {
    error: (kind: string, message: string) => new Error(`${kind}: ${message}`),
    log: () => {},
    call: async () => ({ id: 's1', kind: 'terminal', agent: 'shell' }),
    pty: {
      resize: async () => {},
      subscribe: () => {
        subscribeStarted.resolve()
        return new Promise<{ replay: string; offset: number }>((resolve) => (releaseSubscribe = resolve))
      },
      unsubscribe: async (id: string) => void unsubscribed.push(id)
    }
  } as unknown as PluginContext

  const caller = {
    role: 'ui',
    connection: {
      id: 1,
      transport: 'websocket',
      openStream(): ClientStream {
        const record = { closes: 0, sent: [] as Uint8Array[] }
        streams.push(record)
        const index = closeHandlers.length
        closeHandlers.push(() => {})
        return {
          streamId: streams.length,
          send: (bytes) => void record.sent.push(bytes),
          onClose: (callback) => void (closeHandlers[index] = callback),
          close: () => {
            record.closes++
            if (record.closes === 1) closeHandlers[index]()
          }
        }
      }
    }
  } as unknown as PluginCaller

  const service = new TerminalService(context)
  const attach = () => service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
  return { service, attach, streams, unsubscribed, subscribeStarted: subscribeStarted.promise, release: (v: { replay: string; offset: number }) => releaseSubscribe(v) }
}

describe('TerminalService.shutdown', () => {
  test('an attach in flight is closed and fails once its subscribe resolves, and nothing is registered', async () => {
    const t = setup()
    const pending = t.attach()
    const outcome = pending.then(
      () => 'resolved',
      (error: Error) => error.message
    )
    await t.subscribeStarted

    t.service.shutdown()
    t.release({ replay: '', offset: 0 })

    expect(await outcome).not.toBe('resolved')
    expect(t.streams).toHaveLength(1)
    expect(t.streams[0]!.closes).toBeGreaterThanOrEqual(1)

    t.service.onData('s1', new Uint8Array([1]))
    expect(t.streams[0]!.sent).toEqual([])
    await Bun.sleep(0)
    expect(t.unsubscribed).toEqual(['s1'])
    expect(() => t.service.detach({ streamId: 1 }, { role: 'ui', connection: { id: 1 } } as unknown as PluginCaller)).toThrow()
  })

  test('new attaches are refused after shutdown and open no stream', async () => {
    const t = setup()
    t.service.shutdown()
    await expect(t.attach()).rejects.toThrow('shut down')
    expect(t.streams).toHaveLength(0)
  })
})
