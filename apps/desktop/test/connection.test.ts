import { describe, expect, test } from 'bun:test'
import { maintainConnection, type ConnectionLike } from '../src/bun/connection'

const fakeClient = () => {
  let closeHandler: (() => void) | null = null
  const client: ConnectionLike & { drop: () => void } = {
    onClose: (handler) => {
      closeHandler = handler
      return () => {}
    },
    drop: () => closeHandler?.()
  }
  return client
}

describe('maintainConnection', () => {
  test('connects, then reconnects through ensure when the connection drops', async () => {
    const clients = [fakeClient(), fakeClient()]
    const steps: string[] = []
    let stop = false
    const done = maintainConnection({
      ensure: async () => {
        steps.push('ensure')
      },
      connect: async () => {
        steps.push('connect')
        return clients[steps.filter((s) => s === 'connect').length - 1]!
      },
      onConnected: (client) => {
        steps.push('connected')
        if (client === clients[0]) queueMicrotask(() => clients[0]!.drop())
        else {
          stop = true
          queueMicrotask(() => clients[1]!.drop())
        }
      },
      onDisconnected: () => steps.push('disconnected'),
      sleep: async () => {},
      shouldStop: () => stop
    })
    await done
    expect(steps).toEqual([
      'ensure', 'connect', 'connected', 'disconnected',
      'ensure', 'connect', 'connected', 'disconnected'
    ])
  })

  test('retries with a delay when ensure or connect fails', async () => {
    const delays: number[] = []
    let attempts = 0
    let stop = false
    const errors: string[] = []
    await maintainConnection({
      ensure: async () => {
        attempts += 1
        if (attempts < 3) throw new Error(`boom ${attempts}`)
      },
      connect: async () => {
        stop = true
        return fakeClient()
      },
      onConnected: (client) => queueMicrotask(() => client.drop()),
      onDisconnected: () => {},
      onError: (error) => errors.push((error as Error).message),
      sleep: async (ms) => {
        delays.push(ms)
      },
      shouldStop: () => stop
    })
    expect(errors).toEqual(['boom 1', 'boom 2'])
    expect(delays.length).toBe(2)
    expect(delays[1]!).toBeGreaterThan(delays[0]!)
  })
})
