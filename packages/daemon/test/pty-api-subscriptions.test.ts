import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PtySessionInfo } from '@quirky/protocol'
import { RuntimeSessionAuthority } from '../src/session-authority'
import { Store } from '../src/store'
import { createPtyApi } from '../src/plugins/pty-api'
import type { PtyClient } from '../src/pty-client'
import type { ClientConn } from '../src/types'

function stubClient(options: { failUnsubscribe?: boolean } = {}) {
  const requests: Array<{ type: string; sessionId: string }> = []
  const sent: Array<{ sessionId: string; bytes: Uint8Array }> = []
  const client = {
    connected: true,
    sendData(sessionId: string, bytes: Uint8Array) {
      sent.push({ sessionId, bytes })
    },
    onData() {},
    onExit() {},
    onFact() {},
    onReconnect() {},
    async request(type: string, params: { sessionId: string }) {
      requests.push({ type, sessionId: params.sessionId })
      if (type === 'unsubscribe' && options.failUnsubscribe) throw new Error('host down')
      return type === 'subscribe' ? { replay: '', offset: 0 } : {}
    }
  } as unknown as PtyClient
  const count = (type: string, sessionId?: string) =>
    requests.filter((request) => request.type === type && (sessionId === undefined || request.sessionId === sessionId)).length
  return { client, count, sent }
}

function rejectingAuthorityClient() {
  const sessions = new Map<string, PtySessionInfo>()
  const rejected = new Set<string>()
  let nextPid = 2000
  const client = {
    connected: true,
    hostPid: 4242,
    sendData() {},
    onData() {},
    onExit() {},
    onFact() {},
    onReconnect() {},
    async request(type: string, params: Record<string, unknown>) {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (type === 'create') {
        const pid = nextPid++
        sessions.set(sessionId, {
          sessionId,
          state: 'running',
          pid,
          alive: true,
          exitCode: null,
          exitSignal: null,
          exitCause: null,
          cols: 80,
          rows: 24,
          argv: ['/bin/sh'],
          cwd: '/isolated',
          title: null,
          shellState: 'unsupported',
          createdAt: pid * 10,
          offset: 0
        })
        return { pid, restored: false, cwd: '/isolated', cols: 80, rows: 24 }
      }
      if (type === 'list') return [...sessions.values()]
      if (type === 'kill' || type === 'forget') {
        if (rejected.delete(type)) throw new Error(`PTY ${type} rejected`)
        if (type === 'forget') sessions.delete(sessionId)
        else {
          const session = sessions.get(sessionId)
          if (session) {
            session.state = 'exited'
            session.alive = false
            session.exitCause = 'killed'
          }
        }
      }
      return {}
    }
  } as unknown as PtyClient
  return { client, sessions, rejectNext: (type: 'kill' | 'forget') => rejected.add(type) }
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
      onFact() {},
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
      onFact() {},
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

describe('PTY input fan-out', () => {
  test('every plugin\'s write reaches every plugin\'s onInput with the data as a string', () => {
    const { client, sent } = stubClient()
    const a = createPtyApi(client, 'a').api
    const b = createPtyApi(client, 'b').api
    const heardA: Array<[string, string]> = []
    const heardB: Array<[string, string]> = []
    a.onInput((sessionId, data) => heardA.push([sessionId, data]))
    b.onInput((sessionId, data) => heardB.push([sessionId, data]))

    a.write('s1', 'ls\r')
    b.write('s2', new TextEncoder().encode('\x03'))

    expect(heardA).toEqual([['s1', 'ls\r'], ['s2', '\x03']])
    expect(heardB).toEqual(heardA)
    expect(sent.map((entry) => entry.sessionId)).toEqual(['s1', 's2'])
  })

  test('bytes that are not valid UTF-8 decode lossily', () => {
    const { client } = stubClient()
    const a = createPtyApi(client, 'a').api
    const heard: string[] = []
    a.onInput((_sessionId, data) => heard.push(data))
    a.write('s1', new Uint8Array([0x61, 0xff]))
    expect(heard).toEqual(['a\ufffd'])
  })

  test('listeners are not called when the send throws', () => {
    const { client } = stubClient()
    ;(client as unknown as { sendData: () => void }).sendData = () => {
      throw new Error('pty down')
    }
    const a = createPtyApi(client, 'a').api
    const heard: string[] = []
    a.onInput((_sessionId, data) => heard.push(data))
    expect(() => a.write('s1', 'x')).toThrow('pty down')
    expect(heard).toEqual([])
  })

  test('a removed listener and a revoked plugin stop hearing input', () => {
    const { client } = stubClient()
    const a = createPtyApi(client, 'a')
    const b = createPtyApi(client, 'b')
    const heardA: string[] = []
    const heardB: string[] = []
    const stop = a.api.onInput((_sessionId, data) => heardA.push(data))
    b.api.onInput((_sessionId, data) => heardB.push(data))
    b.api.write('s1', '1')
    stop()
    b.api.write('s1', '2')
    b.revoke()
    const c = createPtyApi(client, 'c').api
    c.write('s1', '3')
    expect(heardA).toEqual(['1'])
    expect(heardB).toEqual(['1', '2'])
    expect(() => b.api.onInput(() => {})).toThrow(/no longer active/)
  })

  test('a throwing listener is logged and does not stop the others or the write', () => {
    const { client } = stubClient()
    const logs: string[] = []
    const a = createPtyApi(client, 'a', (message) => logs.push(message)).api
    const b = createPtyApi(client, 'b', (message) => logs.push(message)).api
    const heard: string[] = []
    a.onInput(() => {
      throw new Error('boom')
    })
    b.onInput((_sessionId, data) => heard.push(data))
    expect(() => b.write('s1', 'x')).not.toThrow()
    expect(heard).toEqual(['x'])
    expect(logs.some((line) => line.includes('boom'))).toBe(true)
  })
})

describe('PTY runtime authority revocation', () => {
  test('keeps exact live authority when kill or forget fails and revokes after success', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pty-authority-'))
    const store = new Store(join(home, 'runtime.db'))
    const fake = rejectingAuthorityClient()
    const authority = new RuntimeSessionAuthority(store, fake.client)
    const { api, revoke } = createPtyApi(fake.client, 'quirky.session', () => {}, authority)
    const connectionFor = (sessionId: string, sessionToken: string): ClientConn => ({
      id: 1,
      role: 'cli',
      subscribed: false,
      closed: false,
      transport: 'socket',
      sessionId,
      sessionToken,
      streams: new Map(),
      nextStreamId: 1,
      sendText() {},
      streamClosers: new Map(),
      sendBinary() {}
    })
    const spawn = async (sessionId: string) => {
      const sessionToken = authority.issueTerminalToken(sessionId)
      await api.spawn(sessionId, {
        argv: ['/bin/sh'],
        cwd: '/isolated',
        env: { QUIRKY_SESSION_TOKEN: sessionToken },
        cols: 80,
        rows: 24
      })
      const connection = connectionFor(sessionId, sessionToken)
      const identity = await authority.resolveForConnection(connection)
      if (!identity) throw new Error(`session ${sessionId} did not bind runtime authority`)
      return { connection, identity }
    }

    try {
      const kill = await spawn('s_kill')
      const killRow = store.getRuntimeAuthority('s_kill')
      fake.rejectNext('kill')
      await expect(api.kill('s_kill')).rejects.toThrow('PTY kill rejected')
      expect(store.getRuntimeAuthority('s_kill')).toEqual(killRow)
      expect(await authority.resolveForConnection(kill.connection)).toEqual(kill.identity)
      await api.kill('s_kill')
      expect(store.getRuntimeAuthority('s_kill')).toBeNull()

      const forget = await spawn('s_forget')
      const forgetRow = store.getRuntimeAuthority('s_forget')
      fake.rejectNext('forget')
      await expect(api.forget('s_forget')).rejects.toThrow('PTY forget rejected')
      expect(store.getRuntimeAuthority('s_forget')).toEqual(forgetRow)
      expect(await authority.resolveForConnection(forget.connection)).toEqual(forget.identity)
      await api.forget('s_forget')
      expect(store.getRuntimeAuthority('s_forget')).toBeNull()
    } finally {
      revoke()
      store.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
