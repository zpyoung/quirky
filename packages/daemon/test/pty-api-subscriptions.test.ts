import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PTY_PROTOCOL_VERSION, decodeTerminalFrame, encodePtyData, encodePtyJson, type PluginCaller, type PluginContext, type PtySessionInfo, type PtySnapshot } from '@quirky/protocol'
import { RuntimeSessionAuthority } from '../src/session-authority'
import { Store } from '../src/store'
import { createPtyApi } from '../src/plugins/pty-api'
import { PtyClient } from '../src/pty-client'
import type { ClientConn } from '../src/types'
import { mock } from 'node:test'
import { openStream, onConnectionClose } from '../src/plugins/streams'
import { WebSocketOutput } from '../src/websocket-output'
import { TerminalService } from '../../../plugins/quirky.terminal/src/terminal'
import { DeliveryRunner } from '../../../plugins/quirky.agents/src/delivery'
import { validateEntry } from '../../../plugins/quirky.agents/src/core/entry'
import { startFakePtyHost } from './fixtures/fake-pty-host'

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
    onLagged() {},
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
    onLagged() {},
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
      onLagged() {},
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
      onLagged() {},
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

test.each([false, true])('daemon advertises session shedding through negotiated and legacy hello (legacy=%s)', async (legacy) => {
  const home = mkdtempSync(join(tmpdir(), 'pty-capability-'))
  const version = legacy ? PTY_PROTOCOL_VERSION - 1 : PTY_PROTOCOL_VERSION
  const host = startFakePtyHost(home, { version, legacyHello: legacy })
  const client = new PtyClient({
    home,
    hostEntry: join(home, 'must-not-launch.ts'),
    connectTimeoutMs: 2_000,
    protocol: { min: version, max: PTY_PROTOCOL_VERSION }
  })
  try {
    await client.connect()
    expect(client.connected).toBe(true)
    expect(client.protocolVersion).toBe(version)
    const hellos = host.requests.filter((request) => request.type === 'hello')
    expect(hellos).toHaveLength(legacy ? 2 : 1)
    expect(hellos[0]).toMatchObject({
      version: PTY_PROTOCOL_VERSION,
      minVersion: version,
      token: host.token,
      sessionLagged: true
    })
    if (legacy) {
      expect(hellos[1]).toMatchObject({ version, token: host.token, sessionLagged: true })
      expect(hellos[1]).not.toHaveProperty('minVersion')
    }
    expect(await client.request('list', {})).toEqual([])
    expect(host.requests.some((request) => request.type === 'shutdown')).toBe(false)
  } finally {
    client.close()
    host.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

function lagClient(handle?: (type: string, sessionId: string) => unknown) {
  const client = new PtyClient({ home: '/isolated' })
  const requests: Array<{ type: string; sessionId: string; id: number }> = []
  const internal = client as unknown as {
    pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: undefined }>
    request(type: string, params: { sessionId: string }): Promise<unknown>
    handleChunk(socket: { end(): void }, bytes: Uint8Array): void
  }
  let nextId = 1
  const request = (type: string, params: { sessionId: string }): Promise<unknown> => {
    const id = nextId++
    requests.push({ type, sessionId: params.sessionId, id })
    if (handle) return Promise.resolve(handle(type, params.sessionId))
    if (type !== 'subscribe') return Promise.resolve({})
    const pending = Promise.withResolvers<unknown>()
    internal.pending.set(id, { resolve: pending.resolve, reject: pending.reject, timer: undefined })
    return pending.promise
  }
  internal.request = request
  const input = (...messages: unknown[]) => {
    const bytes = Buffer.concat(messages.map((message) => encodePtyJson(message)))
    internal.handleChunk({ end() { throw new Error('invalid fixture frame') } }, bytes)
  }
  const data = (sessionId: string, text: string) => {
    internal.handleChunk({ end() {} }, encodePtyData(sessionId, new TextEncoder().encode(text)))
  }
  const response = (index: number, ok = true) => ({
    id: requests[index]!.id,
    ok,
    ...(ok ? { result: { replay: '', offset: 0 } } : { error: 'old subscribe failed' })
  })
  const count = (type: string, sessionId?: string) =>
    requests.filter((entry) => entry.type === type && (sessionId === undefined || entry.sessionId === sessionId)).length
  return { client, input, data, response, count, requests }
}

describe('PTY output lag invalidation', () => {
  test('raw lag invalidates all A holds before callbacks while preserving B', async () => {
    const host = lagClient()
    const terminal = createPtyApi(host.client, 'terminal')
    const agent = createPtyApi(host.client, 'agent')
    const other = createPtyApi(host.client, 'other')
    const initial = [terminal.api.subscribe('A'), agent.api.subscribe('A'), other.api.subscribe('B')]
    host.input(host.response(0), host.response(1), host.response(2))
    await Promise.all(initial)
    let recovered: Promise<unknown> | undefined
    const heard: string[] = []
    terminal.api.onLagged((id) => {
      heard.push(`terminal:${id}`)
      recovered = agent.api.subscribe(id)
      void terminal.api.unsubscribe(id)
    })
    agent.api.onLagged((id) => heard.push(`agent:${id}`))
    host.input({ type: 'lagged', sessionId: 'A' })
    expect(heard).toEqual(['terminal:A', 'agent:A'])
    expect(host.count('unsubscribe')).toBe(0)
    host.input(host.response(3))
    await recovered
    terminal.revoke()
    expect(host.count('unsubscribe')).toBe(0)
    agent.revoke()
    other.revoke()
    expect(host.count('unsubscribe', 'A')).toBe(1)
    expect(host.count('unsubscribe', 'B')).toBe(1)
  })

  test.each([true, false])('a pre-gap %s completion cannot release a reacquired hold', async (ok) => {
    const host = lagClient()
    const terminal = createPtyApi(host.client, 'terminal')
    const agent = createPtyApi(host.client, 'agent')
    const old = terminal.api.subscribe('A').catch(() => {})
    let current: Promise<unknown> | undefined
    terminal.api.onLagged((id) => {
      current = terminal.api.subscribe(id)
    })
    host.input({ type: 'lagged', sessionId: 'A' })
    host.input(host.response(0, ok), host.response(1))
    await Promise.all([old, current])
    const shared = agent.api.subscribe('A')
    host.input(host.response(2))
    await shared
    terminal.revoke()
    expect(host.count('unsubscribe')).toBe(0)
    agent.revoke()
    expect(host.count('unsubscribe', 'A')).toBe(1)
  })

  test('a same-chunk reply and lag cannot mark the next subscribe attempt successful', async () => {
    const host = lagClient()
    const api = createPtyApi(host.client, 'terminal')
    const old = api.api.subscribe('A')
    let current: Promise<unknown> | undefined
    api.api.onLagged((id) => { current = api.api.subscribe(id).catch(() => {}) })
    host.input(host.response(0), { type: 'lagged', sessionId: 'A' })
    await old
    host.input(host.response(1, false))
    await current
    api.revoke()
    expect(host.count('unsubscribe')).toBe(0)
  })

  test('a new failed attempt does not inherit success from before the gap', async () => {
    const host = lagClient()
    const api = createPtyApi(host.client, 'terminal')
    const old = api.api.subscribe('A')
    host.input(host.response(0))
    await old
    let current: Promise<unknown> | undefined
    api.api.onLagged((id) => { current = api.api.subscribe(id).catch(() => {}) })
    host.input({ type: 'lagged', sessionId: 'A' })
    host.input(host.response(1, false))
    await current
    api.revoke()
    expect(host.count('unsubscribe')).toBe(0)
  })

  test('lag listeners isolate failures, and removed or revoked listeners stay silent', async () => {
    const host = lagClient()
    const logs: string[] = []
    const a = createPtyApi(host.client, 'a', (line) => logs.push(line))
    const b = createPtyApi(host.client, 'b')
    const heard: string[] = []
    a.api.onLagged(() => { throw new Error('sync lag failure') })
    a.api.onLagged(async () => { throw new Error('async lag failure') })
    const remove = a.api.onLagged(() => heard.push('removed'))
    remove()
    b.api.onLagged((id) => heard.push(id))
    host.input({ type: 'lagged', sessionId: 'A' })
    await Promise.resolve()
    expect(heard).toEqual(['A'])
    expect(logs.some((line) => line.includes('sync lag failure'))).toBe(true)
    expect(logs.some((line) => line.includes('async lag failure'))).toBe(true)
    b.revoke()
    host.input({ type: 'lagged', sessionId: 'B' })
    await Promise.resolve()
    expect(heard).toEqual(['A'])
    expect(() => b.api.onLagged(() => {})).toThrow('no longer active')
    a.revoke()
  })
})

test('host lag joins deferred desktop markers, mobile snapshots and agent readiness on one client', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const snapshot = Promise.withResolvers<PtySnapshot>()
  const takingSnapshot = Promise.withResolvers<void>()
  const agentSubscribed = Promise.withResolvers<void>()
  const phoneReset = Promise.withResolvers<void>()
  let recovering = false
  let recoverySubscribes = 0
  const ready = '\x1b[?2004h\x1b[?25h'
  const host = lagClient((type) => {
    if (type === 'subscribe') {
      if (recovering && ++recoverySubscribes === 2) agentSubscribed.resolve()
      return {
        replay: recovering ? Buffer.from(ready).toString('base64') : '',
        offset: recovering ? 100 : 0,
        historyCursor: null, cols: 80, rows: 24, shellState: 'unsupported', live: true
      }
    }
    if (type === 'snapshot') {
      takingSnapshot.resolve()
      return snapshot.promise
    }
    if (type === 'list') return [{ sessionId: 'A', alive: true }]
    return {}
  })
  const writes: string[] = []
  host.client.sendData = (_id, bytes) => { writes.push(new TextDecoder().decode(bytes)) }
  const terminal = createPtyApi(host.client, 'quirky.terminal')
  const agents = createPtyApi(host.client, 'quirky.agents')
  const context = {
    pty: terminal.api,
    error: (_kind: string, message: string) => new Error(message),
    log() {},
    emit: () => true,
    call: async () => ({
      id: 'A', kind: 'terminal', agent: 'shell', worktreeId: 'wt_main', cwd: '/isolated',
      title: 'Shell', status: 'running', createdAt: 1, lastActivityAt: 1,
      exitCode: null, exitSignal: null, exitCause: null, restorable: false
    })
  } as unknown as PluginContext
  const service = new TerminalService(context, async () => new Map())
  const removeData = terminal.api.onData(service.onData)
  const removeLag = terminal.api.onLagged(service.onLagged)
  const peers: Array<{ conn: ClientConn; output: WebSocketOutput }> = []
  const peer = (id: number, mobile: boolean) => {
    let buffered = 0
    let blocked = false
    const frames: Uint8Array[] = []
    const output = new WebSocketOutput({
      readyState: 1,
      getBufferedAmount: () => buffered,
      send(text) {
        if (blocked) return 0
        buffered += Buffer.byteLength(text) + 2
        return 1
      },
      sendBinary(bytes) {
        if (blocked) return 0
        frames.push(bytes.slice())
        buffered += bytes.length + (bytes.length < 126 ? 2 : 4)
        const frame = decodeTerminalFrame(bytes)
        if (mobile && frame?.kind === 'output') phoneReset.resolve()
        return 1
      }
    }, () => { throw new Error('unexpected bounded output failure') })
    const conn: ClientConn = {
      id, role: mobile ? 'mobile' : 'ui', subscribed: false, closed: false, transport: 'websocket',
      streams: new Map(), streamClosers: new Map(), nextStreamId: 1,
      sendText: (text) => output.sendText(text),
      sendBinary: (bytes) => output.sendBinary(bytes),
      closeStreamOutput: (streamId) => output.closeStream(streamId)
    }
    const caller: PluginCaller = {
      role: mobile ? 'mobile' : 'ui',
      ...(mobile ? { deviceId: 'fixture-phone' } : {}),
      connection: {
        id, transport: 'websocket',
        openStream: () => openStream(conn),
        onClose: (callback) => onConnectionClose(conn, callback)
      }
    }
    peers.push({ conn, output })
    return {
      conn, caller, output, frames,
      block() { output.sendText('busy'); blocked = true },
      drain() { blocked = false; buffered = 0; output.drain() }
    }
  }
  const desktop = peer(10, false)
  const phone = peer(11, true)
  try {
    const attached = await service.attach({ session: 'A', cols: 80, rows: 24 }, desktop.caller)
    const phoneAttached = await service.attach({ session: 'A', cols: 80, rows: 24 }, phone.caller)
    const checked = validateEntry('quirky.agents', 'fixture', {
      label: 'Fixture', detect: 'fixture', prompt: 'stdin-after-start',
      readySignal: 'render-cursor-after-bracketed-paste', readyTimeoutMs: 2_000
    })
    if (!checked.ok) throw new Error(checked.error)
    const runner = new DeliveryRunner({ pty: agents.api, onSessionGone: () => () => {} })
    const delivery = runner.deliver('A', checked.entry, 'one prompt', false)
    await Promise.resolve()
    desktop.block()
    recovering = true
    host.input({ type: 'lagged', sessionId: 'A' })
    await takingSnapshot.promise
    expect(desktop.frames).toEqual([])
    expect(phone.frames).toEqual([])
    expect(host.count('unsubscribe')).toBe(0)
    host.data('A', 'tail')
    mock.timers.tick(500)
    await agentSubscribed.promise
    expect(await delivery).toBe('pasted')
    expect(writes).toEqual(['\x1b[200~one prompt\x1b[201~'])
    expect(host.count('unsubscribe')).toBe(0)
    snapshot.resolve({
      ansi: 'screen', offset: 100, cols: 80, rows: 24, cursor: { x: 0, y: 0 },
      modes: { alternateScreen: false, bracketedPaste: false, mouseTracking: false, applicationCursor: false },
      cwd: '/isolated', title: null, shellState: 'unsupported'
    })
    await phoneReset.promise
    const received = phone.frames.map((bytes) => decodeTerminalFrame(bytes))
    expect(received.every((frame) => frame?.kind === 'output' && frame.streamId === phoneAttached.streamId)).toBe(true)
    expect(received.map((frame) => frame?.kind === 'output' ? new TextDecoder().decode(frame.bytes) : '').join(''))
      .toBe('\x18\x1b\\\x1bc\x1b[3Jscreen' + 'tail')
    desktop.drain()
    expect(desktop.frames.map((bytes) => decodeTerminalFrame(bytes)))
      .toEqual([{ kind: 'lagged', streamId: attached.streamId }])
    service.shutdown()
    for (const { conn, output } of peers) {
      conn.closed = true
      for (const close of [...conn.streamClosers.values()]) close()
      output.dispose()
      expect(conn.streamClosers.size).toBe(0)
    }
    const sends = phone.frames.length + desktop.frames.length
    const requests = host.requests.length
    mock.timers.tick(10_000)
    host.data('A', 'late')
    expect(phone.frames.length + desktop.frames.length).toBe(sends)
    expect(host.requests.length).toBe(requests)
    expect(host.count('unsubscribe', 'A')).toBe(1)
  } finally {
    service.shutdown()
    removeData()
    removeLag()
    terminal.revoke()
    agents.revoke()
    for (const { output } of peers) output.dispose()
    mock.timers.reset()
  }
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
