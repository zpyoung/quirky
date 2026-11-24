/**
 * One hostile-host cell: on a fresh host, resolve the context, deploy quirkyd, and prove it picked
 * the cell's runtime, uploaded no other and ran no toolchain. An activated server must be live; an
 * unavailable host must fail with the classified reason the connect reports.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { expect } from 'vitest'
import { NODE_RUNTIME_ASSETS, pinnedNodeRuntimeAsset } from '../../../shared/node-runtime-pin'
import { QUIRKYD_MANAGED_REMOTE_PORT } from '../../../shared/quirkyd-managed-runtime'
import { QUIRKYD_RUNTIMES_DIRNAME } from '../../../shared/quirkyd-artifacts'
import type { SshTarget } from '../../../shared/ssh-types'
import { readQuirkydActivationRecord } from '../../managed-server/activation/quirkyd-activation-record-store'
import { classifyQuirkydHostUnavailable } from '../../quirkyd/quirkyd-host-unavailable'
import { managedQuirkydSlot } from '../../managed-server/lifecycle/quirkyd-managed-runtime-context'
import { quirkydSlotDir, type QuirkydSlotOptions } from '../quirkyd-recovery-slot'
import { resolveQuirkydRemoteContext } from '../../managed-server/install/quirkyd-remote-context'
import { deployQuirkyd } from '../quirkyd-remote-deploy'
import { getMainHttpClient, setMainHttpClient } from '../../network/http-client'
import {
  quirkydLivenessProbeCommand,
  parseQuirkydLiveness
} from '../../managed-server/install/quirkyd-remote-launch'
import { execQuirkydRemote } from '../../managed-server/install/quirkyd-remote-runtime-control'
import {
  QUIRKYD_PID_FILENAME,
  QUIRKYD_READINESS_FILENAME
} from '../../managed-server/install/quirkyd-remote-host-support'
import { decommissionRemoteQuirkyd } from '../../managed-server/install/quirkyd-remote-decommission'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  forbiddenToolActions,
  type HostileHostCellCore,
  type ManagedQuirkydExpectation
} from './ssh-hostile-host-cells'
import { connectHostileHost } from './ssh-hostile-host-test-harness'
import { hostExec, hostExecStatus, type HostileHostTarget } from './ssh-hostile-host-test-fixture'

const EMPTY_CENSUS = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }

export async function proveManagedQuirkydCell(
  cell: HostileHostCellCore,
  target: HostileHostTarget,
  sshTarget: SshTarget
): Promise<void> {
  const expected = cell.managed
  const conn = await connectHostileHost(sshTarget)
  try {
    const context = await resolveQuirkydRemoteContext(sshTarget, conn)
    expect(context.serverTarget).toBe(expected.runtime)
    const slot = managedQuirkydSlot(context, QUIRKYD_MANAGED_REMOTE_PORT)
    const desktop = cell.desktopNoEgress ? refuseDesktopDownloads() : null
    const deploy = deployQuirkyd({
      ...slot,
      target: context.serverTarget,
      census: EMPTY_CENSUS,
      recountCensus: async () => EMPTY_CENSUS,
      releaseIncumbentAdmission: async () => {},
      ...(desktop ? { runtimeCacheRoot: desktop.cacheRoot } : {})
    }).finally(() => desktop?.restore())
    if (expected.outcome === 'unavailable') {
      const failure = await deploy.then(
        (deployed) => new Error(`deploy did not fail: ${JSON.stringify(deployed)}`),
        (error: unknown) => error
      )
      expect(classifyQuirkydHostUnavailable(failure), String(failure)).toBe(expected.reason)
    } else {
      const deployed = await deploy
      const slotDir = quirkydSlotDir(slot, deployed.fullVersion)
      await assertOnlyRuntimeUploaded(target, slotDir, expected)
      // The message carries the full reason, which toMatchObject's diff omits.
      expect(deployed, JSON.stringify(deployed)).toMatchObject({
        outcome: 'installed-and-activated'
      })
      await assertLiveThenDecommissioned(slot, slotDir, deployed.fullVersion)
    }
    if (desktop) {
      // With an empty cache and every fetch refused there was nothing to upload, so the host fetched it.
      expect(desktop.refusedUrls().length).toBeGreaterThan(0)
    }
    const toolLog = await hostExec(
      target,
      `cat ${quotePosixShell(target.forbiddenToolLog)} 2>/dev/null || true`
    )
    expect(forbiddenToolActions(toolLog)).toEqual([])
  } finally {
    await conn.disconnect().catch(() => {})
  }
}

/** A default runtime beside the expected one is the wrong upload this cell guards against. */
async function assertOnlyRuntimeUploaded(
  target: HostileHostTarget,
  slotDir: string,
  expected: ManagedQuirkydExpectation
): Promise<void> {
  const runtimes = posix.join(posix.dirname(slotDir), QUIRKYD_RUNTIMES_DIRNAME)
  const runtimeDir = (sha: string): string => posix.join(runtimes, `node-${sha}`)
  const { executableSha256 } = pinnedNodeRuntimeAsset(expected.runtime)
  expect(await hostExecStatus(target, `test -x '${runtimeDir(executableSha256)}/bin/node'`)).toBe(0)
  for (const asset of Object.values(NODE_RUNTIME_ASSETS)) {
    if (asset.executableSha256 !== executableSha256) {
      expect(
        await hostExecStatus(target, `test -e '${runtimeDir(asset.executableSha256)}'`)
      ).not.toBe(0)
    }
  }
}

async function assertLiveThenDecommissioned(
  slot: QuirkydSlotOptions,
  slotDir: string,
  version: string
): Promise<void> {
  const liveness = async (): Promise<string> =>
    parseQuirkydLiveness(
      await execQuirkydRemote(slot, quirkydLivenessProbeCommand(slot.host, slotDir))
    )
  expect(await liveness()).toBe('LIVE')
  await assertQuirkydRunsAtLoginUmask(slot, slotDir)
  const decommission = await decommissionRemoteQuirkyd({
    ...slot,
    record: await readQuirkydActivationRecord(slot),
    census: EMPTY_CENSUS
  })
  expect(decommission, JSON.stringify(decommission)).toMatchObject({
    outcome: 'decommissioned',
    version
  })
  expect(await liveness()).toBe('DEAD')
}

/**
 * #31125: quirkyd runs at the SSH login's umask, so the git, terminals and agents it spawns create
 * the user's files, while the readiness file holding the pairing token stays owner-only.
 * Linux only: macOS has no /proc to read another process's umask from.
 */
async function assertQuirkydRunsAtLoginUmask(
  slot: QuirkydSlotOptions,
  slotDir: string
): Promise<void> {
  if (slot.host.os !== 'linux') {
    return
  }
  const pidFile = quotePosixShell(posix.join(slotDir, QUIRKYD_PID_FILENAME))
  const readiness = quotePosixShell(posix.join(slotDir, QUIRKYD_READINESS_FILENAME))
  const [login, daemon, readinessMode] = (
    await execQuirkydRemote(
      slot,
      `umask; sed -n 's/^Umask:[[:space:]]*//p' "/proc/$(cat ${pidFile})/status"; stat -c %a ${readiness}`
    )
  )
    .trim()
    .split('\n')
    .map((line) => line.trim())
  expect(Number.parseInt(daemon ?? '', 8), `login ${login}, quirkyd ${daemon}`).toBe(
    Number.parseInt(login ?? '', 8)
  )
  expect(readinessMode).toBe('600')
}

/** An empty runtime cache and a refusing network on this computer, until `restore`. */
function refuseDesktopDownloads(): {
  cacheRoot: string
  refusedUrls: () => string[]
  restore: () => void
} {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'quirky-hostile-desktop-no-egress-'))
  const refused: string[] = []
  const previous = getMainHttpClient()
  setMainHttpClient({
    fetch: async (url) => {
      refused.push(url)
      throw new Error('net::ERR_CONNECTION_REFUSED')
    },
    proxySession: () => null
  })
  return {
    cacheRoot,
    refusedUrls: () => refused,
    restore: () => {
      setMainHttpClient(previous)
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  }
}
