import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  base64ToBytes,
  QuirkyClient,
  RpcErrorCode,
  type ApiDescription,
  type ClientStream,
  type PluginCaller,
  type PluginContext,
  type PluginInfo,
  type PluginEvent,
  type PtyRequest,
  type PtySnapshot,
  type PtySubscription,
  type QuirkyEvent,
  type Session
} from '@quirky/protocol'
import { mock } from 'node:test'
import { rpcUrl } from '@quirky/protocol/node'
import { waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { call, code, createSession, startPluginHarness, TERMINAL_PLUGINS, type PluginSet } from './support'
import { groupsInOrder, paneLeaves } from '../src/layout/tree'
import { isTerminalTab } from '../src/layout/types'
import type { Workspace } from '../src/layout/types'
import { TerminalService } from '../src/terminal'

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
  mock.timers.reset()
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
    // the layout, tab, pane, group, quick-command and floating words are pinned in cli-layout.test.ts
    expect(own.map((c) => c.words)).toEqual(expect.arrayContaining([
      'terminal history',
      'terminal kill',
      'terminal kill-all',
      'terminal read',
      'terminal restart-host',
      'terminal send',
      'terminal sessions',
      'terminal snapshot',
      'terminal layout'
    ]))
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
  test('projects each session tab title and worktree name from its owning layout', async () => {
    const mainWorkspace = (await call<{ workspace: Workspace }>(
      client,
      'quirky.terminal/workspace',
      { workspace: 'wt_main', ensure: true }
    )).workspace
    const mainTab = groupsInOrder(mainWorkspace.root)
      .flatMap((group) => group.tabs)
      .filter(isTerminalTab)
      .find((tab) => paneLeaves(tab.root).some((pane) => pane.session === shell.id))
    expect(mainTab?.defaultTitle).toBe('Terminal 1')

    const other = await call<{ session: string; tab: string }>(client, 'quirky.terminal/newTab', {
      workspace: 'wt_other',
      agent: 'shell'
    })
    await call(client, 'quirky.terminal/renameTab', {
      tab: other.tab,
      title: 'Feature shell'
    })

    const records = await call<Session[]>(client, 'quirky.session/list', {})
    expect([
      records.find((session) => session.id === shell.id)?.title,
      records.find((session) => session.id === other.session)?.title
    ]).toEqual(['Shell', 'Shell'])

    const { sessions } = await call<{
      sessions: { sessionId: string; tabTitle: string | null; worktreeName: string | null }[]
    }>(client, 'quirky.terminal/sessions', {})
    expect(sessions.find((session) => session.sessionId === shell.id)).toMatchObject({
      tabTitle: 'Terminal 1',
      worktreeName: 'main'
    })
    expect(sessions.find((session) => session.sessionId === other.session)).toMatchObject({
      tabTitle: 'Feature shell',
      worktreeName: 'other'
    })
  })

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
    const { sessions } = await call<{
      sessions: {
        sessionId: string
        worktreeId: string | null
        workspace: string
        tabTitle: string | null
        worktreeName: string | null
      }[]
    }>(
      client,
      'quirky.terminal/sessions',
      {}
    )
    expect(sessions.find((s) => s.sessionId === 's_orphan')).toMatchObject({
      worktreeId: null,
      workspace: 'solo',
      cwd: '/solo',
      tabTitle: null,
      worktreeName: null
    })
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
    const facts = ['bell', 'commandFinished', 'title', 'cwd'].map((name) => `quirky.terminal/${name}`)
    const ours = () => events.filter((e: QuirkyEvent) => facts.includes(e.type))
    await waitFor(() => ours().length === 5)
    expect(ours().map((e) => [e.type, (e as PluginEvent).data])).toEqual([
      ['quirky.terminal/bell', { sessionId: shell.id }],
      ['quirky.terminal/commandFinished', { sessionId: shell.id, exitCode: 7 }],
      ['quirky.terminal/commandFinished', { sessionId: shell.id, exitCode: null }],
      ['quirky.terminal/title', { sessionId: shell.id, title: 'build' }],
      ['quirky.terminal/cwd', { sessionId: shell.id, cwd: '/tmp/w/api/src' }]
    ])
  })
  const factData = (event: QuirkyEvent) =>
    (event as PluginEvent).data as { sessionId: string; title?: string; exitCode?: number | null }

  test('coalesces a title burst to the first and latest values', async () => {
    const { events } = await h.connectWithEvents('ui')
    const titles = () =>
      events.filter(
        (event: QuirkyEvent) =>
          event.type === 'quirky.terminal/title' && factData(event).sessionId === shell.id
      )
    h.pty.fact(shell.id, { kind: 'title', title: 'a' })
    h.pty.fact(shell.id, { kind: 'title', title: 'b' })
    h.pty.fact(shell.id, { kind: 'title', title: 'c' })
    h.pty.fact(shell.id, { kind: 'title', title: 'd' })
    h.pty.fact(shell.id, { kind: 'title', title: 'e' })
    await waitFor(() => titles().some((event) => factData(event).title === 'a'))
    await Bun.sleep(700)
    expect(titles().map((event) => (event as PluginEvent).data)).toEqual([
      { sessionId: shell.id, title: 'a' },
      { sessionId: shell.id, title: 'e' }
    ])
  })

  test('delivers a later title without waiting for another coalescing window', async () => {
    const { events } = await h.connectWithEvents('ui')
    const titles = () =>
      events.filter(
        (event: QuirkyEvent) =>
          event.type === 'quirky.terminal/title' && factData(event).sessionId === shell.id
      )
    h.pty.fact(shell.id, { kind: 'title', title: 'a' })
    h.pty.fact(shell.id, { kind: 'title', title: 'b' })
    h.pty.fact(shell.id, { kind: 'title', title: 'c' })
    h.pty.fact(shell.id, { kind: 'title', title: 'd' })
    h.pty.fact(shell.id, { kind: 'title', title: 'e' })
    await waitFor(() => titles().some((event) => factData(event).title === 'a'))
    await Bun.sleep(700)
    h.pty.fact(shell.id, { kind: 'title', title: 'f' })
    await waitFor(() => titles().some((event) => factData(event).title === 'f'))
    expect(titles().map((event) => (event as PluginEvent).data)).toEqual([
      { sessionId: shell.id, title: 'a' },
      { sessionId: shell.id, title: 'e' },
      { sessionId: shell.id, title: 'f' }
    ])
  })

  test('coalesces title bursts independently for each session', async () => {
    const { events } = await h.connectWithEvents('ui')
    const other = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    h.pty.fact(shell.id, { kind: 'title', title: 'x1' })
    h.pty.fact(other.id, { kind: 'title', title: 'y1' })
    h.pty.fact(shell.id, { kind: 'title', title: 'x2' })
    h.pty.fact(other.id, { kind: 'title', title: 'y2' })
    h.pty.fact(shell.id, { kind: 'title', title: 'x3' })
    h.pty.fact(other.id, { kind: 'title', title: 'y3' })
    await Bun.sleep(700)
    const titlesFor = (sessionId: string) =>
      events
        .filter(
          (event: QuirkyEvent) =>
            event.type === 'quirky.terminal/title' && factData(event).sessionId === sessionId
        )
        .map((event) => (event as PluginEvent).data)
    expect(titlesFor(shell.id)).toEqual([
      { sessionId: shell.id, title: 'x1' },
      { sessionId: shell.id, title: 'x3' }
    ])
    expect(titlesFor(other.id)).toEqual([
      { sessionId: other.id, title: 'y1' },
      { sessionId: other.id, title: 'y3' }
    ])
  })

  test('coalesces a cwd burst to the first and latest values', async () => {
    const { events } = await h.connectWithEvents('ui')
    h.pty.fact(shell.id, { kind: 'cwd', cwd: '/tmp/a' })
    h.pty.fact(shell.id, { kind: 'cwd', cwd: '/tmp/b' })
    h.pty.fact(shell.id, { kind: 'cwd', cwd: '/tmp/c' })
    await Bun.sleep(700)
    const cwds = events.filter(
      (event: QuirkyEvent) =>
        event.type === 'quirky.terminal/cwd' && factData(event).sessionId === shell.id
    )
    expect(cwds.map((event) => (event as PluginEvent).data)).toEqual([
      { sessionId: shell.id, cwd: '/tmp/a' },
      { sessionId: shell.id, cwd: '/tmp/c' }
    ])
  })

  test('delivers every bell and command-finished occurrence in order', async () => {
    const { events } = await h.connectWithEvents('ui')
    h.pty.fact(shell.id, { kind: 'bell' })
    h.pty.fact(shell.id, { kind: 'command-finished', exitCode: 1 })
    h.pty.fact(shell.id, { kind: 'bell' })
    h.pty.fact(shell.id, { kind: 'command-finished', exitCode: 2 })
    h.pty.fact(shell.id, { kind: 'bell' })
    h.pty.fact(shell.id, { kind: 'command-finished', exitCode: 3 })
    const bells = () => events.filter((event: QuirkyEvent) => event.type === 'quirky.terminal/bell')
    const finished = () =>
      events.filter((event: QuirkyEvent) => event.type === 'quirky.terminal/commandFinished')
    await waitFor(() => bells().length === 3 && finished().length === 3)
    expect(bells()).toHaveLength(3)
    expect(finished().map((event) => factData(event).exitCode)).toEqual([1, 2, 3])
  })

  test('describes coalescing only for title and cwd events', async () => {
    const api = (await call(client, 'api.describe', {})) as ApiDescription
    const event = (id: string) => api.events.find((entry) => entry.name === `quirky.terminal/${id}`)
    for (const id of ['title', 'cwd']) {
      const entry = event(id)
      expect(entry).toBeDefined()
      expect(entry?.coalesce).toEqual(['sessionId'])
      expect(Object.hasOwn(entry ?? {}, 'worktree')).toBe(false)
    }
    for (const id of ['bell', 'commandFinished', 'notification', 'layout']) {
      const entry = event(id)
      expect(entry).toBeDefined()
      expect(Object.hasOwn(entry ?? {}, 'coalesce')).toBe(false)
      expect(Object.hasOwn(entry ?? {}, 'worktree')).toBe(false)
    }
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

const MAX_TAP_BYTES = 4 * 1024 * 1024
const testBytes = (value: string) => new TextEncoder().encode(value)
const testBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

function testSubscription(overrides: Partial<PtySubscription> = {}): PtySubscription {
  return {
    replay: '',
    offset: 0,
    historyCursor: null,
    cols: 80,
    rows: 24,
    shellState: 'unsupported',
    live: true,
    ...overrides
  }
}

function testSnapshot(overrides: Partial<PtySnapshot> = {}): PtySnapshot {
  return {
    ansi: '',
    cols: 80,
    rows: 24,
    cursor: { x: 0, y: 0 },
    modes: { alternateScreen: false, bracketedPaste: false, mouseTracking: false, applicationCursor: false },
    cwd: '/tmp',
    title: null,
    shellState: 'unsupported',
    offset: 0,
    ...overrides
  }
}

type TestStream = {
  connectionId: number
  streamId: number
  sent: Uint8Array[]
  closed: boolean
  closeCount: number
  lagged: boolean
  lagCount: number
  lag(): void
  close(): void
  closeHandlers: Set<() => void>
  lagHandlers: Set<() => void>
}

type TestSubscribe = (sessionId: string, options: { mode: string; historyLines?: number }) => Promise<PtySubscription>
type TestSnapshot = (sessionId: string) => Promise<PtySnapshot>

function createTerminalServiceRig() {
  let sessionStatus: Session['status'] = 'running'
  let sessionKind: Session['kind'] = 'terminal'
  let subscribeHandler: TestSubscribe = async () => testSubscription()
  let snapshotHandler: TestSnapshot = async () => testSnapshot()
  const subscribeCalls: { sessionId: string; options: { mode: string; historyLines?: number } }[] = []
  const snapshotCalls: string[] = []
  const resizeCalls: string[] = []
  const unsubscribed: string[] = []
  const logs: string[] = []
  const streamRecords = new Map<number, TestStream>()
  const connections = new Map<number, {
    closed: boolean
    closeHandlers: Set<() => void>
    streamIds: Set<number>
    connection: {
      id: number
      transport: 'websocket'
      onClose(callback: () => void): () => void
      openStream(): ClientStream
    }
  }>()
  let nextStreamId = 1
  let streamSendHandler: ((stream: TestStream) => void) | undefined

  const context = {
    error(kind: string, message: string) {
      const error = new Error(message) as Error & { code?: number }
      error.code = kind === 'not-found'
        ? RpcErrorCode.NotFound
        : kind === 'invalid-params'
          ? RpcErrorCode.InvalidParams
          : RpcErrorCode.Conflict
      return error
    },
    log(message: string) {
      logs.push(message)
    },
    emit() {},
    async call(method: string, params: Record<string, unknown>) {
      if (method === 'quirky.session/get') {
        return {
          id: typeof params.session === 'string' ? params.session : 's1',
          kind: sessionKind,
          agent: 'shell',
          worktreeId: 'wt_main',
          cwd: '/tmp',
          title: 'Shell',
          status: sessionStatus,
          createdAt: 1,
          lastActivityAt: 1,
          exitCode: null,
          exitSignal: null,
          exitCause: null,
          restorable: false
        } satisfies Session
      }
      throw new Error(`unexpected plugin call: ${method}`)
    },
    pty: {
      resize: async (sessionId: string) => void resizeCalls.push(sessionId),
      list: async () => [{
        sessionId: 's1',
        state: 'running',
        pid: 1,
        alive: true,
        exitCode: null,
        exitSignal: null,
        exitCause: null,
        cols: 80,
        rows: 24,
        argv: [],
        cwd: '/tmp',
        title: null,
        shellState: 'unsupported',
        createdAt: 1,
        offset: 0
      }],
      subscribe: (sessionId: string, options: { mode: string; historyLines?: number }) => {
        subscribeCalls.push({ sessionId, options })
        return subscribeHandler(sessionId, options)
      },
      snapshot: (sessionId: string) => {
        snapshotCalls.push(sessionId)
        return snapshotHandler(sessionId)
      },
      unsubscribe: async (sessionId: string) => void unsubscribed.push(sessionId)
    }
  } as unknown as PluginContext

  const service = new TerminalService(context, async () => new Map())

  function caller(role: 'ui' | 'mobile' = 'ui', connectionId = 1): PluginCaller {
    let state = connections.get(connectionId)
    if (!state) {
      state = {
        closed: false,
        closeHandlers: new Set(),
        streamIds: new Set(),
        connection: {
          id: connectionId,
          transport: 'websocket',
          onClose(callback) {
            if (state!.closed) {
              callback()
              return () => {}
            }
            state!.closeHandlers.add(callback)
            return () => state!.closeHandlers.delete(callback)
          },
          openStream() {
            if (state!.closed) throw new Error('connection is closed')
            const streamId = nextStreamId++
            const record: TestStream = {
              connectionId,
              streamId,
              sent: [],
              closed: false,
              closeCount: 0,
              lagged: false,
              lagCount: 0,
              closeHandlers: new Set(),
              lagHandlers: new Set(),
              close() {
                if (record.closed) return
                record.closed = true
                record.closeCount++
                for (const callback of [...record.closeHandlers]) callback()
              },
              lag() {
                if (record.closed || record.lagged) return
                record.lagged = true
                record.lagCount++
                for (const callback of [...record.lagHandlers]) callback()
              },
            }
            streamRecords.set(streamId, record)
            state!.streamIds.add(streamId)
            const stream = {
              streamId,
              get lagged() {
                return record.lagged
              },
              send(bytes: Uint8Array) {
                if (record.closed || record.lagged) return false
                record.sent.push(bytes.slice())
                streamSendHandler?.(record)
                return true
              },
              onClose(callback: () => void) {
                if (record.closed) callback()
                else record.closeHandlers.add(callback)
              },
              close() {
                record.close()
              },
              lag() {
                record.lag()
              },
              onLag(callback: () => void) {
                if (record.closed) return
                if (record.lagged) callback()
                else record.lagHandlers.add(callback)
              }
            } as unknown as ClientStream
            return stream
          }
        }
      }
      connections.set(connectionId, state)
    }
    return {
      role,
      name: role === 'mobile' ? 'Test phone' : 'Test UI',
      ...(role === 'mobile' ? { deviceId: `device-${connectionId}` } : {}),
      connection: state.connection
    } as unknown as PluginCaller
  }

  function closeConnection(connectionId: number): void {
    const state = connections.get(connectionId)
    if (!state || state.closed) return
    state.closed = true
    for (const callback of [...state.closeHandlers]) callback()
    for (const streamId of state.streamIds) streamRecords.get(streamId)?.close()
  }

  return {
    service,
    caller,
    closeConnection,
    stream: (streamId: number) => streamRecords.get(streamId)!,
    streams: streamRecords,
    subscribeCalls,
    snapshotCalls,
    resizeCalls,
    unsubscribed,
    logs,
    setSubscribe(handler: TestSubscribe) {
      subscribeHandler = handler
    },
    setSnapshot(handler: TestSnapshot) {
      snapshotHandler = handler
    },
    onStreamSend(handler: (stream: TestStream) => void) {
      streamSendHandler = handler
    },
    setSessionStatus(status: Session['status']) {
      sessionStatus = status
    },
    setSessionKind(kind: Session['kind']) {
      sessionKind = kind
    }
  }
}

type TerminalServiceState = {
  bySession: Map<string, Set<unknown>>
  silent: Map<string, Set<unknown>>
  byConnection: Map<number, Map<number, unknown>>
  received: Map<string, number>
  taps: Map<string, { chunks: Uint8Array[]; buffered: number; total: number; overflow: boolean }>
  holds: Map<string, { chunks: Uint8Array[]; buffered: number; total: number; overflow: boolean }>
  mobileHolds: Map<string, { chunks: Uint8Array[]; buffered: number; total: number; overflow: boolean }>
  mobileRecoveryTimers: Map<string, unknown>
  mobileRecoveryPending: Set<string>
  mobileRecoveryQueued: Map<string, symbol>
  mobileRecoveryRunning: Map<string, symbol>
  resyncAt: Map<string, number>
  resyncWaiters: Set<unknown>
  forgotten: Set<string>
}

const terminalState = (service: TerminalService) => service as unknown as TerminalServiceState

type ResyncOutput = {
  streamId: number
  replay: string
  offset: number
  historyCursor: string | null
  cols: number
  rows: number
  shellState: string
  live: boolean
}

function resync(
  service: TerminalService,
  params: Record<string, unknown>,
  caller: PluginCaller
): Promise<ResyncOutput> {
  return (service as unknown as {
    resync(params: Record<string, unknown>, caller: PluginCaller): Promise<ResyncOutput>
  }).resync(params, caller)
}

async function flushMicrotasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve()
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (check()) return
    await Promise.resolve()
  }
  throw new Error('condition did not become true')
}

async function advanceServiceTime(milliseconds: number): Promise<void> {
  mock.timers.tick(milliseconds)
  await flushMicrotasks()
}

describe('TerminalService output recovery', () => {
  test('caps subscribe taps, preserves their total offset, and silences only the overflowing desktop', async () => {
    const rig = createTerminalServiceRig()
    rig.setSubscribe(async () => testSubscription({ offset: 100 }))
    const phone = rig.caller('mobile', 10)
    const phoneAttach = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, phone)

    const subscribeGate = Promise.withResolvers<PtySubscription>()
    rig.setSubscribe(() => subscribeGate.promise)
    const desktop = rig.caller('ui', 11)
    const attaching = rig.service.attach({ session: 's1', cols: 80, rows: 24 }, desktop)
    await waitUntil(() => rig.subscribeCalls.length === 2)

    const tooMuch = new Uint8Array(MAX_TAP_BYTES)
    rig.service.onData('s1', tooMuch)
    rig.service.onData('s1', new Uint8Array([0x61]))
    const tap = terminalState(rig.service).taps.get('s1')!
    expect(tap.buffered).toBe(0)
    expect(tap.total).toBe(MAX_TAP_BYTES + 1)
    expect(tap.overflow).toBe(true)
    expect(tap.chunks.length).toBe(0)

    subscribeGate.resolve(testSubscription({ offset: 100 }))
    const desktopAttach = await attaching
    expect(rig.stream(desktopAttach.streamId)).toMatchObject({ lagged: true, lagCount: 1 })
    expect(rig.stream(desktopAttach.streamId).sent.length).toBe(0)
    expect(rig.stream(phoneAttach.streamId).sent.map((chunk) => chunk.length)).toEqual([MAX_TAP_BYTES, 1])
    expect(terminalState(rig.service).received.get('s1')).toBe(100 + MAX_TAP_BYTES + 1)
    expect(terminalState(rig.service).bySession.get('s1')?.size).toBe(1)
    expect(terminalState(rig.service).silent.get('s1')?.size).toBe(1)
    expect(terminalState(rig.service).byConnection.get(11)?.has(desktopAttach.streamId)).toBe(true)
    expect(rig.unsubscribed).toEqual([])
    rig.service.shutdown()
  })
  test('counts output received after a subscribe tap overflows toward the true PTY offset', async () => {
    const rig = createTerminalServiceRig()
    const subscribeGate = Promise.withResolvers<PtySubscription>()
    const phoneCaller = rig.caller('mobile', 11)
    const caller = rig.caller('ui', 12)
    let phoneAttached: { streamId: number } | undefined
    let attaching: Promise<{ streamId: number }> | undefined

    try {
      rig.setSubscribe(async () => testSubscription({ offset: 100 }))
      phoneAttached = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, phoneCaller)
      rig.setSubscribe(() => subscribeGate.promise)
      attaching = rig.service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
      await waitUntil(() => rig.subscribeCalls.length === 2)

      rig.service.onData('s1', new Uint8Array(MAX_TAP_BYTES + 1))
      const tap = terminalState(rig.service).taps.get('s1')!
      expect(tap.overflow).toBe(true)
      rig.service.onData('s1', testBytes('tail'))
      expect(tap.total).toBe(MAX_TAP_BYTES + 1 + testBytes('tail').length)

      subscribeGate.resolve(testSubscription({ offset: 100 }))
      const attached = await attaching
      expect(terminalState(rig.service).received.get('s1'))
        .toBe(100 + MAX_TAP_BYTES + 1 + testBytes('tail').length)
    } finally {
      subscribeGate.resolve(testSubscription({ offset: 100 }))
      if (attaching) {
        const attached = await attaching.catch(() => undefined)
        if (attached) rig.service.detach({ streamId: attached.streamId }, caller)
      }
      if (phoneAttached) rig.service.detach({ streamId: phoneAttached.streamId }, phoneCaller)
      rig.service.shutdown()
    }
  })

  test('recovers a newly attaching mobile stream when its subscribe tap overflows', async () => {
    const rig = createTerminalServiceRig()
    const subscribeGate = Promise.withResolvers<PtySubscription>()
    const snapshotGate = Promise.withResolvers<PtySnapshot>()
    const caller = rig.caller('mobile', 13)
    rig.setSubscribe(() => subscribeGate.promise)
    rig.setSnapshot(() => snapshotGate.promise)
    let attaching: Promise<{ streamId: number }> | undefined

    try {
      attaching = rig.service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
      await waitUntil(() => rig.subscribeCalls.length === 1)
      rig.service.onData('s1', new Uint8Array(MAX_TAP_BYTES + 1))

      subscribeGate.resolve(testSubscription({ offset: 0 }))
      const attached = await attaching
      await waitUntil(() => rig.snapshotCalls.length === 1)
      snapshotGate.resolve(testSnapshot({ ansi: 'RECOVERED', offset: MAX_TAP_BYTES + 1 }))
      const stream = rig.stream(attached.streamId)
      await waitUntil(() => stream.sent.length === 1)

      expect(stream.sent.map(text)).toEqual(['\x18\x1b\\\x1bc\x1b[3JRECOVERED'])
      expect(stream.lagCount).toBe(0)
      expect(stream.lagged).toBe(false)
    } finally {
      subscribeGate.resolve(testSubscription({ offset: 0 }))
      snapshotGate.resolve(testSnapshot({ ansi: 'RECOVERED', offset: MAX_TAP_BYTES + 1 }))
      if (attaching) {
        const attached = await attaching.catch(() => undefined)
        await flushMicrotasks(50)
        if (attached) rig.service.detach({ streamId: attached.streamId }, caller)
      }
      rig.service.shutdown()
    }
  })


  test('lags a sole desktop when reconnect replay starts before its received offset', async () => {
    const rig = createTerminalServiceRig()
    rig.setSubscribe(async () => testSubscription({ offset: 500_000 }))
    const caller = rig.caller('ui', 20)
    const attached = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
    const stream = rig.stream(attached.streamId)
    rig.setSubscribe(async () => testSubscription({
      replay: testBase64(new Uint8Array(20)),
      offset: 100_000
    }))

    await rig.service.onReconnect()

    expect(stream.lagged).toBe(true)
    expect(stream.lagCount).toBe(1)
    expect(stream.sent.length).toBe(0)
    expect(terminalState(rig.service).bySession.has('s1')).toBe(false)
    expect(terminalState(rig.service).silent.get('s1')?.size).toBe(1)
    expect(terminalState(rig.service).byConnection.get(20)?.has(attached.streamId)).toBe(true)
    expect(terminalState(rig.service).received.has('s1')).toBe(false)
    expect(rig.unsubscribed).toEqual(['s1'])
  })

  test('reconnect gaps lag desktop output and recover phone output in snapshot/tail order', async () => {
    const rig = createTerminalServiceRig()
    rig.setSubscribe(async () => testSubscription({ offset: 500_000 }))
    const desktopCaller = rig.caller('ui', 30)
    const phoneCaller = rig.caller('mobile', 31)
    const desktopAttach = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, desktopCaller)
    const phoneAttach = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, phoneCaller)
    const desktop = rig.stream(desktopAttach.streamId)
    const phone = rig.stream(phoneAttach.streamId)
    const subscribeGate = Promise.withResolvers<PtySubscription>()
    const snapshotGate = Promise.withResolvers<PtySnapshot>()
    rig.setSubscribe(() => subscribeGate.promise)
    rig.setSnapshot(() => snapshotGate.promise)

    const reconnecting = rig.service.onReconnect()
    await waitUntil(() => rig.subscribeCalls.length === 3)
    subscribeGate.resolve(testSubscription({
      replay: testBase64(new Uint8Array(262_144).fill(0x72)),
      offset: 900_000
    }))
    await waitUntil(() => rig.snapshotCalls.length === 1)
    expect(desktop.lagged).toBe(true)
    expect(desktop.lagCount).toBe(1)
    expect(desktop.sent.length).toBe(0)
    expect(phone.lagged).toBe(false)
    expect(phone.sent.length).toBe(0)
    expect(terminalState(rig.service).bySession.get('s1')?.size).toBe(1)
    expect(terminalState(rig.service).silent.get('s1')?.size).toBe(1)
    expect(rig.unsubscribed).toEqual([])

    rig.service.onData('s1', testBytes('pre'))
    expect(phone.sent.length).toBe(0)
    rig.service.onData('s1', testBytes('post'))
    snapshotGate.resolve(testSnapshot({ ansi: 'SNAP', offset: 900_003 }))
    await reconnecting
    await flushMicrotasks()

    expect(phone.sent.map((chunk) => chunk.length)).toEqual([testBytes('\x18\x1b\\\x1bc\x1b[3JSNAP').length, 4])
    expect(phone.sent.map(text)).toEqual([
      '\x18\x1b\\\x1bc\x1b[3JSNAP',
      'post'
    ])
    expect(phone.lagged).toBe(false)
    expect(terminalState(rig.service).mobileHolds.has('s1')).toBe(false)
    rig.service.shutdown()
  })

  test('bounds reconnect holds without losing the host offset used for the phone tail', async () => {
    const rig = createTerminalServiceRig()
    rig.setSubscribe(async () => testSubscription({ offset: 500_000 }))
    const desktopCaller = rig.caller('ui', 40)
    const phoneCaller = rig.caller('mobile', 41)
    const desktopAttach = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, desktopCaller)
    const phoneAttach = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, phoneCaller)
    const desktop = rig.stream(desktopAttach.streamId)
    const phone = rig.stream(phoneAttach.streamId)
    const subscribeGate = Promise.withResolvers<PtySubscription>()
    const snapshotGate = Promise.withResolvers<PtySnapshot>()
    rig.setSubscribe(() => subscribeGate.promise)
    rig.setSnapshot(() => snapshotGate.promise)

    const reconnecting = rig.service.onReconnect()
    await waitUntil(() => rig.subscribeCalls.length === 3)
    const heldBytes = new Uint8Array(MAX_TAP_BYTES + 100)
    rig.service.onData('s1', heldBytes)
    const hold = terminalState(rig.service).holds.get('s1')
    expect(hold?.buffered).toBe(0)
    expect(hold?.total).toBe(heldBytes.length)
    expect(hold?.overflow).toBe(true)
    expect(hold?.chunks?.length).toBe(0)
    expect(desktop.sent.length).toBe(0)
    expect(phone.sent.length).toBe(0)

    subscribeGate.resolve(testSubscription({ offset: 500_000 }))
    await waitUntil(() => rig.snapshotCalls.length === 1)
    expect(terminalState(rig.service).received.get('s1')).toBe(500_000 + heldBytes.length)
    expect(desktop.lagged).toBe(true)
    expect(desktop.lagCount).toBe(1)
    expect(desktop.sent.length).toBe(0)
    rig.service.onData('s1', testBytes('tail'))
    snapshotGate.resolve(testSnapshot({ ansi: 'HELD-SNAP', offset: 500_000 + heldBytes.length }))
    await reconnecting
    await flushMicrotasks()

    expect(phone.sent.map((chunk) => chunk.length)).toEqual([testBytes('\x18\x1b\\\x1bc\x1b[3JHELD-SNAP').length, 4])
    expect(phone.sent.map(text)).toEqual([
      '\x18\x1b\\\x1bc\x1b[3JHELD-SNAP',
      'tail'
    ])
    expect(phone.lagged).toBe(false)
    rig.service.shutdown()
  })
  test('host lag silences desktops and reacquires the phone subscription before snapshot recovery', async () => {
    const rig = createTerminalServiceRig()
    rig.setSubscribe(async () => testSubscription({ offset: 100 }))
    const firstDesktopCaller = rig.caller('ui', 32)
    const secondDesktopCaller = rig.caller('ui', 33)
    const phoneCaller = rig.caller('mobile', 34)
    const firstDesktop = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, firstDesktopCaller)
    const secondDesktop = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, secondDesktopCaller)
    const phoneAttach = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, phoneCaller)
    const firstDesktopStream = rig.stream(firstDesktop.streamId)
    const secondDesktopStream = rig.stream(secondDesktop.streamId)
    const phoneStream = rig.stream(phoneAttach.streamId)
    phoneStream.sent.length = 0

    const subscribeGate = Promise.withResolvers<PtySubscription>()
    const snapshotGate = Promise.withResolvers<PtySnapshot>()
    rig.setSubscribe((_sessionId, options) =>
      options.mode === 'raw' ? subscribeGate.promise : Promise.resolve(testSubscription({ offset: 100 }))
    )
    rig.setSnapshot(() => snapshotGate.promise)
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    try {
      rig.service.onLagged('s1')
      await waitUntil(() => rig.subscribeCalls.length === 4)
      expect(rig.subscribeCalls[3]?.options.mode).toBe('raw')
      expect(rig.snapshotCalls).toEqual([])
      expect(firstDesktopStream).toMatchObject({ lagged: true, lagCount: 1, sent: [] })
      expect(secondDesktopStream).toMatchObject({ lagged: true, lagCount: 1, sent: [] })
      expect(phoneStream).toMatchObject({ lagged: false, closed: false })
      expect(terminalState(rig.service).bySession.get('s1')?.size).toBe(1)
      expect(terminalState(rig.service).byConnection.get(34)?.has(phoneAttach.streamId)).toBe(true)

      rig.service.onData('s1', testBytes('a'))
      subscribeGate.resolve(testSubscription({ offset: 10 }))
      await waitUntil(() => rig.snapshotCalls.length === 1)
      rig.service.onData('s1', testBytes('bc'))
      snapshotGate.resolve(testSnapshot({ ansi: 'PHONE', offset: 11 }))
      await waitUntil(() => phoneStream.sent.length === 2)

      expect(phoneStream.sent.map(text)).toEqual([
        '\x18\x1b\\\x1bc\x1b[3JPHONE',
        'bc'
      ])
      expect(phoneStream.lagged).toBe(false)
      expect(phoneStream.closed).toBe(false)
      expect(rig.unsubscribed).toEqual([])
    } finally {
      subscribeGate.resolve(testSubscription({ offset: 10 }))
      snapshotGate.resolve(testSnapshot({ ansi: 'PHONE', offset: 11 }))
      rig.service.shutdown()
      mock.timers.reset()
    }
  })

  test('host lag releases a desktop-only hold once and still permits resync', async () => {
    const rig = createTerminalServiceRig()
    const caller = rig.caller('ui', 35)
    const original = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
    const oldStream = rig.stream(original.streamId)

    rig.service.onLagged('s1')
    rig.service.onLagged('s1')

    expect(oldStream).toMatchObject({ lagged: true, lagCount: 1, closed: false })
    expect(terminalState(rig.service).bySession.has('s1')).toBe(false)
    expect(terminalState(rig.service).silent.get('s1')?.size).toBe(1)
    expect(rig.unsubscribed).toEqual(['s1'])

    rig.setSubscribe(async () => testSubscription({ replay: testBase64(testBytes('current')), offset: 7 }))
    const replacement = await resync(rig.service, { streamId: original.streamId }, caller)
    expect(replacement).toMatchObject({ replay: testBase64(testBytes('current')), offset: 7 })
    expect(oldStream.closed).toBe(true)
    expect(terminalState(rig.service).byConnection.get(35)?.has(replacement.streamId)).toBe(true)
    rig.service.shutdown()
  })

  test('host lag invalidates pending initial, resync, and reconnect subscriptions', async () => {
    const attaching = createTerminalServiceRig()
    const attachGate = Promise.withResolvers<PtySubscription>()
    const attachCaller = attaching.caller('mobile', 36)
    let initialSubscribes = 0
    attaching.setSubscribe(() => {
      initialSubscribes++
      return initialSubscribes === 1
        ? attachGate.promise
        : Promise.resolve(testSubscription({
          replay: testBase64(testBytes('current generation')),
          offset: 12
        }))
    })
    const pendingAttach = attaching.service.attach({ session: 's1', cols: 80, rows: 24 }, attachCaller)
    await waitUntil(() => attaching.subscribeCalls.length === 1)
    attaching.service.onData('s1', testBytes('before-gap'))
    attaching.service.onLagged('s1')
    attachGate.resolve(testSubscription({ replay: testBase64(testBytes('stale')), offset: 11 }))
    const currentAttach = await pendingAttach
    expect(currentAttach).toMatchObject({
      replay: testBase64(testBytes('current generation')),
      offset: 12
    })
    expect(attaching.subscribeCalls).toHaveLength(2)
    expect(terminalState(attaching.service).bySession.get('s1')?.size).toBe(1)
    expect(terminalState(attaching.service).byConnection.get(36)?.has(currentAttach.streamId)).toBe(true)
    expect(attaching.stream(currentAttach.streamId).sent).toEqual([])
    attaching.service.shutdown()

    const resyncing = createTerminalServiceRig()
    const desktopCaller = resyncing.caller('ui', 37)
    const original = await resyncing.service.attach({ session: 's1', cols: 80, rows: 24 }, desktopCaller)
    const resyncGate = Promise.withResolvers<PtySubscription>()
    resyncing.setSubscribe(() => resyncGate.promise)
    const pendingResync = resync(resyncing.service, { streamId: original.streamId }, desktopCaller)
    await waitUntil(() => resyncing.subscribeCalls.length === 2)
    resyncing.service.onLagged('s1')
    resyncGate.resolve(testSubscription({ replay: testBase64(testBytes('stale')), offset: 11 }))
    await expect(pendingResync).rejects.toThrow()
    expect(terminalState(resyncing.service).byConnection.get(37)?.size).toBe(1)
    expect(terminalState(resyncing.service).silent.get('s1')?.size).toBe(1)
    resyncing.service.shutdown()

    const reconnecting = createTerminalServiceRig()
    const phoneCaller = reconnecting.caller('mobile', 38)
    const phoneAttach = await reconnecting.service.attach({ session: 's1', cols: 80, rows: 24 }, phoneCaller)
    const staleReconnect = Promise.withResolvers<PtySubscription>()
    const newRecovery = Promise.withResolvers<PtySubscription>()
    reconnecting.setSubscribe((_sessionId, options) => {
      if (options.mode === 'screen') return Promise.resolve(testSubscription())
      return reconnecting.subscribeCalls.length === 2 ? staleReconnect.promise : newRecovery.promise
    })
    const pendingReconnect = reconnecting.service.onReconnect()
    await waitUntil(() => reconnecting.subscribeCalls.length === 2)
    reconnecting.service.onLagged('s1')
    staleReconnect.resolve(testSubscription({ replay: testBase64(testBytes('stale')), offset: 100 }))
    await pendingReconnect
    await waitUntil(() => reconnecting.subscribeCalls.length === 3)
    expect(reconnecting.snapshotCalls).toEqual([])
    reconnecting.service.shutdown()
    newRecovery.resolve(testSubscription({ offset: 100 }))
    await flushMicrotasks()
    expect(reconnecting.snapshotCalls).toEqual([])
    expect(reconnecting.stream(phoneAttach.streamId).sent).toEqual([])
  })
})

describe('TerminalService phone recovery lifecycle', () => {
  test('keeps phone output suppressed after snapshot failure', async () => {
    const failed = createTerminalServiceRig()
    const failedCaller = failed.caller('mobile', 50)
    const failedAttach = await failed.service.attach({ session: 's1', cols: 80, rows: 24 }, failedCaller)
    const failedSnapshot = Promise.withResolvers<PtySnapshot>()
    failed.setSubscribe(async () => testSubscription({ offset: 10 }))
    failed.setSnapshot(() => failedSnapshot.promise)
    failed.service.onLagged('s1')
    await waitUntil(() => failed.snapshotCalls.length === 1)
    failed.service.onData('s1', testBytes('live'))
    failedSnapshot.reject(new Error('snapshot unavailable'))
    await waitUntil(() => failed.logs.length === 1)
    expect(failed.logs).toEqual(['could not recover mobile terminal output of s1: snapshot unavailable'])
    expect(failed.stream(failedAttach.streamId).sent).toEqual([])
    expect(terminalState(failed.service).mobileHolds.has('s1')).toBe(true)
    failed.service.shutdown()
  })

  test('sends nothing after detach or shutdown during snapshot recovery', async () => {
    const detached = createTerminalServiceRig()
    const detachedCaller = detached.caller('mobile', 51)
    const detachedAttach = await detached.service.attach({ session: 's1', cols: 80, rows: 24 }, detachedCaller)
    const detachedSnapshot = Promise.withResolvers<PtySnapshot>()
    detached.setSubscribe(async () => testSubscription({ offset: 10 }))
    detached.setSnapshot(() => detachedSnapshot.promise)
    detached.service.onLagged('s1')
    await waitUntil(() => detached.snapshotCalls.length === 1)
    detached.service.detach({ streamId: detachedAttach.streamId }, detachedCaller)
    expect(detached.unsubscribed).toEqual(['s1'])
    detachedSnapshot.resolve(testSnapshot({ ansi: 'LATE', offset: 10 }))
    await flushMicrotasks()
    expect(detached.stream(detachedAttach.streamId).sent).toEqual([])
    expect(terminalState(detached.service).mobileHolds.has('s1')).toBe(false)
    detached.service.shutdown()

    const stopped = createTerminalServiceRig()
    const stoppedAttach = await stopped.service.attach(
      { session: 's1', cols: 80, rows: 24 },
      stopped.caller('mobile', 52)
    )
    const stoppedSnapshot = Promise.withResolvers<PtySnapshot>()
    stopped.setSubscribe(async () => testSubscription({ offset: 10 }))
    stopped.setSnapshot(() => stoppedSnapshot.promise)
    stopped.service.onLagged('s1')
    await waitUntil(() => stopped.snapshotCalls.length === 1)
    stopped.service.shutdown()
    expect(terminalState(stopped.service).mobileHolds.size).toBe(0)
    stoppedSnapshot.resolve(testSnapshot({ ansi: 'LATE', offset: 10 }))
    await flushMicrotasks()
    expect(stopped.stream(stoppedAttach.streamId).sent).toEqual([])
    expect(terminalState(stopped.service).mobileRecoveryTimers.size).toBe(0)
  })

  test('ignores late recovery snapshots after exit or session removal', async () => {
    const exited = createTerminalServiceRig()
    const exitedCaller = exited.caller('mobile', 53)
    const exitedAttach = await exited.service.attach({ session: 's1', cols: 80, rows: 24 }, exitedCaller)
    const exitedSnapshot = Promise.withResolvers<PtySnapshot>()
    exited.setSubscribe(async () => testSubscription({ offset: 10 }))
    exited.setSnapshot(() => exitedSnapshot.promise)
    exited.service.onLagged('s1')
    await waitUntil(() => exited.snapshotCalls.length === 1)
    exited.service.onExit('s1')
    exitedSnapshot.resolve(testSnapshot({ ansi: 'LATE', offset: 10 }))
    await flushMicrotasks()
    expect(exited.stream(exitedAttach.streamId).sent).toEqual([])
    expect(terminalState(exited.service).mobileHolds.has('s1')).toBe(false)
    exited.service.shutdown()

    const removed = createTerminalServiceRig()
    const removedCaller = removed.caller('mobile', 54)
    const removedAttach = await removed.service.attach({ session: 's1', cols: 80, rows: 24 }, removedCaller)
    const removedSnapshot = Promise.withResolvers<PtySnapshot>()
    removed.setSubscribe(async () => testSubscription({ offset: 10 }))
    removed.setSnapshot(() => removedSnapshot.promise)
    removed.service.onLagged('s1')
    await waitUntil(() => removed.snapshotCalls.length === 1)
    removed.service.onEvent({
      type: 'quirky.session/removed',
      data: { sessionId: 's1' }
    } as PluginEvent)
    removedSnapshot.resolve(testSnapshot({ ansi: 'LATE', offset: 10 }))
    await flushMicrotasks()
    expect(removed.stream(removedAttach.streamId).sent).toEqual([])
    expect(terminalState(removed.service).mobileHolds.has('s1')).toBe(false)
    removed.service.shutdown()
  })

  test('coalesces in-flight gaps to one trailing recovery at the two-second boundary', async () => {
    const rig = createTerminalServiceRig()
    const caller = rig.caller('mobile', 55)
    const attached = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
    const firstSubscribe = Promise.withResolvers<PtySubscription>()
    let rawSubscribes = 0
    rig.setSubscribe((_sessionId, options) => {
      if (options.mode !== 'raw') return Promise.resolve(testSubscription())
      rawSubscribes++
      return rawSubscribes === 1
        ? firstSubscribe.promise
        : Promise.resolve(testSubscription({ offset: 20 }))
    })
    rig.setSnapshot(async () => testSnapshot({ ansi: 'CURRENT', offset: 20 }))
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    try {
      rig.service.onLagged('s1')
      await waitUntil(() => rawSubscribes === 1)
      rig.service.onLagged('s1')
      rig.service.onLagged('s1')
      firstSubscribe.resolve(testSubscription({ offset: 10 }))
      await flushMicrotasks()
      expect(rig.unsubscribed).toEqual([])
      expect(rig.snapshotCalls).toEqual([])
      expect(rig.stream(attached.streamId).sent).toEqual([])
      await advanceServiceTime(1_999)
      expect(rawSubscribes).toBe(1)
      await advanceServiceTime(1)
      await waitUntil(() => rig.stream(attached.streamId).sent.length === 1)
      expect(rawSubscribes).toBe(2)
      expect(rig.snapshotCalls).toEqual(['s1'])
      expect(rig.stream(attached.streamId).sent.map(text)).toEqual(['\x18\x1b\\\x1bc\x1b[3JCURRENT'])
    } finally {
      firstSubscribe.resolve(testSubscription({ offset: 10 }))
      rig.service.shutdown()
      mock.timers.reset()
    }
  })
  test('unsubscribes a late mobile recovery after the last phone detaches or shutdown', async () => {
    const detached = createTerminalServiceRig()
    const detachedCaller = detached.caller('mobile', 56)
    const detachedAttach = await detached.service.attach({ session: 's1', cols: 80, rows: 24 }, detachedCaller)
    const detachedSubscribe = Promise.withResolvers<PtySubscription>()
    detached.setSubscribe((_sessionId, options) => options.mode === 'raw'
      ? detachedSubscribe.promise
      : Promise.resolve(testSubscription()))
    detached.service.onLagged('s1')
    await waitUntil(() => detached.subscribeCalls.some((call) => call.options.mode === 'raw'))
    detached.service.detach({ streamId: detachedAttach.streamId }, detachedCaller)
    expect(detached.unsubscribed).toEqual([])
    detachedSubscribe.resolve(testSubscription({ offset: 10 }))
    await flushMicrotasks()
    expect(detached.unsubscribed).toEqual(['s1'])
    expect(detached.snapshotCalls).toEqual([])
    detached.service.shutdown()

    const stopped = createTerminalServiceRig()
    const stoppedAttach = await stopped.service.attach(
      { session: 's1', cols: 80, rows: 24 },
      stopped.caller('mobile', 57)
    )
    const stoppedSubscribe = Promise.withResolvers<PtySubscription>()
    stopped.setSubscribe((_sessionId, options) => options.mode === 'raw'
      ? stoppedSubscribe.promise
      : Promise.resolve(testSubscription()))
    stopped.service.onLagged('s1')
    await waitUntil(() => stopped.subscribeCalls.some((call) => call.options.mode === 'raw'))
    stopped.service.shutdown()
    expect(stopped.unsubscribed).toEqual([])
    stoppedSubscribe.resolve(testSubscription({ offset: 10 }))
    await flushMicrotasks()
    expect(stopped.unsubscribed).toEqual(['s1'])
    expect(stopped.snapshotCalls).toEqual([])
    expect(stopped.stream(stoppedAttach.streamId).closed).toBe(true)
  })
  test('releases an in-flight mobile recovery after exit only when no owner remains', async () => {
    const exited = createTerminalServiceRig()
    const exitedCaller = exited.caller('mobile', 65)
    const exitedAttach = await exited.service.attach({ session: 's1', cols: 80, rows: 24 }, exitedCaller)
    const exitedSubscribe = Promise.withResolvers<PtySubscription>()
    exited.setSubscribe((_sessionId, options) => options.mode === 'raw'
      ? exitedSubscribe.promise
      : Promise.resolve(testSubscription()))
    exited.service.onLagged('s1')
    await waitUntil(() => exited.subscribeCalls.some((call) => call.options.mode === 'raw'))
    exited.service.onExit('s1')
    expect(exited.stream(exitedAttach.streamId).closed).toBe(true)
    expect(exited.unsubscribed).toEqual([])
    exitedSubscribe.resolve(testSubscription({ offset: 10 }))
    await flushMicrotasks()
    expect(exited.unsubscribed).toEqual(['s1'])
    exited.service.shutdown()

  })


  test('coalesces host gaps and retries subscribe or snapshot failures at two-second intervals', async () => {
    const rig = createTerminalServiceRig()
    const caller = rig.caller('mobile', 60)
    const attached = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
    const stream = rig.stream(attached.streamId)
    const staleSnapshot = Promise.withResolvers<PtySnapshot>()
    const finalSnapshot = Promise.withResolvers<PtySnapshot>()
    let rawSubscribes = 0
    let snapshots = 0
    rig.setSubscribe((_sessionId, options) => {
      if (options.mode !== 'raw') return Promise.resolve(testSubscription())
      rawSubscribes++
      if (rawSubscribes === 1) return Promise.reject(new Error('subscribe unavailable'))
      return Promise.resolve(testSubscription({ offset: 30 }))
    })
    rig.setSnapshot(() => {
      snapshots++
      if (snapshots === 1) return staleSnapshot.promise
      if (snapshots === 2) throw new Error('snapshot unavailable')
      if (snapshots === 3) return finalSnapshot.promise
      return Promise.resolve(testSnapshot({ ansi: 'FINAL', offset: 31 }))
    })
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    try {
      rig.service.onLagged('s1')
      await waitUntil(() => rig.logs.length === 1)
      expect(rawSubscribes).toBe(1)
      expect(snapshots).toBe(0)
      rig.service.onData('s1', testBytes('before retry'))
      expect(stream.sent).toEqual([])
      await advanceServiceTime(1_999)
      expect(rawSubscribes).toBe(1)
      await advanceServiceTime(1)
      await waitUntil(() => snapshots === 1)
      expect(rawSubscribes).toBe(2)

      rig.service.onData('s1', testBytes('during stale snapshot'))
      rig.service.onLagged('s1')
      rig.service.onLagged('s1')
      staleSnapshot.resolve(testSnapshot({ ansi: 'STALE', offset: 30 }))
      await flushMicrotasks()
      expect(stream.sent).toEqual([])
      await advanceServiceTime(1_999)
      expect(rawSubscribes).toBe(2)
      await advanceServiceTime(1)
      await waitUntil(() => snapshots === 2)
      expect(rawSubscribes).toBe(3)
      await waitUntil(() => rig.logs.length === 2)
      expect(stream.sent).toEqual([])

      await advanceServiceTime(1_999)
      expect(rawSubscribes).toBe(3)
      await advanceServiceTime(1)
      await waitUntil(() => snapshots === 3)
      expect(rawSubscribes).toBe(4)
      rig.service.onData('s1', testBytes('abcd'))
      finalSnapshot.resolve(testSnapshot({ ansi: 'FINAL', offset: 31 }))
      await waitUntil(() => stream.sent.length === 2)

      expect(stream.sent.map(text)).toEqual([
        '\x18\x1b\\\x1bc\x1b[3JFINAL',
        'bcd'
      ])
      expect(stream.lagged).toBe(false)
      expect(terminalState(rig.service).mobileRecoveryTimers.size).toBe(0)
    } finally {
      staleSnapshot.resolve(testSnapshot({ ansi: 'STALE', offset: 30 }))
      finalSnapshot.resolve(testSnapshot({ ansi: 'FINAL', offset: 31 }))
      rig.service.shutdown()
      mock.timers.reset()
    }
  })
  test('clears a pending mobile recovery cooldown timer on shutdown', async () => {
    const rig = createTerminalServiceRig()
    const attached = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, rig.caller('mobile', 58))
    let rawSubscribes = 0
    rig.setSubscribe((_sessionId, options) => {
      if (options.mode !== 'raw') return Promise.resolve(testSubscription())
      rawSubscribes++
      return Promise.resolve(testSubscription({ offset: 10 }))
    })
    rig.setSnapshot(async () => testSnapshot({ ansi: 'CURRENT', offset: 10 }))
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    try {
      rig.service.onLagged('s1')
      await waitUntil(() => rig.stream(attached.streamId).sent.length === 1)
      await waitUntil(() => !terminalState(rig.service).mobileRecoveryRunning.has('s1'))
      rig.service.onLagged('s1')
      expect(terminalState(rig.service).mobileRecoveryTimers.size).toBe(1)

      rig.service.shutdown()
      expect(terminalState(rig.service).mobileRecoveryTimers.size).toBe(0)
      await advanceServiceTime(2_000)
      expect(rawSubscribes).toBe(1)
      expect(rig.snapshotCalls).toEqual(['s1'])
    } finally {
      rig.service.shutdown()
      mock.timers.reset()
    }
  })

  test('does not retry a mobile attach when a gap follows attachment registration', async () => {
    const rig = createTerminalServiceRig()
    const caller = rig.caller('mobile', 59)
    let replayed = false
    let gapQueued = false
    const recoverySnapshot = Promise.withResolvers<PtySnapshot>()
    rig.setSubscribe((sessionId, options) => {
      if (options.mode === 'screen' && !replayed) {
        replayed = true
        rig.service.onData(sessionId, testBytes('replay tail'))
      }
      return Promise.resolve(testSubscription({ offset: 0 }))
    })
    rig.setSnapshot(() => recoverySnapshot.promise)
    rig.onStreamSend(() => {
      if (gapQueued) return
      gapQueued = true
      queueMicrotask(() => rig.service.onLagged('s1'))
    })

    const attached = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
    await waitUntil(() => rig.snapshotCalls.length === 1)
    expect(rig.subscribeCalls.filter((call) => call.options.mode === 'screen')).toHaveLength(1)
    expect(rig.stream(attached.streamId).sent.map(text)).toEqual(['replay tail'])
    expect(terminalState(rig.service).bySession.get('s1')?.size).toBe(1)
    rig.service.shutdown()
    recoverySnapshot.resolve(testSnapshot({ ansi: 'LATE', offset: 0 }))
    await flushMicrotasks()
  })

  test('does not close a registered resync replacement after a gap', async () => {
    const rig = createTerminalServiceRig()
    const caller = rig.caller('ui', 64)
    rig.setSubscribe(async () => testSubscription())
    const original = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
    rig.stream(original.streamId).lag()

    let replayed = false
    let gapQueued = false
    rig.setSubscribe((sessionId, options) => {
      if (options.mode === 'screen' && !replayed) {
        replayed = true
        rig.service.onData(sessionId, testBytes('replay tail'))
      }
      return Promise.resolve(testSubscription({ offset: 0 }))
    })
    rig.onStreamSend((stream) => {
      if (stream.streamId === original.streamId || gapQueued) return
      gapQueued = true
      queueMicrotask(() => rig.service.onLagged('s1'))
    })

    const replacement = await resync(rig.service, { streamId: original.streamId }, caller)
    await flushMicrotasks()
    const registered = terminalState(rig.service).byConnection.get(64)?.get(replacement.streamId)
    expect(registered).toBeDefined()
    expect(rig.stream(replacement.streamId).closed).toBe(false)
    expect(rig.stream(replacement.streamId).lagged).toBe(true)
    expect(rig.stream(original.streamId).closed).toBe(true)
    rig.service.shutdown()
  })

  test('fences a trailing phone snapshot behind a screen subscribe without replaying its byte twice', async () => {
    const rig = createTerminalServiceRig()
    const desktopCaller = rig.caller('ui', 61)
    const phoneCaller = rig.caller('mobile', 62)
    rig.setSubscribe(async () => testSubscription({ offset: 100 }))
    const desktop = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, desktopCaller)
    const phone = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, phoneCaller)
    const phoneStream = rig.stream(phone.streamId)
    const firstSnapshot = Promise.withResolvers<PtySnapshot>()
    const trailingSnapshot = Promise.withResolvers<PtySnapshot>()
    const screenSubscribe = Promise.withResolvers<PtySubscription>()
    let snapshots = 0
    let reconnectOffset = 110
    rig.setSnapshot(() => {
      snapshots++
      return snapshots === 1 ? firstSnapshot.promise : trailingSnapshot.promise
    })
    rig.setSubscribe((_sessionId, options) =>
      options.mode === 'screen'
        ? screenSubscribe.promise
        : Promise.resolve(testSubscription({ offset: reconnectOffset }))
    )
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    let screenResync: Promise<ResyncOutput> | undefined
    try {
      const firstReconnect = rig.service.onReconnect()
      await waitUntil(() => rig.snapshotCalls.length === 1)
      await advanceServiceTime(500)
      reconnectOffset = 120
      const secondReconnect = rig.service.onReconnect()
      firstSnapshot.resolve(testSnapshot({ ansi: 'FIRST', offset: 110 }))
      await firstReconnect
      await secondReconnect
      await flushMicrotasks()
      expect(terminalState(rig.service).mobileRecoveryTimers.size).toBe(1)

      screenResync = resync(rig.service, { streamId: desktop.streamId }, desktopCaller)
      await waitUntil(() => rig.subscribeCalls.length === 5)
      await advanceServiceTime(1_500)
      expect(rig.snapshotCalls).toHaveLength(1)
      expect(terminalState(rig.service).mobileRecoveryQueued.size).toBe(1)

      rig.service.onData('s1', testBytes('x'))
      screenSubscribe.resolve(testSubscription({
        replay: testBase64(testBytes('x')),
        offset: 121
      }))
      await screenResync
      await waitUntil(() => rig.snapshotCalls.length === 2)
      trailingSnapshot.resolve(testSnapshot({ ansi: 'SNAPx', offset: 121 }))
      await waitUntil(() => phoneStream.sent.length === 2)
      expect(terminalState(rig.service).mobileRecoveryQueued.size).toBe(0)

      const reset = '\x18\x1b\\\x1bc\x1b[3J'
      let visible = ''
      for (const chunk of phoneStream.sent) {
        const output = text(chunk)
        const resetAt = output.indexOf(reset)
        if (resetAt >= 0) visible = output.slice(resetAt + reset.length)
        else visible += output
      }
      expect(visible).toBe('SNAPx')
    } finally {
      screenSubscribe.resolve(testSubscription({
        replay: testBase64(testBytes('x')),
        offset: 121
      }))
      firstSnapshot.resolve(testSnapshot({ ansi: 'FIRST', offset: 120 }))
      trailingSnapshot.resolve(testSnapshot({ ansi: 'SNAPx', offset: 121 }))
      await flushMicrotasks()
      rig.service.shutdown()
      if (screenResync) await screenResync.catch(() => {})
      mock.timers.reset()
    }
  })

  test('fences trailing recovery behind the PTY reconnect subscribe and renders its held byte once', async () => {
    const rig = createTerminalServiceRig()
    const phoneCaller = rig.caller('mobile', 63)
    rig.setSubscribe(async () => testSubscription({ offset: 100 }))
    const attached = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, phoneCaller)
    const phoneStream = rig.stream(attached.streamId)
    const firstSnapshot = Promise.withResolvers<PtySnapshot>()
    const trailingSnapshot = Promise.withResolvers<PtySnapshot>()
    const rawSubscribe = Promise.withResolvers<PtySubscription>()
    let snapshots = 0
    let reconnectOffset = 110
    let blockRawSubscribe = false
    rig.setSnapshot(() => {
      snapshots++
      return snapshots === 1 ? firstSnapshot.promise : trailingSnapshot.promise
    })
    rig.setSubscribe((_sessionId, options) => {
      if (options.mode === 'raw' && blockRawSubscribe) return rawSubscribe.promise
      return Promise.resolve(testSubscription({ offset: reconnectOffset }))
    })
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    let firstReconnect: Promise<void> | undefined
    let reconnecting: Promise<void> | undefined
    try {
      firstReconnect = rig.service.onReconnect()
      await waitUntil(() => rig.snapshotCalls.length === 1)
      firstSnapshot.resolve(testSnapshot({ ansi: 'FIRST', offset: 109 }))
      await firstReconnect
      await flushMicrotasks()
      expect(terminalState(rig.service).mobileRecoveryTimers.size).toBe(1)

      await advanceServiceTime(500)
      blockRawSubscribe = true
      reconnecting = rig.service.onReconnect()
      await waitUntil(() => rig.subscribeCalls.length === 3)
      await advanceServiceTime(1_500)
      expect(rig.snapshotCalls).toHaveLength(1)
      expect(terminalState(rig.service).mobileRecoveryQueued.size).toBe(1)

      rig.service.onData('s1', testBytes('x'))
      trailingSnapshot.resolve(testSnapshot({ ansi: 'SNAPx', offset: 111 }))
      rawSubscribe.resolve(testSubscription({ offset: 110 }))
      await reconnecting
      await waitUntil(() => phoneStream.sent.length === 1)
      expect(phoneStream.sent.map(text)).toEqual(['\x18\x1b\\\x1bc\x1b[3JSNAPx'])
      expect(terminalState(rig.service).mobileRecoveryQueued.size).toBe(0)

      const reset = '\x18\x1b\\\x1bc\x1b[3J'
      let visible = ''
      for (const chunk of phoneStream.sent) {
        const output = text(chunk)
        const resetAt = output.indexOf(reset)
        if (resetAt >= 0) visible = output.slice(resetAt + reset.length)
        else visible += output
      }
      expect(visible).toBe('SNAPx')
    } finally {
      firstSnapshot.resolve(testSnapshot({ ansi: 'FIRST', offset: 109 }))
      trailingSnapshot.resolve(testSnapshot({ ansi: 'SNAPx', offset: 111 }))
      rawSubscribe.resolve(testSubscription({ offset: 110 }))
      if (firstReconnect) await firstReconnect.catch(() => {})
      if (reconnecting) await reconnecting.catch(() => {})
      await flushMicrotasks()
      rig.service.shutdown()
      mock.timers.reset()
    }
  })

})

describe('TerminalService.resync', () => {
  test('subscribes a replacement before closing the lagged stream', async () => {
    const rig = createTerminalServiceRig()
    const caller = rig.caller('ui', 70)
    const original = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
    const oldStream = rig.stream(original.streamId)
    oldStream.lag()

    const subscribeGate = Promise.withResolvers<PtySubscription>()
    rig.setSubscribe(() => subscribeGate.promise)
    const pending = resync(rig.service, { streamId: original.streamId, historyLines: 2000 }, caller)
    await waitUntil(() => rig.subscribeCalls.length === 2)
    expect(oldStream.closed).toBe(false)
    expect(terminalState(rig.service).byConnection.get(70)?.has(original.streamId)).toBe(true)
    expect(rig.subscribeCalls[1]?.options).toMatchObject({ mode: 'screen', historyLines: 2000 })

    subscribeGate.resolve(testSubscription({
      replay: testBase64(testBytes('current screen')),
      offset: 25,
      historyCursor: 'cursor-25'
    }))
    const replacement = await pending

    expect(replacement).toMatchObject({
      streamId: 2,
      replay: testBase64(testBytes('current screen')),
      offset: 25,
      historyCursor: 'cursor-25',
      live: true
    })
    expect(oldStream).toMatchObject({ closed: true, closeCount: 1 })
    expect(terminalState(rig.service).byConnection.get(70)?.has(original.streamId)).toBe(false)
    expect(terminalState(rig.service).byConnection.get(70)?.has(replacement.streamId)).toBe(true)
    expect(terminalState(rig.service).silent.has('s1')).toBe(false)
    rig.service.shutdown()
  })

  test('validates the caller connection, stream handle, terminal record, and shutdown state', async () => {
    const rig = createTerminalServiceRig()
    await expect(resync(rig.service, { streamId: 1 }, { role: 'plugin', pluginId: 'test' }))
      .rejects.toThrow('needs a client connection')
    const caller = rig.caller('ui', 71)
    await expect(resync(rig.service, { streamId: 1 }, caller)).rejects.toThrow('no such stream: 1')

    const attached = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
    rig.setSessionKind('structured')
    await expect(resync(rig.service, { streamId: attached.streamId }, caller)).rejects.toThrow('has no terminal')
    rig.setSessionKind('terminal')
    rig.service.shutdown()
    await expect(resync(rig.service, { streamId: attached.streamId }, caller)).rejects.toThrow('shut down')
  })

  test('keeps cooldown reservations keyed by connection and session, and cancels close/shutdown waiters', async () => {
    const rig = createTerminalServiceRig()
    const firstCaller = rig.caller('ui', 72)
    const otherCaller = rig.caller('ui', 73)
    const first = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, firstCaller)
    const second = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, firstCaller)
    const other = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, otherCaller)
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    try {
      const firstResync = await resync(rig.service, { streamId: first.streamId, historyLines: 50 }, firstCaller)
      expect(firstResync.streamId).toBe(4)
      expect(rig.subscribeCalls.at(-1)?.options).toMatchObject({ historyLines: 50 })

      const queued = resync(rig.service, { streamId: second.streamId }, firstCaller)
      const independent = await resync(rig.service, { streamId: other.streamId }, otherCaller)
      expect(independent.streamId).toBe(5)
      expect(rig.subscribeCalls).toHaveLength(5)
      await advanceServiceTime(1_999)
      expect(rig.subscribeCalls).toHaveLength(5)
      await advanceServiceTime(1)
      const secondResync = await queued
      expect(secondResync.streamId).toBe(6)
      expect(rig.subscribeCalls).toHaveLength(6)

      const closeWaiter = resync(rig.service, { streamId: firstResync.streamId }, firstCaller)
      await waitUntil(() => terminalState(rig.service).resyncWaiters.size === 1)
      rig.closeConnection(72)
      await expect(closeWaiter).rejects.toThrow('terminal connection closed while resyncing')

      const thirdForOther = await resync(rig.service, { streamId: independent.streamId }, otherCaller)
      const shutdownWaiter = resync(rig.service, { streamId: thirdForOther.streamId }, otherCaller)
      await waitUntil(() => terminalState(rig.service).resyncWaiters.size === 1)
      rig.service.shutdown()
      await expect(shutdownWaiter).rejects.toThrow('terminal connection closed while resyncing')
      expect(rig.subscribeCalls).toHaveLength(7)
    } finally {
      rig.service.shutdown()
      mock.timers.reset()
    }
  })

  test('preserves a phone driver lease across successful and failed resyncs', async () => {
    const rig = createTerminalServiceRig()
    const caller = rig.caller('mobile', 74)
    const original = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
    const resizeCount = rig.resizeCalls.length
    rig.service.assertCanInput('s1', caller)
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
    try {
      const replacement = await resync(rig.service, { streamId: original.streamId }, caller)
      expect(terminalState(rig.service).byConnection.get(74)?.get(replacement.streamId)).toMatchObject({ mobile: true })
      expect(rig.resizeCalls).toHaveLength(resizeCount)
      expect(() => rig.service.assertCanInput('s1', caller)).not.toThrow()

      rig.setSubscribe(async () => {
        throw new Error('subscribe failed')
      })
      const failedResync = resync(rig.service, { streamId: replacement.streamId }, caller)
      await advanceServiceTime(2_000)
      await expect(failedResync).rejects.toThrow('subscribe failed')
      expect(terminalState(rig.service).byConnection.get(74)?.has(replacement.streamId)).toBe(true)
      expect(() => rig.service.assertCanInput('s1', caller)).not.toThrow()
    } finally {
      rig.service.shutdown()
      mock.timers.reset()
    }
  })

  test('keeps an exited session read-only and replaces its lagged desktop attachment', async () => {
    const rig = createTerminalServiceRig()
    const caller = rig.caller('ui', 75)
    const original = await rig.service.attach({ session: 's1', cols: 80, rows: 24 }, caller)
    const oldStream = rig.stream(original.streamId)
    oldStream.lag()
    const unsubscriptionsBeforeExit = rig.unsubscribed.length
    rig.service.onExit('s1')
    expect(rig.unsubscribed).toHaveLength(unsubscriptionsBeforeExit)
    expect(oldStream.closed).toBe(false)
    expect(terminalState(rig.service).byConnection.get(75)?.has(original.streamId)).toBe(true)

    rig.setSessionStatus('exited')
    rig.setSubscribe(async () => testSubscription({
      replay: testBase64(testBytes('final screen')),
      offset: 40,
      live: false
    }))
    const result = await resync(rig.service, { streamId: original.streamId }, caller)

    expect(result).toMatchObject({ streamId: 2, replay: testBase64(testBytes('final screen')), offset: 40, live: false })
    expect(oldStream.closed).toBe(true)
    expect(terminalState(rig.service).bySession.has('s1')).toBe(false)
    expect(terminalState(rig.service).silent.get('s1')?.size).toBe(1)
    expect(terminalState(rig.service).byConnection.get(75)?.has(result.streamId)).toBe(true)
    rig.service.onData('s1', testBytes('after exit'))
    expect(rig.stream(result.streamId).sent).toEqual([])
    rig.service.shutdown()
  })
})

describe('TerminalService silent attachment lifecycle', () => {
  test('closes silent desktops on session removal or shutdown and drops detached handles', async () => {
    const removed = createTerminalServiceRig()
    const removedCaller = removed.caller('ui', 80)
    const removedAttach = await removed.service.attach({ session: 's1', cols: 80, rows: 24 }, removedCaller)
    const removedStream = removed.stream(removedAttach.streamId)
    removedStream.lag()
    removed.service.onEvent({
      type: 'quirky.session/removed',
      data: { sessionId: 's1' }
    } as PluginEvent)
    expect(removedStream.closed).toBe(true)
    expect(terminalState(removed.service).silent.has('s1')).toBe(false)
    expect(terminalState(removed.service).byConnection.get(80)?.has(removedAttach.streamId) ?? false).toBe(false)

    const stopped = createTerminalServiceRig()
    const stoppedAttach = await stopped.service.attach(
      { session: 's1', cols: 80, rows: 24 },
      stopped.caller('ui', 81)
    )
    const stoppedStream = stopped.stream(stoppedAttach.streamId)
    stoppedStream.lag()
    stopped.service.shutdown()
    expect(stoppedStream.closed).toBe(true)
    expect(terminalState(stopped.service).silent.has('s1')).toBe(false)

    const detached = createTerminalServiceRig()
    const detachedCaller = detached.caller('ui', 82)
    const detachedAttach = await detached.service.attach({ session: 's1', cols: 80, rows: 24 }, detachedCaller)
    const detachedStream = detached.stream(detachedAttach.streamId)
    detachedStream.lag()
    detached.service.detach({ streamId: detachedAttach.streamId }, detachedCaller)
    expect(detachedStream.closed).toBe(true)
    expect(terminalState(detached.service).silent.has('s1')).toBe(false)
    expect(terminalState(detached.service).byConnection.get(82)?.has(detachedAttach.streamId) ?? false).toBe(false)
    await expect(resync(detached.service, { streamId: detachedAttach.streamId }, detachedCaller))
      .rejects.toThrow(`no such stream: ${detachedAttach.streamId}`)
    detached.service.shutdown()
  })
})

describe('quirky.terminal/resync RPC routing', () => {
  test('routes a connection-bound resync to a replacement live stream', async () => {
    const attached = await attachFull(client, shell.id)
    const result = await call<Attached>(client, 'quirky.terminal/resync', {
      streamId: attached.streamId,
      historyLines: 2000
    })

    expect(result.streamId).not.toBe(attached.streamId)
    expect(result).toMatchObject({
      replay: expect.any(String),
      offset: expect.any(Number),
      historyCursor: null,
      cols: 80,
      rows: 24,
      shellState: expect.any(String),
      live: true
    })
    expect(subscribes(shell.id)).toBe(2)
  })
})
