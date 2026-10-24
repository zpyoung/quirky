import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { base64ToBytes, type QuirkyClient, type RpcError, type Session, RpcErrorCode } from '@quirky/protocol'
import { startHarness, waitFor, type Harness } from './helpers'

let h: Harness
let client: QuirkyClient
let shell: Session
let claude: Session

beforeEach(async () => {
  h = await startHarness()
  h.git.addRepo('/fake/alpha')
  client = await h.connect('ui')
  const repo = await client.call('repo.add', { path: '/fake/alpha' })
  const [worktree] = await client.call('worktree.list', { repoId: repo.id })
  shell = await client.call('session.create', { worktreeId: worktree.id, agent: 'shell' })
  claude = await client.call('session.create', { worktreeId: worktree.id, agent: 'claude' })
})
afterEach(() => h.cleanup())

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const subscribes = (sessionId: string) =>
  h.pty.requests.filter((r) => r.type === 'subscribe' && r.sessionId === sessionId).length
const unsubscribes = (sessionId: string) =>
  h.pty.requests.filter((r) => r.type === 'unsubscribe' && r.sessionId === sessionId).length

describe('terminal.attach', () => {
  test('passes replay and offset through, then streams live frames and stops on detach', async () => {
    h.pty.emit(shell.id, 'before-attach ')
    const attach = await client.call('terminal.attach', { sessionId: shell.id, cols: 90, rows: 20 })
    expect(text(base64ToBytes(attach.replay))).toBe('before-attach ')
    expect(attach.offset).toBe('before-attach '.length)
    expect(h.pty.sessions.get(shell.id)?.info).toMatchObject({ cols: 90, rows: 20 })

    const received: string[] = []
    client.onTerminalOutput(attach.streamId, (bytes) => received.push(text(bytes)))
    h.pty.emit(shell.id, 'one ')
    h.pty.emit(shell.id, 'two')
    await waitFor(() => received.join('') === 'one two')

    await client.call('terminal.detach', { streamId: attach.streamId })
    await waitFor(() => unsubscribes(shell.id) === 1)
    h.pty.emit(shell.id, 'after')
    await Bun.sleep(50)
    expect(received.join('')).toBe('one two')
  })

  test('subscribes to the pty host for every attach and unsubscribes after the last detach', async () => {
    const a = await client.call('terminal.attach', { sessionId: shell.id, cols: 80, rows: 24 })
    const other = await h.connect('desktop')
    const b = await other.call('terminal.attach', { sessionId: shell.id, cols: 80, rows: 24 })
    expect(subscribes(shell.id)).toBe(2)

    const gotA: string[] = []
    const gotB: string[] = []
    client.onTerminalOutput(a.streamId, (bytes) => gotA.push(text(bytes)))
    other.onTerminalOutput(b.streamId, (bytes) => gotB.push(text(bytes)))
    h.pty.emit(shell.id, 'x')
    await waitFor(() => gotA.length === 1 && gotB.length === 1)

    await client.call('terminal.detach', { streamId: a.streamId })
    await Bun.sleep(30)
    expect(unsubscribes(shell.id)).toBe(0)
    h.pty.emit(shell.id, 'y')
    await waitFor(() => gotB.join('') === 'xy')
    expect(gotA.join('')).toBe('x')

    other.close()
    await waitFor(() => unsubscribes(shell.id) === 1)
  })

  test('detaches streams when the socket closes', async () => {
    const other = await h.connect('ui')
    await other.call('terminal.attach', { sessionId: shell.id, cols: 80, rows: 24 })
    other.close()
    await waitFor(() => unsubscribes(shell.id) === 1)
  })

  test('rejects unknown sessions and streams', async () => {
    const code = async (promise: Promise<unknown>) => {
      try {
        await promise
      } catch (error) {
        return (error as RpcError).code
      }
    }
    expect(await code(client.call('terminal.attach', { sessionId: 's_nope', cols: 80, rows: 24 }))).toBe(
      RpcErrorCode.NotFound
    )
    expect(await code(client.call('terminal.detach', { streamId: 99 }))).toBe(RpcErrorCode.NotFound)
  })

  test('catches up on output produced while the pty host connection was down', async () => {
    const attach = await client.call('terminal.attach', { sessionId: shell.id, cols: 80, rows: 24 })
    const received: string[] = []
    client.onTerminalOutput(attach.streamId, (bytes) => received.push(text(bytes)))
    h.pty.emit(shell.id, 'a')
    await waitFor(() => received.join('') === 'a')
    h.pty.dropConnections()
    h.pty.emit(shell.id, 'b')
    await waitFor(() => received.join('') === 'ab', 5000)
    h.pty.emit(shell.id, 'c')
    await waitFor(() => received.join('') === 'abc', 5000)
  })
})

describe('terminal input and screen', () => {
  test('write sends a DATA frame', async () => {
    await client.call('terminal.write', { sessionId: shell.id, data: 'ls\r' })
    await waitFor(() => h.pty.inputs.length === 1)
    expect(h.pty.inputs[0]).toEqual({ sessionId: shell.id, text: 'ls\r' })
  })

  test('send types text for shells and pastes for agents', async () => {
    await client.call('terminal.send', { sessionId: shell.id, text: 'echo hi', enter: true })
    await client.call('terminal.send', { sessionId: shell.id, text: 'partial' })
    await waitFor(() => h.pty.inputs.length === 2)
    expect(h.pty.inputs.map((i) => i.text)).toEqual(['echo hi\r', 'partial'])

    h.pty.inputs.length = 0
    const started = Date.now()
    await client.call('terminal.send', { sessionId: claude.id, text: 'do it', enter: true })
    await waitFor(() => h.pty.inputs.length === 2)
    expect(h.pty.inputs.map((i) => i.text)).toEqual(['\x1b[200~do it\x1b[201~', '\r'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)

    h.pty.inputs.length = 0
    await client.call('terminal.send', { sessionId: claude.id, text: 'draft' })
    await Bun.sleep(60)
    expect(h.pty.inputs.map((i) => i.text)).toEqual(['\x1b[200~draft\x1b[201~'])
  })

  test('resize and read pass through', async () => {
    await client.call('terminal.resize', { sessionId: shell.id, cols: 132, rows: 43 })
    expect(h.pty.sessions.get(shell.id)?.info).toMatchObject({ cols: 132, rows: 43 })
    h.pty.setReadResult({ lines: ['a', 'b'], cols: 132, rows: 43, alt: true })
    expect(await client.call('terminal.read', { sessionId: shell.id })).toEqual({
      lines: ['a', 'b'],
      cols: 132,
      rows: 43,
      alt: true
    })
    const read = h.pty.requests.filter((r) => r.type === 'read').at(-1)
    expect(read).toMatchObject({ lines: 50 })
    await client.call('terminal.read', { sessionId: shell.id, lines: 7 })
    expect(h.pty.requests.filter((r) => r.type === 'read').at(-1)).toMatchObject({ lines: 7 })
  })
})
