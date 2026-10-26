import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { base64ToBytes, QuirkyClient, RpcErrorCode, type ApiDescription, type PluginInfo, type Session } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { call, code, createSession, startPluginHarness, TERMINAL_PLUGINS } from './support'

let h: Harness
let client: QuirkyClient
let shell: Session
let claude: Session

beforeEach(async () => {
  process.env.QUIRKY_TEST_ENTER_DELAY_MS = '20'
  h = await startPluginHarness(TERMINAL_PLUGINS)
  client = await h.connect('ui')
  shell = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
  claude = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
})
afterEach(async () => {
  delete process.env.QUIRKY_TEST_ENTER_DELAY_MS
  await h.cleanup()
})

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const subscribes = (sessionId: string) => h.pty.requests.filter((r) => r.type === 'subscribe' && r.sessionId === sessionId).length
const unsubscribes = (sessionId: string) => h.pty.requests.filter((r) => r.type === 'unsubscribe' && r.sessionId === sessionId).length
const attach = (c: QuirkyClient, session: string, cols = 80, rows = 24) =>
  call<{ streamId: number; replay: string; offset: number }>(c, 'quirky.terminal/attach', { session, cols, rows })

describe('quirky.terminal/attach', () => {
  test('passes replay and offset through, then streams live frames and stops on detach', async () => {
    h.pty.emit(shell.id, 'before-attach ')
    const attached = await attach(client, shell.id, 90, 20)
    expect(text(base64ToBytes(attached.replay))).toBe('before-attach ')
    expect(attached.offset).toBe('before-attach '.length)
    expect(h.pty.sessions.get(shell.id)?.info).toMatchObject({ cols: 90, rows: 20 })

    const received: string[] = []
    client.onTerminalOutput(attached.streamId, (bytes) => received.push(text(bytes)))
    h.pty.emit(shell.id, 'one ')
    h.pty.emit(shell.id, 'two')
    await waitFor(() => received.join('') === 'one two')

    await call(client, 'quirky.terminal/detach', { streamId: attached.streamId })
    await waitFor(() => unsubscribes(shell.id) === 1)
    h.pty.emit(shell.id, 'after')
    await Bun.sleep(50)
    expect(received.join('')).toBe('one two')
  })

  test('subscribes to the pty host for every attach and unsubscribes after the last detach', async () => {
    const a = await attach(client, shell.id)
    const other = await h.connect('desktop')
    const b = await attach(other, shell.id)
    expect(subscribes(shell.id)).toBe(2)

    const gotA: string[] = []
    const gotB: string[] = []
    client.onTerminalOutput(a.streamId, (bytes) => gotA.push(text(bytes)))
    other.onTerminalOutput(b.streamId, (bytes) => gotB.push(text(bytes)))
    h.pty.emit(shell.id, 'x')
    await waitFor(() => gotA.length === 1 && gotB.length === 1)

    await call(client, 'quirky.terminal/detach', { streamId: a.streamId })
    await Bun.sleep(30)
    expect(unsubscribes(shell.id)).toBe(0)
    h.pty.emit(shell.id, 'y')
    await waitFor(() => gotB.join('') === 'xy')
    expect(gotA.join('')).toBe('x')

    other.close()
    await waitFor(() => unsubscribes(shell.id) === 1)
  })

  test('detaches streams when the connection closes', async () => {
    const other = await h.connect('ui')
    await attach(other, shell.id)
    other.close()
    await waitFor(() => unsubscribes(shell.id) === 1)
  })

  test('rejects unknown sessions and streams, and sessions without a terminal', async () => {
    expect(await code(attach(client, 's_nope'))).toBe(RpcErrorCode.NotFound)
    expect(await code(call(client, 'quirky.terminal/detach', { streamId: 99 }))).toBe(RpcErrorCode.NotFound)
    const structured = await call<Session>(client, 'quirky.session/register', {
      worktree: 'id:wt_main',
      agent: 'claude',
      kind: 'structured',
      title: 'Claude'
    })
    expect(await code(attach(client, structured.id))).toBe(RpcErrorCode.InvalidParams)
  })

  test('a stream cannot be detached by another connection', async () => {
    const attached = await attach(client, shell.id)
    const other = await h.connect('ui')
    expect(await code(call(other, 'quirky.terminal/detach', { streamId: attached.streamId }))).toBe(RpcErrorCode.NotFound)
  })

  test('catches up on output produced while the pty host connection was down', async () => {
    const attached = await attach(client, shell.id)
    const received: string[] = []
    client.onTerminalOutput(attached.streamId, (bytes) => received.push(text(bytes)))
    h.pty.emit(shell.id, 'a')
    await waitFor(() => received.join('') === 'a')
    h.pty.dropConnections()
    h.pty.emit(shell.id, 'b')
    await waitFor(() => received.join('') === 'ab', 5000)
    h.pty.emit(shell.id, 'c')
    await waitFor(() => received.join('') === 'abc', 5000)
  })

  test('output that follows the subscribe response is delivered once, in order', async () => {
    h.pty.emit(shell.id, 'old ')
    trapSubscribe(shell.id, 'new')
    const attached = await attach(client, shell.id)
    const received: string[] = []
    client.onTerminalOutput(attached.streamId, (bytes) => received.push(text(bytes)))
    h.pty.emit(shell.id, '!')
    await waitFor(() => received.join('').endsWith('!'))
    expect(text(base64ToBytes(attached.replay)) + received.join('')).toBe('old new!')
  })

  test('output that follows the resubscribe after a reconnect is delivered once, in order', async () => {
    const attached = await attach(client, shell.id)
    const received: string[] = []
    client.onTerminalOutput(attached.streamId, (bytes) => received.push(text(bytes)))
    h.pty.emit(shell.id, 'a')
    await waitFor(() => received.join('') === 'a')
    h.pty.dropConnections()
    h.pty.emit(shell.id, 'b')
    trapSubscribe(shell.id, 'c')
    await waitFor(() => received.join('') === 'abc', 5000)
    h.pty.emit(shell.id, 'd')
    await waitFor(() => received.join('') === 'abcd', 5000)
  })

  test('closing a session ends its streams without asking the host to unsubscribe', async () => {
    const attached = await attach(client, shell.id)
    await call(client, 'quirky.session/close', { session: shell.id })
    await Bun.sleep(60)
    expect(await code(call(client, 'quirky.terminal/detach', { streamId: attached.streamId }))).toBe(RpcErrorCode.NotFound)
    expect(unsubscribes(shell.id)).toBe(0)
  })

  test('SC-5: a socket connection cannot attach', async () => {
    const socket = await QuirkyClient.connectSocket(h.runtime.socket!, { role: 'cli', token: h.runtime.token })
    try {
      const failure = await attach(socket, shell.id).catch((error) => error)
      expect(failure.code).toBe(RpcErrorCode.InvalidParams)
      expect(failure.message).toContain('needs the WebSocket transport')
      expect(subscribes(shell.id)).toBe(0)
    } finally {
      socket.close()
    }
  })
})

/** Makes the fake host write `data` right after its next subscribe response for the session. */
function trapSubscribe(sessionId: string, data: string): void {
  const session = h.pty.sessions.get(sessionId)!
  const subscribers = session.subscribers
  let armed = true
  session.subscribers = new (class extends Set<(typeof subscribers extends Set<infer T> ? T : never)> {
    override add(value: never) {
      super.add(value)
      if (armed) {
        armed = false
        queueMicrotask(() => h.pty.emit(sessionId, data))
      }
      return this
    }
  })(subscribers)
}

describe('terminal input and screen', () => {
  test('write sends a DATA frame', async () => {
    await call(client, 'quirky.terminal/write', { session: shell.id, data: 'ls\r' })
    await waitFor(() => h.pty.inputs.length === 1)
    expect(h.pty.inputs[0]).toEqual({ sessionId: shell.id, text: 'ls\r' })
  })

  test('send types text for shells and pastes for agents', async () => {
    await call(client, 'quirky.terminal/send', { session: shell.id, text: 'echo hi', enter: true })
    await call(client, 'quirky.terminal/send', { session: shell.id, text: 'partial' })
    await waitFor(() => h.pty.inputs.length === 2)
    expect(h.pty.inputs.map((i) => i.text)).toEqual(['echo hi\r', 'partial'])

    h.pty.inputs.length = 0
    const started = Date.now()
    await call(client, 'quirky.terminal/send', { session: claude.id, text: 'do it', enter: true })
    await waitFor(() => h.pty.inputs.length === 2)
    expect(h.pty.inputs.map((i) => i.text)).toEqual(['\x1b[200~do it\x1b[201~', '\r'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)

    h.pty.inputs.length = 0
    await call(client, 'quirky.terminal/send', { session: claude.id, text: 'draft' })
    await Bun.sleep(60)
    expect(h.pty.inputs.map((i) => i.text)).toEqual(['\x1b[200~draft\x1b[201~'])
  })

  test('resize and read pass through', async () => {
    await call(client, 'quirky.terminal/resize', { session: shell.id, cols: 132, rows: 43 })
    expect(h.pty.sessions.get(shell.id)?.info).toMatchObject({ cols: 132, rows: 43 })
    h.pty.setReadResult({ lines: ['a', 'b'], cols: 132, rows: 43, alt: true })
    expect(await call(client, 'quirky.terminal/read', { session: shell.id })).toEqual({
      lines: ['a', 'b'],
      cols: 132,
      rows: 43,
      alt: true
    })
    expect(h.pty.requests.filter((r) => r.type === 'read').at(-1)).toMatchObject({ lines: 50 })
    await call(client, 'quirky.terminal/read', { session: shell.id, lines: 7 })
    expect(h.pty.requests.filter((r) => r.type === 'read').at(-1)).toMatchObject({ lines: 7 })
  })

  test('input to an unknown session is NotFound', async () => {
    expect(await code(call(client, 'quirky.terminal/write', { session: 's_nope', data: 'x' }))).toBe(RpcErrorCode.NotFound)
    expect(await code(call(client, 'quirky.terminal/read', { session: 's_nope' }))).toBe(RpcErrorCode.NotFound)
  })

  test('SC-21: send and read default to the calling session', async () => {
    const inside = await QuirkyClient.connect(rpcUrl(h.runtime), { role: 'cli', sessionId: shell.id, worktreeId: 'wt_main' })
    try {
      await call(inside, 'quirky.terminal/send', { text: 'pwd', enter: true })
      await waitFor(() => h.pty.inputs.length === 1)
      expect(h.pty.inputs[0]).toEqual({ sessionId: shell.id, text: 'pwd\r' })
      h.pty.setReadResult({ lines: ['x'], cols: 80, rows: 24, alt: false })
      expect(await call(inside, 'quirky.terminal/read', { lines: 3 })).toMatchObject({ lines: ['x'] })
      expect(h.pty.requests.filter((r) => r.type === 'read').at(-1)).toMatchObject({ sessionId: shell.id, lines: 3 })
    } finally {
      inside.close()
    }
    expect(await code(call(client, 'quirky.terminal/read', {}))).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('SC-25: the scrollback setting', () => {
  test('is declared with its range and refuses values outside it', async () => {
    const listed = await call<{ id: string; value: unknown; minimum?: number; maximum?: number }[]>(client, 'setting.list', {})
    expect(listed.find((s) => s.id === 'setting:quirky.terminal/scrollback')).toMatchObject({ value: 2000, minimum: 500, maximum: 10000 })
    await call(client, 'setting.set', { id: 'setting:quirky.terminal/scrollback', value: 5000 })
    expect(await call(client, 'setting.get', { id: 'setting:quirky.terminal/scrollback' })).toMatchObject({ value: 5000 })
    expect(await code(call(client, 'setting.set', { id: 'setting:quirky.terminal/scrollback', value: 100 }))).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('SC-27: disabling the session plugin', () => {
  test('takes the terminal plugin with it, leaves the PTY session running, and enabling brings both back', async () => {
    const attached = await attach(client, shell.id)
    await call(client, 'plugin.disable', { id: 'quirky.session' })

    const plugins = await call<PluginInfo[]>(client, 'plugin.list', {})
    for (const id of ['quirky.session', 'quirky.terminal']) {
      expect(plugins.find((p) => p.id === id)).toMatchObject({ state: 'disabled' })
    }
    expect(await code(call(client, 'quirky.session/list', {}))).toBe(RpcErrorCode.MethodNotFound)
    expect(await code(call(client, 'quirky.terminal/read', { session: shell.id }))).toBe(RpcErrorCode.MethodNotFound)
    expect(await code(attach(client, shell.id))).toBe(RpcErrorCode.MethodNotFound)
    expect(h.pty.sessions.has(shell.id)).toBe(true)
    expect(h.pty.requests.some((r) => r.type === 'forget' || r.type === 'kill')).toBe(false)
    await waitFor(() => unsubscribes(shell.id) === 1)
    expect(attached.streamId).toBeGreaterThan(0)

    await call(client, 'plugin.enable', { id: 'quirky.session' })
    expect((await call<Session[]>(client, 'quirky.session/list', {})).map((s) => s.id)).toContain(shell.id)
    expect(await call(client, 'quirky.terminal/read', { session: shell.id })).toMatchObject({ lines: expect.any(Array) })
  })
})

describe('the CLI catalog', () => {
  test('SC-17: the terminal group has the term alias and its read and send commands', async () => {
    const api = (await call(client, 'api.describe', {})) as ApiDescription
    expect(api.cli.groups.find((g) => g.plugin === 'quirky.terminal')).toEqual({ plugin: 'quirky.terminal', words: 'terminal', aliases: ['term'] })
    const own = api.cli.commands.filter((c) => c.plugin === 'quirky.terminal')
    expect(own.map((c) => c.words).sort()).toEqual(['terminal read', 'terminal send'])
    expect(own.find((c) => c.words === 'terminal read')!.aliasWords).toEqual(['term read'])
    const names = api.methods.map((m) => m.name)
    for (const name of ['attach', 'detach', 'write', 'resize', 'send', 'read']) expect(names).toContain(`quirky.terminal/${name}`)
    expect(api.methods.find((m) => m.name === 'quirky.terminal/attach')).toMatchObject({ connection: true })
    expect(api.methods.find((m) => m.name === 'quirky.terminal/read')).toMatchObject({ readOnly: true })
  })
})
