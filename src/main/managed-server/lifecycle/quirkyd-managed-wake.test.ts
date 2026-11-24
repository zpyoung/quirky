import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import type * as InstallLock from '../install/remote-install-lock'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('../../../shared/shell-argument-quoting', () => ({
  quotePosixShell: (s: string) => `'${s}'`
}))
vi.mock('../install/remote-install-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallLock>()),
  acquireInstallLock: vi.fn()
}))

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { acquireInstallLock, RemoteInstallLockBusyError } from '../install/remote-install-lock'
import { wakeStoppedManagedQuirkyd } from './quirkyd-managed-wake'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import { FakeQuirkydHost, OLD } from '../activation/quirkyd-activation-host-test-harness'
import { QUIRKYD_E2E_IDLE_TIMEOUT_ENV } from '../../../shared/quirkyd-idle-exit'
import { QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV } from '../../../shared/quirkyd-managed-launch-env'

let host = new FakeQuirkydHost()

const slot = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked; the wake reads only the target id.
  conn: { getTarget: () => ({ id: 'ssh-1' }) } as unknown as QuirkydHostTransport,
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/u',
  nodePath: '/usr/bin/node',
  userDataDir: '/home/u/.quirky',
  bindHost: '127.0.0.1',
  port: 7777,
  readinessTimeoutMs: 50,
  sleep: async () => {}
}

function launches(): string[] {
  return host.commands.filter((command) => command.includes('nohup'))
}

/** The slot's process exited on its own, as an idle stop leaves it. */
function stoppedHost(): FakeQuirkydHost {
  const stopped = FakeQuirkydHost.deployedOld()
  stopped.alive.clear()
  return stopped
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
  vi.mocked(acquireInstallLock).mockImplementation(async (_conn, root, _host, options) => {
    // A recovery takeover answers busy on a fence another run still holds.
    if (!host.acquireFence(options)) {
      throw new RemoteInstallLockBusyError(root, 0)
    }
    // The real lock writes the owner token in the same command that creates it.
    host.wakeOwner = options?.owner?.token ?? null
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('wakeStoppedManagedQuirkyd', () => {
  it('starts a stopped active slot as a managed launch and releases the fence', async () => {
    host = stoppedHost()

    const wake = await wakeStoppedManagedQuirkyd(slot)

    expect(wake.outcome).toBe('started')
    expect([...host.alive]).toEqual([OLD])
    expect(host.fence).toBe(false)
    expect(launches()).toHaveLength(1)
    expect(launches()[0]).toContain(
      `${QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV}='/home/u/.quirky-remote/.quirkyd-activation-transaction'`
    )
    expect(launches()[0]).not.toContain(QUIRKYD_E2E_IDLE_TIMEOUT_ENV)
  })

  it('forwards the test-only idle timeout to the server it starts', async () => {
    vi.stubEnv(QUIRKYD_E2E_IDLE_TIMEOUT_ENV, '3000')
    host = stoppedHost()

    await wakeStoppedManagedQuirkyd(slot)

    expect(launches()[0]).toContain(`${QUIRKYD_E2E_IDLE_TIMEOUT_ENV}='3000'`)
  })

  it('leaves a running server alone', async () => {
    host = FakeQuirkydHost.deployedOld()

    expect(await wakeStoppedManagedQuirkyd(slot)).toEqual({ outcome: 'serving' })
    expect(launches()).toEqual([])
    expect(acquireInstallLock).not.toHaveBeenCalled()
  })

  it('never starts a second process when the slot state is unprovable', async () => {
    host = stoppedHost()
    host.pidFiles.clear()

    expect(await wakeStoppedManagedQuirkyd(slot)).toEqual({ outcome: 'unverifiable' })
    expect(launches()).toEqual([])
  })

  it('starts an active slot with no launch artifacts at all: nothing ever ran from it', async () => {
    host = stoppedHost()
    host.pidFiles.clear()
    // Neither a PID file nor a readiness file, so the host answers NEVER_LAUNCHED, not UNKNOWN.
    vi.mocked(execCommand).mockImplementation(async (_conn, command) =>
      command.includes('echo LIVE;') && !host.alive.has(OLD) ? 'NEVER_LAUNCHED' : host.exec(command)
    )

    const wake = await wakeStoppedManagedQuirkyd(slot)

    expect(wake.outcome).toBe('started')
    expect([...host.alive]).toEqual([OLD])
    expect(host.fence).toBe(false)
    expect(launches()).toHaveLength(1)
  })

  it('defers to an update or recovery that holds the activation fence', async () => {
    host = stoppedHost()
    host.fence = true
    host.fenceFresh = true

    expect(await wakeStoppedManagedQuirkyd(slot)).toEqual({ outcome: 'fenced' })
    expect(launches()).toEqual([])
    expect(host.fence).toBe(true)
  })

  it('releases the fence its own wake left when the connection dropped, and starts the slot', async () => {
    host = stoppedHost()
    const lost = Object.assign(new Error('connection lost'), { sshChannelCloseConfirmed: false })
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('nohup')) {
        throw lost
      }
      return host.exec(command)
    })
    await expect(wakeStoppedManagedQuirkyd(slot)).rejects.toBe(lost)
    expect(host.fence).toBe(true)

    vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
    expect(await wakeStoppedManagedQuirkyd(slot)).toMatchObject({ outcome: 'started' })
    expect(launches()).toHaveLength(1)
    expect(host.fence).toBe(false)
  })

  it('releases its own fence on reconnect when the drop surfaced as a plain failure', async () => {
    host = stoppedHost()
    // A disconnect fails every later step, the fence release included, without the unconfirmed flag.
    const gone = new Error('Not connected')
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('nohup') || command.includes('echo RELEASED')) {
        throw gone
      }
      return host.exec(command)
    })
    await expect(wakeStoppedManagedQuirkyd(slot)).rejects.toBe(gone)
    expect(host.fence).toBe(true)

    vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
    expect(await wakeStoppedManagedQuirkyd(slot)).toMatchObject({ outcome: 'started' })
    expect(launches()).toHaveLength(1)
    expect(host.fence).toBe(false)
  })

  it('never claims a fence with no owner token, even while its own interrupted token is held', async () => {
    host = stoppedHost()
    const lost = Object.assign(new Error('connection lost'), { sshChannelCloseConfirmed: false })
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('nohup')) {
        throw lost
      }
      return host.exec(command)
    })
    await expect(wakeStoppedManagedQuirkyd(slot)).rejects.toBe(lost)
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
    // That fence was cleared unseen, and another desktop took a fresh one: no owner file yet.
    host.wakeOwner = null
    host.fenceFresh = true

    expect(await wakeStoppedManagedQuirkyd(slot)).toEqual({ outcome: 'fenced' })
    expect(host.fence).toBe(true)
    expect(launches()).toEqual([])
  })

  it('lets a wake on a dropped connection settle before a reconnected wake reads the fence', async () => {
    host = stoppedHost()
    const lost = Object.assign(new Error('connection lost'), { sshChannelCloseConfirmed: false })
    let drop: (() => void) | undefined
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      // Drops the first wake under its fence, after its owner token landed but before its launch.
      if (host.fence && host.wakeOwner && command.includes('quirkyd-active.json') && !drop) {
        await new Promise<void>((resolve) => (drop = resolve))
        throw lost
      }
      return host.exec(command)
    })
    const dropped = wakeStoppedManagedQuirkyd(slot)
    await vi.waitFor(() => expect(drop).toBeDefined())

    // The reconnected wake starts while the first is still holding the fence it just took.
    const reconnected = wakeStoppedManagedQuirkyd(slot)
    drop?.()
    await expect(dropped).rejects.toBe(lost)
    expect(await reconnected).toMatchObject({ outcome: 'started' })
    expect(launches()).toHaveLength(1)
    expect(host.fence).toBe(false)
  })

  it('proves a fence its own wake took even when the drop hid whether the lock was created', async () => {
    host = stoppedHost()
    const lost = Object.assign(new Error('connection lost'), { sshChannelCloseConfirmed: false })
    // The host created the lock (with its owner token), but the client never saw OK.
    vi.mocked(acquireInstallLock).mockImplementationOnce(async (_conn, _root, _host, options) => {
      host.acquireFence()
      host.wakeOwner = options?.owner?.token ?? null
      throw lost
    })
    await expect(wakeStoppedManagedQuirkyd(slot)).rejects.toBe(lost)
    expect(host.fence).toBe(true)

    expect(await wakeStoppedManagedQuirkyd(slot)).toMatchObject({ outcome: 'started' })
    expect(launches()).toHaveLength(1)
    expect(host.fence).toBe(false)
  })

  it('waits for a wake still before its fence instead of racing it to the lock', async () => {
    host = stoppedHost()
    const lost = Object.assign(new Error('connection lost'), { sshChannelCloseConfirmed: false })
    let drop: (() => void) | undefined
    vi.mocked(acquireInstallLock).mockImplementationOnce(async (_conn, _root, _host, options) => {
      host.acquireFence()
      host.wakeOwner = options?.owner?.token ?? null
      await new Promise<void>((resolve) => (drop = resolve))
      throw lost
    })
    const dropped = wakeStoppedManagedQuirkyd(slot)
    // The reconnected wake starts while the first is still taking the fence.
    const reconnected = wakeStoppedManagedQuirkyd(slot)
    await vi.waitFor(() => expect(drop).toBeDefined())
    drop?.()
    await expect(dropped).rejects.toBe(lost)
    expect(await reconnected).toMatchObject({ outcome: 'started' })
    expect(launches()).toHaveLength(1)
    expect(host.fence).toBe(false)
  })

  it('never releases a fence another run took after its own interrupted fence was cleared', async () => {
    host = stoppedHost()
    const lost = Object.assign(new Error('connection lost'), { sshChannelCloseConfirmed: false })
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('nohup')) {
        throw lost
      }
      return host.exec(command)
    })
    await expect(wakeStoppedManagedQuirkyd(slot)).rejects.toBe(lost)
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
    // A recovery cleared that fence, then another run took the host before journaling.
    host.wakeOwner = 'another-run'
    host.fenceFresh = true

    expect(await wakeStoppedManagedQuirkyd(slot)).toEqual({ outcome: 'fenced' })
    expect(host.fence).toBe(true)
    expect(launches()).toEqual([])
  })

  it('never releases a fence another client may hold, even after its own wake dropped', async () => {
    host = stoppedHost()
    host.fence = true
    host.fenceFresh = true
    expect(
      await wakeStoppedManagedQuirkyd({
        ...slot,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above, a different target.
        conn: { getTarget: () => ({ id: 'ssh-2' }) } as unknown as QuirkydHostTransport
      })
    ).toEqual({ outcome: 'fenced' })
    expect(host.fence).toBe(true)
  })

  it('drops an abandoned fence no journal backs, and starts the slot', async () => {
    host = stoppedHost()
    // A stale or exited-own fence: the recovery takeover may take it.
    host.fence = true
    host.wakeOwner = 'exited-run'

    expect(await wakeStoppedManagedQuirkyd(slot)).toMatchObject({ outcome: 'started' })
    expect(launches()).toHaveLength(1)
    expect(host.fence).toBe(false)
  })

  it('has nothing to start on a host with no activated server', async () => {
    host = new FakeQuirkydHost()

    expect(await wakeStoppedManagedQuirkyd(slot)).toEqual({ outcome: 'not-activated' })
    expect(launches()).toEqual([])
  })
})
