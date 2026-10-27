import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  base64ToBytes,
  QuirkyClient,
  RpcErrorCode,
  type ApiDescription,
  type PluginInfo,
  type PluginEvent,
  type PtyRequest,
  type QuirkyEvent,
  type Session
} from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { call, code, createSession, startPluginHarness, TERMINAL_PLUGINS, type PluginSet } from './support'

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
    expect(own.map((c) => c.words).sort()).toEqual([
      'terminal history',
      'terminal kill',
      'terminal kill-all',
      'terminal read',
      'terminal restart-host',
      'terminal send',
      'terminal sessions',
      'terminal snapshot'
    ])
    expect(own.find((c) => c.words === 'terminal read')!.aliasWords).toEqual(['term read'])
    const names = api.methods.map((m) => m.name)
    for (const name of ['attach', 'detach', 'write', 'resize', 'send', 'read']) expect(names).toContain(`quirky.terminal/${name}`)
    expect(api.methods.find((m) => m.name === 'quirky.terminal/attach')).toMatchObject({ connection: true })
    expect(api.methods.find((m) => m.name === 'quirky.terminal/read')).toMatchObject({ readOnly: true })
  })
})

type Attached = {
  streamId: number
  replay: string
  offset: number
  historyCursor: string | null
  cols: number
  rows: number
  restored: boolean
  shellState: string
  live: boolean
}
const attachFull = (c: QuirkyClient, session: string, extra: Record<string, unknown> = {}) =>
  call<Attached>(c, 'quirky.terminal/attach', { session, cols: 80, rows: 24, ...extra })
const requestsOf = <T extends PtyRequest['type']>(type: T) =>
  h.pty.requests.filter((r): r is Extract<PtyRequest, { type: T }> => r.type === type)
const recordOf = (id: string) => call<Session>(client, 'quirky.session/get', { session: id })
const untilEnded = async (id: string) => {
  for (let i = 0; i < 100; i++) {
    if ((await recordOf(id)).status === 'exited') return
    await Bun.sleep(20)
  }
  throw new Error(`${id} never ended`)
}
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: number; data?: unknown }
  }
  throw new Error('expected a failure')
}

describe('attach with restore and replay options', () => {
  test('subscribes in screen mode with the caller historyLines and returns the host fields', async () => {
    const attached = await attachFull(client, shell.id, { historyLines: 500 })
    expect(requestsOf('subscribe').at(-1)).toMatchObject({ sessionId: shell.id, mode: 'screen', historyLines: 500 })
    expect(attached).toMatchObject({ historyCursor: null, cols: 80, rows: 24, restored: false, shellState: 'unsupported', live: true })
  })

  test('a restorable session is restored first, once, and the attach says so', async () => {
    h.pty.exit(shell.id, null, { exitCause: 'host-restart' })
    await untilEnded(shell.id)
    expect(await recordOf(shell.id)).toMatchObject({ status: 'exited', restorable: true })

    const attached = await attachFull(client, shell.id)
    expect(attached).toMatchObject({ restored: true, live: true })
    expect(requestsOf('create').filter((r) => r.restore === true && r.sessionId === shell.id)).toHaveLength(1)
    expect(await recordOf(shell.id)).toMatchObject({ status: 'running', agent: 'shell', restorable: false })

    await attachFull(client, shell.id)
    expect(requestsOf('create').filter((r) => r.restore === true)).toHaveLength(1)
  })

  test('SC-42: an ended session that cannot be restored gives its replay, live false and a silent stream', async () => {
    h.pty.emit(shell.id, 'bye\r\n')
    h.pty.exit(shell.id, 0)
    await untilEnded(shell.id)

    const attached = await attachFull(client, shell.id)
    expect(attached).toMatchObject({ restored: false, live: false })
    expect(text(base64ToBytes(attached.replay))).toBe('bye\r\n')
    expect(requestsOf('create').some((r) => r.restore === true)).toBe(false)

    const received: string[] = []
    client.onTerminalOutput(attached.streamId, (bytes) => received.push(text(bytes)))
    h.pty.emit(shell.id, 'ghost')
    await Bun.sleep(60)
    expect(received).toEqual([])
    await call(client, 'quirky.terminal/detach', { streamId: attached.streamId })
  })

  test('a reconnect fills the gap from a raw subscription', async () => {
    const attached = await attachFull(client, shell.id)
    client.onTerminalOutput(attached.streamId, () => {})
    h.pty.dropConnections()
    h.pty.emit(shell.id, 'b')
    await waitFor(() => requestsOf('subscribe').length >= 2, 5000)
    expect(requestsOf('subscribe').at(-1)).toMatchObject({ mode: 'raw' })
  })
})

describe('SC-22: writing to an ended session', () => {
  test('write and send fail with a conflict that says how to proceed', async () => {
    const restorable = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    h.pty.exit(restorable.id, null, { exitCause: 'host-restart' })
    h.pty.exit(shell.id, 0)
    await untilEnded(restorable.id)
    await untilEnded(shell.id)

    const stopped = `session ${restorable.id} ended when the terminal host stopped; run quirky session restore ${restorable.id}`
    for (const [method, params] of [
      ['write', { data: 'ls\r' }],
      ['send', { text: 'ls', enter: true }]
    ] as const) {
      expect(await failure(call(client, `quirky.terminal/${method}`, { session: restorable.id, ...params }))).toMatchObject({
        code: RpcErrorCode.Conflict,
        message: stopped
      })
      expect(await failure(call(client, `quirky.terminal/${method}`, { session: shell.id, ...params }))).toMatchObject({
        code: RpcErrorCode.Conflict,
        message: `session ${shell.id} has exited`
      })
    }
    expect(h.pty.inputs).toEqual([])
  })

  test('read, snapshot and history still answer for an ended session', async () => {
    h.pty.exit(shell.id, 0)
    await untilEnded(shell.id)
    expect(await call(client, 'quirky.terminal/read', { session: shell.id })).toMatchObject({ lines: expect.any(Array) })
    expect(await call(client, 'quirky.terminal/snapshot', { session: shell.id })).toMatchObject({ cols: 80 })
    expect(await call(client, 'quirky.terminal/history', { session: shell.id })).toEqual({ lines: [], cursor: null })
  })
})

describe('snapshot and history', () => {
  test('snapshot returns the host snapshot', async () => {
    const snapshot = {
      ansi: '\x1b[1mprompt$ \x1b[0m',
      cols: 100,
      rows: 30,
      cursor: { x: 8, y: 0 },
      modes: { alternateScreen: false, bracketedPaste: true, mouseTracking: false, applicationCursor: false },
      cwd: '/tmp/w/api/src',
      title: 'build',
      shellState: 'ready' as const,
      offset: 42
    }
    h.pty.setSnapshotResult(snapshot)
    expect(await call(client, 'quirky.terminal/snapshot', { session: shell.id })).toEqual(snapshot)
    expect(requestsOf('snapshot').at(-1)).toMatchObject({ sessionId: shell.id })
  })

  test('history passes lines, before and format through', async () => {
    h.pty.setHistoryResult({ lines: ['h-1', 'h-2'], cursor: 'c1' })
    expect(await call(client, 'quirky.terminal/history', { session: shell.id, lines: 300, before: 'c0', format: 'ansi' })).toEqual({
      lines: ['h-1', 'h-2'],
      cursor: 'c1'
    })
    expect(requestsOf('history').at(-1)).toMatchObject({ sessionId: shell.id, lines: 300, before: 'c0', format: 'ansi' })
    await call(client, 'quirky.terminal/history', { session: shell.id })
    const bare = requestsOf('history').at(-1)!
    expect(bare.lines).toBeUndefined()
    expect(bare.before).toBeUndefined()
  })

  test('both refuse an unknown session and out-of-range lines', async () => {
    expect(await code(call(client, 'quirky.terminal/snapshot', { session: 's_nope' }))).toBe(RpcErrorCode.NotFound)
    expect(await code(call(client, 'quirky.terminal/history', { session: 's_nope' }))).toBe(RpcErrorCode.NotFound)
    expect(await code(call(client, 'quirky.terminal/history', { session: shell.id, lines: 10001 }))).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('sessions', () => {
  test('lists running sessions with their worktree and a two-segment workspace label', async () => {
    h.pty.exit(claude.id, 0)
    const { sessions } = await call<{ sessions: Record<string, unknown>[] }>(client, 'quirky.terminal/sessions', {})
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      sessionId: shell.id,
      state: 'running',
      shellState: 'unsupported',
      cwd: '/fake/alpha',
      worktreeId: 'wt_main',
      workspace: 'fake/alpha'
    })
    expect(typeof sessions[0]!.pid).toBe('number')
  })

  test('a host session the session plugin does not know has no worktree', async () => {
    await call(client, 'quirky.session/close', { session: claude.id })
    h.pty.sessions.set('s_orphan', { ...h.pty.sessions.get(shell.id)!, info: { ...h.pty.sessions.get(shell.id)!.info, sessionId: 's_orphan', cwd: '/solo' } })
    const { sessions } = await call<{ sessions: { sessionId: string; worktreeId: string | null; workspace: string }[] }>(
      client,
      'quirky.terminal/sessions',
      {}
    )
    expect(sessions.find((s) => s.sessionId === 's_orphan')).toMatchObject({ worktreeId: null, workspace: 'solo' })
  })
})

describe('SC-40: the catalog', () => {
  test('lists the new methods, events and CLI commands with their flags', async () => {
    const api = (await call(client, 'api.describe', {})) as ApiDescription
    const method = (name: string) => api.methods.find((m) => m.name === `quirky.terminal/${name}`)
    for (const name of ['snapshot', 'history', 'sessions']) expect(method(name)).toMatchObject({ readOnly: true })
    for (const name of ['kill', 'killAll', 'restartHost']) expect(method(name)).toMatchObject({ destructive: true })
    expect(method('kill')?.confirm).toBe(
      "Kill this session? Force-quits {session}. Any unsaved work in that pane is lost. This can't be undone."
    )
    expect(method('killAll')?.confirm).toBe('Kill all terminal sessions?')
    expect(method('restartHost')?.confirm).toBe('Restart the terminal service? Open terminals and agents will restart.')
    const events = api.events.filter((e) => e.name.startsWith('quirky.terminal/')).map((e) => e.name)
    expect(events.sort()).toEqual(['quirky.terminal/bell', 'quirky.terminal/commandFinished', 'quirky.terminal/cwd', 'quirky.terminal/notification', 'quirky.terminal/title'])
    const words = api.cli.commands.filter((c) => c.plugin === 'quirky.terminal').map((c) => c.words)
    expect(words).toEqual(expect.arrayContaining(['terminal kill-all', 'terminal restart-host']))
  })

  test('the plugin is active before anything calls it', async () => {
    const plugins = await call<PluginInfo[]>(client, 'plugin.list', {})
    expect(plugins.find((p) => p.id === 'quirky.terminal')).toMatchObject({ state: 'active' })
  })
})

describe('SC-30 to SC-33: facts become events', () => {
  test('each fact kind is emitted under its event name with the session id', async () => {
    const { client: watcher, events } = await h.connectWithEvents('ui')
    expect(watcher).toBeDefined()
    h.pty.fact(shell.id, { kind: 'bell' })
    h.pty.fact(shell.id, { kind: 'command-finished', exitCode: 7 })
    h.pty.fact(shell.id, { kind: 'command-finished', exitCode: null })
    h.pty.fact(shell.id, { kind: 'title', title: 'build' })
    h.pty.fact(shell.id, { kind: 'cwd', cwd: '/tmp/w/api/src' })
    const ours = () => events.filter((e: QuirkyEvent) => e.type.startsWith('quirky.terminal/'))
    await waitFor(() => ours().length === 5)
    expect(ours().map((e) => [e.type, (e as PluginEvent).data])).toEqual([
      ['quirky.terminal/bell', { sessionId: shell.id }],
      ['quirky.terminal/commandFinished', { sessionId: shell.id, exitCode: 7 }],
      ['quirky.terminal/commandFinished', { sessionId: shell.id, exitCode: null }],
      ['quirky.terminal/title', { sessionId: shell.id, title: 'build' }],
      ['quirky.terminal/cwd', { sessionId: shell.id, cwd: '/tmp/w/api/src' }]
    ])
  })
})

describe('SC-23: kill', () => {
  let confirming: Harness
  let asker: QuirkyClient
  let target: Session
  beforeEach(async () => {
    const set: PluginSet = { ...TERMINAL_PLUGINS, real: [...TERMINAL_PLUGINS.real, 'quirky.ask'] }
    confirming = await startPluginHarness(set)
    asker = await confirming.connect('cli')
    target = await createSession(asker, { worktree: 'id:wt_main', agent: 'shell' })
  })
  afterEach(async () => {
    await confirming.cleanup()
  })

  test('without yes it asks first and kills nothing; with yes it kills with the reason killed', async () => {
    const asked = await failure(call(asker, 'quirky.terminal/kill', { session: target.id }))
    expect(asked.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect((asked.data as { action: string }).action).toBe(
      `Kill this session? Force-quits ${target.id}. Any unsaved work in that pane is lost. This can't be undone.`
    )
    expect(confirming.pty.requests.some((r) => r.type === 'kill')).toBe(false)

    expect(await call(asker, 'quirky.terminal/kill', { session: target.id, yes: true })).toEqual({ ok: true })
    const sent = confirming.pty.requests.filter((r) => r.type === 'kill')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ sessionId: target.id, reason: 'killed' })
    expect((sent[0] as { signal?: string }).signal).toBeUndefined()
  })

  test('an unknown session is NotFound', async () => {
    expect(await code(call(asker, 'quirky.terminal/kill', { session: 's_nope', yes: true }))).toBe(RpcErrorCode.NotFound)
  })

  test('SC-24: kill all kills every running session and reports the counts without asking again', async () => {
    const second = await createSession(asker, { worktree: 'id:wt_main', agent: 'shell' })
    const ended = await createSession(asker, { worktree: 'id:wt_main', agent: 'shell' })
    confirming.pty.exit(ended.id, 0)

    const pending = call<{ killedCount: number; remainingCount: number; killedSessionIds: string[] }>(asker, 'quirky.terminal/killAll', {
      yes: true
    })
    await waitFor(() => confirming.pty.requests.filter((r) => r.type === 'kill').length === 2)
    confirming.pty.exit(target.id, 137, { exitSignal: 'SIGKILL', exitCause: 'killed' })
    confirming.pty.exit(second.id, 137, { exitSignal: 'SIGKILL', exitCause: 'killed' })
    const result = await pending
    expect(result.killedCount).toBe(2)
    expect(result.remainingCount).toBe(0)
    expect([...result.killedSessionIds].sort()).toEqual([target.id, second.id].sort())
    expect(confirming.pty.requests.filter((r) => r.type === 'kill').every((r) => (r as { reason?: string }).reason === 'killed')).toBe(true)
  })

  test('kill all with nothing running returns zero', async () => {
    confirming.pty.exit(target.id, 0)
    expect(await call(asker, 'quirky.terminal/killAll', { yes: true })).toEqual({
      killedCount: 0,
      remainingCount: 0,
      killedSessionIds: []
    })
  })

  test('a session that survives the wait is counted as remaining', async () => {
    process.env.QUIRKY_TEST_KILL_POLL_MS = '2'
    try {
      expect(await call(asker, 'quirky.terminal/killAll', { yes: true })).toEqual({
        killedCount: 0,
        remainingCount: 1,
        killedSessionIds: []
      })
      const lists = confirming.pty.requests.filter((r) => r.type === 'list').length
      expect(lists).toBeGreaterThanOrEqual(65)
    } finally {
      delete process.env.QUIRKY_TEST_KILL_POLL_MS
    }
  })

  test('SC-25: restart host replaces the host and returns its pid', async () => {
    const pending = call<{ pid: number }>(asker, 'quirky.terminal/restartHost', { yes: true })
    await waitFor(() => confirming.pty.requests.some((r) => r.type === 'shutdown'))
    confirming.pty.dropConnections()
    expect(await pending).toEqual({ pid: expect.any(Number) })
    expect(confirming.pty.requests.filter((r) => r.type === 'shutdown')).toHaveLength(1)
  })

  test('restart host asks first without yes', async () => {
    const asked = await failure(call(asker, 'quirky.terminal/restartHost', {}))
    expect(asked.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect((asked.data as { action: string }).action).toBe('Restart the terminal service? Open terminals and agents will restart.')
    expect(confirming.pty.requests.some((r) => r.type === 'shutdown')).toBe(false)
  })
})
