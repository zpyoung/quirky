import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QuirkyClient, RpcError, RpcErrorCode, type MobileTerminalState, type Session } from '@quirky/protocol'
import { waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { groupsInOrder, paneLeaves } from '../src/layout/tree'
import type { Workspace } from '../src/layout/types'
import { call, createSession, startPluginHarness, TERMINAL_PLUGINS } from './support'

const MOBILE_TERMINAL_PLUGINS = {
  ...TERMINAL_PLUGINS,
  fakes: [...TERMINAL_PLUGINS.fakes, 'quirky.mobile']
}

let h: Harness
let desktop: QuirkyClient
let shell: Session
let previousMobilePort: string | undefined

beforeEach(async () => {
  previousMobilePort = process.env.QUIRKY_MOBILE_PORT
  process.env.QUIRKY_MOBILE_PORT = '0'
  h = await startPluginHarness(MOBILE_TERMINAL_PLUGINS)
  desktop = await h.connect('ui')
  shell = await createSession(desktop, { worktree: 'id:wt_main', agent: 'shell' })
})

afterEach(async () => {
  if (previousMobilePort === undefined) delete process.env.QUIRKY_MOBILE_PORT
  else process.env.QUIRKY_MOBILE_PORT = previousMobilePort
  await h.cleanup()
})

async function phone(slot: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return call(desktop, 'quirky.mobile/testCall', { slot, method, params })
}

async function admit(slot: string): Promise<void> {
  await call(desktop, 'quirky.mobile/testAdmit', { slot })
}

async function terminalState(session = shell.id): Promise<MobileTerminalState[]> {
  const result = await call<{ terminals: MobileTerminalState[] }>(desktop, 'quirky.terminal/mobileState', { session })
  return result.terminals
}
async function allTerminalState(): Promise<MobileTerminalState[]> {
  const result = await call<{ terminals: MobileTerminalState[] }>(desktop, 'quirky.terminal/mobileState', {})
  return result.terminals
}

function ptySize(sessionId = shell.id): { cols: number; rows: number } {
  const info = h.pty.sessions.get(sessionId)?.info
  if (!info) throw new Error(`PTY session disappeared: ${sessionId}`)
  return { cols: info.cols, rows: info.rows }
}

async function expectConflict(operation: Promise<unknown>): Promise<void> {
  let caught: unknown
  try {
    await operation
  } catch (error) {
    caught = error
  }
  if (!(caught instanceof RpcError)) throw new Error('expected terminal lease conflict')
  expect(caught.code).toBe(RpcErrorCode.Conflict)
}

describe('mobile terminal driver leases through the daemon API', () => {
  test('the first phone owns the PTY size and input; desktop resize is remembered without stealing it', async () => {
    await call(desktop, 'quirky.terminal/resize', { session: shell.id, cols: 120, rows: 35 })
    const desktopStream = await call<{ streamId: number }>(desktop, 'quirky.terminal/attach', { session: shell.id, cols: 120, rows: 35 })
    const output: string[] = []
    desktop.onTerminalOutput(desktopStream.streamId, (bytes) => output.push(new TextDecoder().decode(bytes)))

    await admit('phone-a')
    await phone('phone-a', 'quirky.terminal/attach', { session: shell.id, cols: 50, rows: 20 })
    expect(ptySize()).toEqual({ cols: 50, rows: 20 })
    expect(await terminalState()).toEqual([
      expect.objectContaining({
        session: shell.id,
        driver: expect.objectContaining({ deviceId: 'device-a', name: 'Phone A' }),
        phoneFit: false,
        cols: 50,
        rows: 20,
        desktopCols: 120,
        desktopRows: 35
      })
    ])

    await call(desktop, 'quirky.terminal/resize', { session: shell.id, cols: 132, rows: 42 })
    expect(ptySize()).toEqual({ cols: 50, rows: 20 })
    expect(await terminalState()).toEqual([
      expect.objectContaining({ cols: 50, rows: 20, desktopCols: 132, desktopRows: 42 })
    ])

    await admit('phone-b')
    await phone('phone-b', 'quirky.terminal/attach', { session: shell.id, cols: 64, rows: 22 })
    expect(ptySize()).toEqual({ cols: 50, rows: 20 })
    expect((await terminalState())[0]?.driver).toMatchObject({ deviceId: 'device-a' })
    await expectConflict(phone('phone-b', 'quirky.terminal/write', { session: shell.id, data: 'wrong owner' }))
    await expectConflict(phone('phone-b', 'quirky.terminal/send', { session: shell.id, text: 'wrong owner' }))
    await expectConflict(phone('phone-b', 'quirky.terminal/resize', { session: shell.id, cols: 90, rows: 30 }))

    await expectConflict(call(desktop, 'quirky.terminal/write', { session: shell.id, data: 'desktop blocked' }))
    await expectConflict(call(desktop, 'quirky.terminal/send', { session: shell.id, text: 'desktop blocked' }))
    await expectConflict(call(desktop, 'quirky.terminal/send', { session: shell.id, text: 'desktop blocked', enter: true }))
    expect(h.pty.inputs).toEqual([])
    await phone('phone-a', 'quirky.terminal/write', { session: shell.id, data: 'phone input' })
    expect(h.pty.inputs).toEqual([{ sessionId: shell.id, text: 'phone input' }])

    h.pty.emit(shell.id, 'output continues')
    await waitFor(() => output.join('').includes('output continues'))
  })

  test('take-back restores the saved desktop viewport while a connected phone watches until explicit claim', async () => {
    await call(desktop, 'quirky.terminal/resize', { session: shell.id, cols: 120, rows: 35 })
    await admit('phone-a')
    await phone('phone-a', 'quirky.terminal/attach', { session: shell.id, cols: 50, rows: 20 })

    await call(desktop, 'quirky.terminal/takeBack', { session: shell.id })
    expect(ptySize()).toEqual({ cols: 120, rows: 35 })
    expect(await terminalState()).toEqual([])
    await expectConflict(phone('phone-a', 'quirky.terminal/write', { session: shell.id, data: 'still watching' }))
    await expectConflict(phone('phone-a', 'quirky.terminal/resize', { session: shell.id, cols: 70, rows: 22 }))
    expect(ptySize()).toEqual({ cols: 120, rows: 35 })

    await phone('phone-a', 'quirky.terminal/claim', { session: shell.id, cols: 70, rows: 22 })
    expect(ptySize()).toEqual({ cols: 70, rows: 22 })
    expect((await terminalState())[0]?.driver).toMatchObject({ deviceId: 'device-a', name: 'Phone A' })
  })

  test('a disconnected or revoked phone leaves a phone-fit hold indefinitely by default', async () => {
    await call(desktop, 'quirky.terminal/resize', { session: shell.id, cols: 120, rows: 35 })
    await admit('phone-a')
    await phone('phone-a', 'quirky.terminal/attach', { session: shell.id, cols: 50, rows: 20 })

    await call(desktop, 'quirky.mobile/testRevoke', { slot: 'phone-a' })
    await waitFor(async () => (await terminalState()).some((terminal) => terminal.phoneFit && terminal.driver === null))
    expect(ptySize()).toEqual({ cols: 50, rows: 20 })
    expect(await terminalState()).toEqual([
      expect.objectContaining({ phoneFit: true, driver: null, cols: 50, rows: 20, desktopCols: 120, desktopRows: 35 })
    ])
    await call(desktop, 'quirky.terminal/restoreFit', { session: shell.id })
    expect(ptySize()).toEqual({ cols: 120, rows: 35 })
    expect(await terminalState()).toEqual([])
  })
  test('detaching the last phone stream leaves phone-fit held while its socket remains connected', async () => {
    await call(desktop, 'quirky.terminal/resize', { session: shell.id, cols: 120, rows: 35 })
    await admit('phone-a')
    const attached = await phone('phone-a', 'quirky.terminal/attach', { session: shell.id, cols: 50, rows: 20 }) as { streamId: number }
    await phone('phone-a', 'quirky.terminal/detach', { streamId: attached.streamId })
    await waitFor(async () => (await terminalState()).some((terminal) => terminal.phoneFit && terminal.driver === null))
    expect(ptySize()).toEqual({ cols: 50, rows: 20 })
    await call(desktop, 'quirky.mobile/testDisconnect', { slot: 'phone-a' })
  })
  test('take-back all, explicit attachment claims, and restore-fit all work across sessions', async () => {
    const other = await createSession(desktop, { worktree: 'id:wt_main', agent: 'shell' })
    await call(desktop, 'quirky.terminal/resize', { session: shell.id, cols: 120, rows: 35 })
    await call(desktop, 'quirky.terminal/resize', { session: other.id, cols: 100, rows: 30 })
    await admit('phone-a')
    await admit('phone-b')
    await phone('phone-a', 'quirky.terminal/attach', { session: shell.id, cols: 50, rows: 20 })
    await phone('phone-b', 'quirky.terminal/attach', { session: other.id, cols: 60, rows: 22 })

    await call(desktop, 'quirky.terminal/takeBack', {})
    expect(ptySize(shell.id)).toEqual({ cols: 120, rows: 35 })
    expect(ptySize(other.id)).toEqual({ cols: 100, rows: 30 })
    expect(await allTerminalState()).toEqual([])

    await phone('phone-a', 'quirky.terminal/attach', { session: shell.id, cols: 48, rows: 19, claim: true })
    await phone('phone-b', 'quirky.terminal/attach', { session: other.id, cols: 58, rows: 21, claim: true })
    await call(desktop, 'quirky.mobile/testDisconnect', { slot: 'phone-a' })
    await call(desktop, 'quirky.mobile/testDisconnect', { slot: 'phone-b' })
    await waitFor(async () => (await allTerminalState()).length === 2, 1000, 'both phone-fit holds')
    await call(desktop, 'quirky.terminal/restoreFit', {})
    expect(ptySize(shell.id)).toEqual({ cols: 120, rows: 35 })
    expect(ptySize(other.id)).toEqual({ cols: 100, rows: 30 })
    expect(await allTerminalState()).toEqual([])
  })

  test('configured auto-restore runs after the last phone disconnects and reconnect cancels a stale timer', async () => {
    await call(desktop, 'quirky.mobile/configure', { autoRestoreFitMs: 5000 })
    await call(desktop, 'quirky.terminal/resize', { session: shell.id, cols: 120, rows: 35 })
    await admit('phone-a')
    await phone('phone-a', 'quirky.terminal/attach', { session: shell.id, cols: 50, rows: 20 })
    await call(desktop, 'quirky.mobile/testDisconnect', { slot: 'phone-a' })
    await waitFor(async () => (await terminalState()).some((terminal) => terminal.phoneFit), 1000, 'phone-fit hold')

    await admit('phone-a-reconnect')
    await phone('phone-a-reconnect', 'quirky.terminal/attach', { session: shell.id, cols: 45, rows: 18 })
    // Exercise the real daemon timer so reconnect cancellation is checked against its original deadline.
    await Bun.sleep(5200)
    expect(ptySize()).toEqual({ cols: 45, rows: 18 })
    expect((await terminalState())[0]?.driver).toMatchObject({ deviceId: 'device-a' })

    await call(desktop, 'quirky.mobile/testDisconnect', { slot: 'phone-a-reconnect' })
    await waitFor(() => ptySize().cols === 120 && ptySize().rows === 35, 7000, 'configured restore')
    expect(await terminalState()).toEqual([])
  })

  test('session removal clears driver state and phone streams', async () => {
    await admit('phone-a')
    await phone('phone-a', 'quirky.terminal/attach', { session: shell.id, cols: 50, rows: 20 })
    await call(desktop, 'quirky.session/close', { session: shell.id })
    await waitFor(async () => (await terminalState()).length === 0)
  })
  test('PTY exit clears the active driver and attached streams', async () => {
    await admit('phone-a')
    await phone('phone-a', 'quirky.terminal/attach', { session: shell.id, cols: 50, rows: 20 })
    h.pty.exit(shell.id, 0)
    await waitFor(async () => (await terminalState()).length === 0)
  })

  test('desktop quick-command session writes are refused while a phone owns the pane', async () => {
    const cli = await h.connect('cli')
    try {
      await call(cli, 'quirky.terminal/addQuickCommand', { label: 'Blocked', command: 'echo blocked' })
      const created = await call<{ workspace: Workspace }>(cli, 'quirky.terminal/newTab', { workspace: 'main' })
      const tab = groupsInOrder(created.workspace.root).flatMap((group) => group.tabs).at(-1)!
      const pane = paneLeaves(tab.root)[0]!
      await admit('phone-a')
      await phone('phone-a', 'quirky.terminal/attach', { session: pane.session, cols: 50, rows: 20 })
      await expectConflict(call(cli, 'quirky.terminal/runQuickCommand', { id: 'blocked', pane: pane.id }))
      expect(h.pty.inputs.filter((input) => input.sessionId === pane.session)).toEqual([])
    } finally {
      cli.close()
    }
  })

})
test('take-back keeps a phone-fit hold when no desktop viewport has been reported', async () => {
  h.pty.setSnapshotResult({
    ansi: '',
    cols: 0,
    rows: 0,
    cursor: { x: 0, y: 0 },
    modes: { alternateScreen: false, bracketedPaste: false, mouseTracking: false, applicationCursor: false },
    cwd: '/fake/alpha',
    title: null,
    shellState: 'unsupported',
    offset: 0
  })
  await admit('phone-a')
  await phone('phone-a', 'quirky.terminal/attach', { session: shell.id, cols: 50, rows: 20 })
  expect(ptySize()).toEqual({ cols: 50, rows: 20 })
  await expectConflict(call(desktop, 'quirky.terminal/takeBack', { session: shell.id }))
  expect((await terminalState())[0]).toMatchObject({ phoneFit: true, driver: null, desktopCols: null, desktopRows: null })

  await call(desktop, 'quirky.terminal/resize', { session: shell.id, cols: 120, rows: 35 })
  expect(ptySize()).toEqual({ cols: 50, rows: 20 })
  await call(desktop, 'quirky.terminal/restoreFit', { session: shell.id })
  expect(ptySize()).toEqual({ cols: 120, rows: 35 })
})
