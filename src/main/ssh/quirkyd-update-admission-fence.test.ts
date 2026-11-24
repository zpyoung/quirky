// The update's last census closes the incumbent's terminal admission; it stays closed through the
// stop, and reopens whenever the update leaves the incumbent serving.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from './remote-exec/remote-exec-command'
import type * as RecordFile from '../managed-server/install/quirkyd-remote-record-file'
import type * as InstallLock from '../managed-server/install/remote-install-lock'
import type * as VersionedInstall from '../managed-server/install/remote-versioned-install'

vi.mock('./remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('../../shared/shell-argument-quoting', () => ({ quotePosixShell: (s: string) => `'${s}'` }))
vi.mock('../managed-server/install/remote-install-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallLock>()),
  acquireInstallLock: vi.fn()
}))
vi.mock('../managed-server/install/quirkyd-remote-record-file', async (importOriginal) => ({
  ...(await importOriginal<typeof RecordFile>()),
  writeAtomicQuirkydRemoteRecord: vi.fn()
}))
vi.mock('../managed-server/install/remote-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<typeof VersionedInstall>()),
  readLocalFullVersion: () => '0.2.0+bb01'
}))
vi.mock('../managed-server/install/quirkyd-remote-install', () => ({
  installQuirkydBundle: vi.fn()
}))
vi.mock('../managed-server/install/quirkyd-remote-preflight', () => ({
  preflightInstalledQuirkyd: vi.fn()
}))
vi.mock('./quirkyd-local-build-hash', () => ({
  computeLocalQuirkydBuildHash: () => 'abc123def4567890'
}))

import { execCommand } from './remote-exec/remote-exec-command'
import { acquireInstallLock } from '../managed-server/install/remote-install-lock'
import { writeAtomicQuirkydRemoteRecord } from '../managed-server/install/quirkyd-remote-record-file'
import { deployQuirkyd } from './quirkyd-remote-deploy'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  QUIRKYD_UPDATE_ADMISSION_FENCE_MS,
  QUIRKYD_UPDATE_ADMISSION_STOP_BY_MS
} from '../../shared/quirkyd-terminal-census'
import type { QuirkydTerminalCensus } from '../../shared/quirkyd-terminal-census'
import {
  TerminalUpdateAdmission,
  TerminalUpdateAdmissionClosedError
} from '../runtime/terminal/stop/terminal-update-admission'
import {
  FakeQuirkydHost,
  NEW,
  OLD
} from '../managed-server/activation/quirkyd-activation-host-test-harness'

let host = FakeQuirkydHost.deployedOld()
let clockMs = Date.parse('2026-02-02T00:00:00.000Z')
/** The incumbent server's own admission, as its census handler drives it. */
let admission = new TerminalUpdateAdmission(async () => [])

const IDLE = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 }
const LIVE = { liveSessions: 1, startedSinceActivation: 1, daemonProtocolVersion: 3 }
const UNREAD = { liveSessions: null, startedSinceActivation: null, daemonProtocolVersion: null }

function deploy(recount: QuirkydTerminalCensus | Error = IDLE, force?: boolean) {
  const recountCensus = vi.fn(async () => {
    admission.close(QUIRKYD_UPDATE_ADMISSION_FENCE_MS)
    if (recount instanceof Error) {
      throw recount
    }
    return recount
  })
  const releaseIncumbentAdmission = vi.fn(async () => {
    admission.close(0)
  })
  const result = deployQuirkyd({
    conn: Object.create(null),
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/work',
    nodePath: '/usr/bin/node',
    userDataDir: '/home/work/.quirky',
    bindHost: '127.0.0.1',
    port: 7777,
    readinessTimeoutMs: 50,
    sleep: async () => {},
    now: () => new Date(clockMs),
    localQuirkydDir: '/local/out/quirkyd',
    target: 'linux-x64-glibc217',
    census: IDLE,
    recountCensus,
    releaseIncumbentAdmission,
    ...(force !== undefined ? { force } : {})
  })
  return { result, recountCensus, releaseIncumbentAdmission }
}

beforeEach(() => {
  vi.clearAllMocks()
  host = FakeQuirkydHost.deployedOld()
  clockMs = Date.parse('2026-02-02T00:00:00.000Z')
  admission = new TerminalUpdateAdmission(async () => [])
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => host.exec(command))
  vi.mocked(acquireInstallLock).mockImplementation(async (_conn, _dir, _host, options) => {
    host.acquireFence(options)
  })
  vi.mocked(writeAtomicQuirkydRemoteRecord).mockImplementation(async (_target, path, contents) =>
    host.write(path, contents)
  )
})

describe("an update's terminal admission fence", () => {
  it('refuses a terminal opened between the last census and the stop, then stops', async () => {
    const refusals: unknown[] = []
    vi.mocked(writeAtomicQuirkydRemoteRecord).mockImplementation(
      async (_target, path, contents) => {
        // A user opens a terminal while the update records its transaction, after the recount.
        if (path.endsWith('transaction.json') && host.alive.has(OLD)) {
          refusals.push(await admission.admit(undefined).catch((error: unknown) => error))
        }
        host.write(path, contents)
      }
    )
    const { result, releaseIncumbentAdmission } = deploy()

    await expect(result).resolves.toMatchObject({ outcome: 'installed-and-activated' })
    expect(refusals[0]).toBeInstanceOf(TerminalUpdateAdmissionClosedError)
    expect([...host.alive]).toEqual([NEW])
    expect(releaseIncumbentAdmission).not.toHaveBeenCalled()
  })

  it.each([
    [LIVE, false, 'quirkyd_update_terminals_running'],
    [{ ...LIVE, inProcessSessions: 1 }, true, 'quirkyd_update_ends_in_process_terminals'],
    [UNREAD, true, 'quirkyd_update_daemon_protocol_unverifiable'],
    [new Error('tunnel closed'), false, 'quirkyd_update_terminal_census_unavailable']
  ])(
    'defers on a recount of %j and reopens admission (force: %s)',
    async (recount, force, code) => {
      const { result, recountCensus } = deploy(recount, force)

      await expect(result).resolves.toMatchObject({ outcome: 'installed-not-activated', code })
      expect(recountCensus).toHaveBeenCalledTimes(1)
      expect([...host.alive]).toEqual([OLD])
      expect(host.commands.some((command) => command.includes('kill -TERM'))).toBe(false)
      // The incumbent keeps serving, so it takes terminals again now, not when the fence lapses.
      expect(admission.isClosed()).toBe(false)
    }
  )

  it('reopens admission when the first mutation after the recount fails before any stop', async () => {
    vi.mocked(writeAtomicQuirkydRemoteRecord).mockImplementation(
      async (_target, path, contents) => {
        if (path.endsWith('transaction.json')) {
          throw new Error('disk full')
        }
        host.write(path, contents)
      }
    )
    const { result, releaseIncumbentAdmission } = deploy()

    await expect(result).rejects.toThrow('disk full')
    expect([...host.alive]).toEqual([OLD])
    expect(releaseIncumbentAdmission).toHaveBeenCalledTimes(1)
    expect(admission.isClosed()).toBe(false)
  })

  it.each([
    ['SIGNAL_FAILED', false],
    ['STILL_RUNNING', true]
  ])(
    'after a stop answering %s, reopens admission only if no stop can still land',
    async (answer, underway) => {
      vi.mocked(execCommand).mockImplementation(async (_conn, command) =>
        command.includes('kill -TERM') ? answer : host.exec(command)
      )
      const { result } = deploy()

      await expect(result).resolves.toMatchObject({ code: 'quirkyd_outgoing_stop_incomplete' })
      expect(admission.isClosed()).toBe(underway)
    }
  )

  it('stops nothing once the fence may have lapsed before the stop could be sent', async () => {
    vi.mocked(writeAtomicQuirkydRemoteRecord).mockImplementation(
      async (_target, path, contents) => {
        if (path.endsWith('transaction.json')) {
          clockMs += QUIRKYD_UPDATE_ADMISSION_STOP_BY_MS + 1
        }
        host.write(path, contents)
      }
    )
    const { result } = deploy()

    await expect(result).resolves.toMatchObject({
      outcome: 'installed-not-activated',
      code: 'quirkyd_update_terminal_census_unavailable'
    })
    expect(host.commands.some((command) => command.includes('kill -TERM'))).toBe(false)
    expect([...host.alive]).toEqual([OLD])
    expect(admission.isClosed()).toBe(false)
  })
})
