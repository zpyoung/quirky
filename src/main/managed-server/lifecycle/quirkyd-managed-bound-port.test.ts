import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuirkydHostTransport } from '../../ssh/quirkyd-host-transport'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

const execQuirkydRemote = vi.hoisted(() => vi.fn())
vi.mock('../install/quirkyd-remote-runtime-control', () => ({ execQuirkydRemote }))
const resolveQuirkydRemoteContext = vi.hoisted(() => vi.fn())
vi.mock('../install/quirkyd-remote-context', () => ({ resolveQuirkydRemoteContext }))

import {
  quirkydBoundPort,
  readManagedQuirkydBoundPort,
  resolveManagedQuirkydTunnelPort
} from './quirkyd-managed-bound-port'
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'

function readinessLine(boundEndpoint: string | null): string {
  return `${JSON.stringify({ type: 'quirky_server_ready', runtimeId: 'runtime-1', boundEndpoint })}\n`
}

function slot() {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exec is mocked; the connection is never used.
    conn: {} as QuirkydHostTransport,
    host: getRemoteHostPlatform('linux-x64'),
    remoteInstallDir: '/home/deploy/.quirky-quirkyd/1.0.0'
  }
}

describe('quirkydBoundPort', () => {
  it('reads the port quirkyd actually bound', () => {
    expect(quirkydBoundPort({ boundEndpoint: 'ws://127.0.0.1:58520' })).toBe(58_520)
  })

  it.each([null, 'not a url', 'ws://127.0.0.1'])('returns null for %s', (boundEndpoint) => {
    expect(quirkydBoundPort({ boundEndpoint })).toBeNull()
  })
})

describe('readManagedQuirkydBoundPort', () => {
  beforeEach(() => {
    execQuirkydRemote.mockReset()
  })

  it('follows quirkyd off a preferred port another runtime holds', async () => {
    execQuirkydRemote.mockResolvedValue(readinessLine('ws://127.0.0.1:58520'))
    await expect(readManagedQuirkydBoundPort(slot(), 6_768)).resolves.toBe(58_520)
  })

  it.each([
    ['no readiness file', ''],
    ['a readiness without an endpoint', readinessLine(null)]
  ])('falls back to the preferred port for %s (older builds)', async (_label, output) => {
    execQuirkydRemote.mockResolvedValue(output)
    await expect(readManagedQuirkydBoundPort(slot(), 6_768)).resolves.toBe(6_768)
  })

  it('surfaces a failed host read instead of guessing a port', async () => {
    execQuirkydRemote.mockImplementation(async () => {
      throw new Error('channel closed')
    })
    await expect(readManagedQuirkydBoundPort(slot(), 6_768)).rejects.toThrow('channel closed')
  })
})

describe('resolveManagedQuirkydTunnelPort', () => {
  const link = {
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 1,
    localPort: 46_768,
    remotePort: 6_768
  }
  function input(kind: 'quirkydDeployment' | 'sshAccess') {
    return {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only the link fields.
      environment: { [kind]: link } as unknown as KnownRuntimeEnvironment,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: passed through to the mocked context.
      target: { id: 'ssh-1' } as SshTarget,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: passed through to the mocked context.
      connection: {} as QuirkydHostTransport
    }
  }

  beforeEach(() => {
    execQuirkydRemote.mockReset()
    resolveQuirkydRemoteContext.mockReset()
  })

  it('reads the active slot of a managed server', async () => {
    resolveQuirkydRemoteContext.mockResolvedValue({
      activationRecord: { active: '1.0.0+abc' },
      connection: {},
      host: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/deploy'
    })
    execQuirkydRemote.mockResolvedValue(readinessLine('ws://127.0.0.1:58520'))
    await expect(resolveManagedQuirkydTunnelPort(input('quirkydDeployment'))).resolves.toBe(58_520)
  })

  it('keeps the configured port for independent SSH access without touching the host', async () => {
    await expect(resolveManagedQuirkydTunnelPort(input('sshAccess'))).resolves.toBe(6_768)
    expect(resolveQuirkydRemoteContext).not.toHaveBeenCalled()
  })

  it('tries the preferred port when the host cannot be read; the identity check still guards it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveQuirkydRemoteContext.mockRejectedValue(new Error('platform probe failed'))
    await expect(resolveManagedQuirkydTunnelPort(input('quirkydDeployment'))).resolves.toBe(6_768)
    warn.mockRestore()
  })
})
