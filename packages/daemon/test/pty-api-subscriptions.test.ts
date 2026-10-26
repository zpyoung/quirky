import { describe, expect, test } from 'bun:test'
import { createPtyApi } from '../src/plugins/pty-api'
import type { PtyClient } from '../src/pty-client'

function stubClient(options: { failUnsubscribe?: boolean } = {}) {
  const requests: Array<{ type: string; sessionId: string }> = []
  const client = {
    connected: true,
    onData() {},
    onExit() {},
    onReconnect() {},
    async request(type: string, params: { sessionId: string }) {
      requests.push({ type, sessionId: params.sessionId })
      if (type === 'unsubscribe' && options.failUnsubscribe) throw new Error('host down')
      return type === 'subscribe' ? { replay: '', offset: 0 } : {}
    }
  } as unknown as PtyClient
  const count = (type: string, sessionId?: string) =>
    requests.filter((request) => request.type === type && (sessionId === undefined || request.sessionId === sessionId)).length
  return { client, count }
}

describe('PTY subscription holds', () => {
  test('a session still held by another plugin is not unsubscribed on the host', async () => {
    const { client, count } = stubClient()
    const a = createPtyApi(client, 'a').api
    const b = createPtyApi(client, 'b').api
    await a.subscribe('s1')
    await b.subscribe('s1')
    await a.unsubscribe('s1')
    expect(count('unsubscribe')).toBe(0)
    await b.unsubscribe('s1')
    expect(count('unsubscribe', 's1')).toBe(1)
  })

  test('every subscribe reaches the host, but repeats by one plugin do not stack', async () => {
    const { client, count } = stubClient()
    const a = createPtyApi(client, 'a').api
    await a.subscribe('s1')
    await a.subscribe('s1')
    expect(count('subscribe', 's1')).toBe(2)
    await a.unsubscribe('s1')
    expect(count('unsubscribe', 's1')).toBe(1)
  })

  test('unsubscribe without a hold still reaches the host when nobody holds the session', async () => {
    const { client, count } = stubClient()
    const a = createPtyApi(client, 'a').api
    await a.unsubscribe('s1')
    expect(count('unsubscribe', 's1')).toBe(1)
  })

  test('revoke releases only the sessions no other plugin holds', async () => {
    const { client, count } = stubClient()
    const a = createPtyApi(client, 'a')
    const b = createPtyApi(client, 'b')
    await a.api.subscribe('shared')
    await a.api.subscribe('solo')
    await b.api.subscribe('shared')
    a.revoke()
    await Promise.resolve()
    expect(count('unsubscribe', 'solo')).toBe(1)
    expect(count('unsubscribe', 'shared')).toBe(0)
    b.revoke()
    await Promise.resolve()
    expect(count('unsubscribe', 'shared')).toBe(1)
  })

  test('revoke ignores host errors while releasing', async () => {
    const { client, count } = stubClient({ failUnsubscribe: true })
    const a = createPtyApi(client, 'a')
    await a.api.subscribe('s1')
    expect(() => a.revoke()).not.toThrow()
    await Promise.resolve()
    expect(count('unsubscribe', 's1')).toBe(1)
  })

  test('holds are separate per client', async () => {
    const first = stubClient()
    const second = stubClient()
    const a = createPtyApi(first.client, 'a').api
    const b = createPtyApi(second.client, 'b').api
    await a.subscribe('s1')
    await b.subscribe('s1')
    await a.unsubscribe('s1')
    expect(first.count('unsubscribe', 's1')).toBe(1)
  })

  test('a failed subscribe does not erase a concurrent subscribe that succeeds', async () => {
    const settle: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = []
    const requests: string[] = []
    const client = {
      connected: true,
      onData() {},
      onExit() {},
      onReconnect() {},
      request(type: string) {
        requests.push(type)
        if (type !== 'subscribe') return Promise.resolve({})
        return new Promise((resolve, reject) => settle.push({ resolve, reject }))
      }
    } as unknown as PtyClient
    const a = createPtyApi(client, 'a')
    const first = a.api.subscribe('s1').catch(() => {})
    const second = a.api.subscribe('s1')
    settle[0]!.reject(new Error('first subscribe failed'))
    await first
    settle[1]!.resolve({ replay: '', offset: 0 })
    await second
    a.revoke()
    await Promise.resolve()
    expect(requests.filter((type) => type === 'unsubscribe')).toHaveLength(1)
  })

  test('a failed subscribe with no other attempt still releases its hold', async () => {
    const requests: string[] = []
    const client = {
      connected: true,
      onData() {},
      onExit() {},
      onReconnect() {},
      request(type: string) {
        requests.push(type)
        return type === 'subscribe' ? Promise.reject(new Error('nope')) : Promise.resolve({})
      }
    } as unknown as PtyClient
    const a = createPtyApi(client, 'a')
    await expect(a.api.subscribe('s1')).rejects.toThrow('nope')
    a.revoke()
    await Promise.resolve()
    expect(requests).not.toContain('unsubscribe')
  })
})
