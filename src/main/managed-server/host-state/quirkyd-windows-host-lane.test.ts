// Managed quirkyd on a real Win32-OpenSSH host, one cell per DefaultShell: resolve the context
// (pinned node.exe, host script), deploy and activate, prove readiness and liveness, reach quirkyd
// through the stdio bridge (this account's sshd refuses forwarding), decommission through the
// instance-bound stop request, prove exit, and run a GC pass.
// config/ci/windows-ssh-provider/invoke-windows-host-cells.ps1 provisions the account and runs this
// file for `quirkyd-*` cells; ssh-windows-hosts.yml runs that.
//
// Run: QUIRKY_RUN_SSH_WINDOWS_HOST=1 QUIRKY_SSH_WINDOWS_HOST_CELL=<descriptor.json> pnpm test <this file>
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { SshConnection } from '../../ssh/connection/ssh-connection'
import {
  connectHostileHost,
  installHostileHostAppEnvironment
} from '../../ssh/hostile-host-test-support/ssh-hostile-host-test-harness'
import { resolveQuirkydRemoteContext } from '../install/quirkyd-remote-context'
import { proveWindowsStdioBridge } from '../../ssh/quirkyd-windows-stdio-bridge-test-cell'
import { deployQuirkyd } from '../../ssh/quirkyd-remote-deploy'
import { quirkydLivenessProbeCommand, parseQuirkydLiveness } from '../install/quirkyd-remote-launch'
import { quirkydSlotDir, type QuirkydSlotOptions } from '../../ssh/quirkyd-recovery-slot'
import { decommissionRemoteQuirkyd } from '../install/quirkyd-remote-decommission'
import { readQuirkydActivationRecord } from '../activation/quirkyd-activation-record-store'
import { gcOldQuirkydVersions } from '../install/quirkyd-remote-gc'
import { execQuirkydRemote } from '../install/quirkyd-remote-runtime-control'
import { quirkydWindowsNodeCommandLine } from '../install/quirkyd-remote-windows-node'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'
import {
  isWindowsQuirkydCellId,
  readWindowsHostCellDescriptor,
  windowsHostSshTarget
} from '../../ssh/ssh-windows-host-cells'

const RUN = process.env.QUIRKY_RUN_SSH_WINDOWS_HOST === '1'
const CELL_TIMEOUT_MS = 20 * 60_000

/** Quirkyd's own host ops and launches: these must never take a PowerShell hop. */
function isQuirkydHostCommand(command: string): boolean {
  return /quirkyd-host-script-[0-9a-f]{16}\.js|[\\/]quirkyd\.js /u.test(command)
}

describe.runIf(RUN)('managed quirkyd on a Windows OpenSSH host', () => {
  let cleanupAppEnvironment: (() => void) | null = null

  beforeAll(() => {
    cleanupAppEnvironment = installHostileHostAppEnvironment()
  })

  afterAll(() => {
    cleanupAppEnvironment?.()
  })

  it(
    'deploys, serves, decommissions by request and exits',
    async () => {
      const descriptor = readWindowsHostCellDescriptor(
        process.env.QUIRKY_SSH_WINDOWS_HOST_CELL ?? ''
      )
      if (!isWindowsQuirkydCellId(descriptor.cell)) {
        throw new Error(`${descriptor.cell} is not a managed quirkyd cell`)
      }
      const sshTarget = windowsHostSshTarget(descriptor, randomUUID())
      let exec: MockInstance<SshConnection['exec']> | null = null
      const receipt: Record<string, unknown> = { cell: descriptor.cell, target: descriptor.target }
      let conn: SshConnection | null = null
      try {
        conn = await connectHostileHost(sshTarget)
        exec = vi.spyOn(SshConnection.prototype, 'exec')
        const context = await resolveQuirkydRemoteContext(sshTarget, conn)
        expect(context.host.os).toBe('win32')
        const options: QuirkydSlotOptions = {
          conn,
          host: context.host,
          remoteHome: context.remoteHome,
          nodePath: 'node',
          userDataDir: context.userDataDir,
          bindHost: '127.0.0.1',
          port: 0
        }
        const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
        const deployed = await deployQuirkyd({
          ...options,
          target: context.serverTarget,
          census: idle,
          recountCensus: async () => idle,
          releaseIncumbentAdmission: async () => {}
        })
        receipt.deploy = deployed
        expect(deployed.outcome).toBe('installed-and-activated')
        const slotDir = quirkydSlotDir(options, deployed.fullVersion)
        const liveness = async () =>
          parseQuirkydLiveness(
            await execQuirkydRemote(options, quirkydLivenessProbeCommand(options.host, slotDir))
          )
        expect(await liveness()).toBe('LIVE')
        // Managed terminals' `quirky`: the native launcher quirkyd installed in its profile.
        const cli = joinRemotePath(options.host, context.userDataDir, 'cli', 'bin', 'quirky.exe')
        const status = JSON.parse(
          await execQuirkydRemote(options, quirkydWindowsNodeCommandLine(cli, ['status', '--json']))
        )
        receipt.cliStatus = status.result
        expect(status.result.runtime).toMatchObject({ reachable: true })
        expect(status.result.app.desktopWindowStatus).toBe('blocked')
        // The managed tunnel picks the stdio bridge on this account and reaches quirkyd through it.
        receipt.stdioBridge = await proveWindowsStdioBridge(conn, options.host, slotDir)
        expect(receipt.stdioBridge).toMatchObject({
          forwarding: 'refused',
          response: expect.stringMatching(/^HTTP\/1\.1 101/u)
        })
        // Decommission stops it by the instance-bound request quirkyd itself completes and proves.
        const record = await readQuirkydActivationRecord(options)
        receipt.decommission = await decommissionRemoteQuirkyd({
          ...options,
          record,
          census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
        })
        // The message carries the refusal code and reason, which toMatchObject's diff omits.
        expect(receipt.decommission, JSON.stringify(receipt.decommission)).toMatchObject({
          outcome: 'decommissioned',
          version: deployed.fullVersion
        })
        expect(await liveness()).toBe('DEAD')
        // A GC pass after decommission must leave the recorded previous slot in place.
        await gcOldQuirkydVersions({
          conn,
          host: options.host,
          remoteHome: options.remoteHome,
          currentDirAbsPath: slotDir,
          record: await readQuirkydActivationRecord(options)
        })
        expect(await liveness()).toBe('DEAD')

        const commands = exec.mock.calls.map(([command]) => String(command))
        const quirkydCommands = commands.filter(isQuirkydHostCommand)
        receipt.quirkydCommands = quirkydCommands.length
        receipt.powershellCommands = commands.filter((command) =>
          /^powershell\.exe /iu.test(command)
        ).length
        expect(quirkydCommands.length).toBeGreaterThan(0)
        for (const command of quirkydCommands) {
          expect(command).not.toMatch(/EncodedCommand/u)
        }
        receipt.passed = true
      } finally {
        exec?.mockRestore()
        await conn?.disconnect().catch(() => {})
        writeFileSync(descriptor.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
      }
    },
    CELL_TIMEOUT_MS
  )
})
