import { describe, expect, it } from 'vitest'
import { QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV } from '../../../shared/quirkyd-managed-launch-env'

import {
  QUIRKYD_READINESS_FILENAME,
  QuirkydRemoteLaunchUnsupportedError
} from './quirkyd-remote-host-support'
import {
  quirkydLaunchCommand,
  quirkydLivenessBlocksGc,
  quirkydLivenessProvenExited,
  quirkydLivenessProbeCommand,
  parseQuirkydLiveness,
  parseQuirkydReadinessOutput
} from './quirkyd-remote-launch'
import {
  quirkydStopFreedTheHost,
  parseQuirkydStopOutcome,
  stopQuirkydCommand
} from './quirkyd-remote-process-control'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')

const SPEC = {
  remoteInstallDir: '/home/u/.quirky-remote/quirkyd-0.2.0+bb01',
  nodePath: '/usr/bin/node',
  fullVersion: '0.2.0+bb01',
  userDataDir: '/home/u/.quirky',
  bindHost: '127.0.0.1',
  port: 7777,
  activationRoot: '/home/u/.quirky-remote/.quirkyd-activation-transaction'
}

const READY_LINE = JSON.stringify({
  type: 'quirky_server_ready',
  schemaVersion: 1,
  runtimeId: 'r1',
  boundEndpoint: 'ws://127.0.0.1:7777',
  advertisedEndpoint: null,
  managedWslCliReconciliation: 'settled',
  pairing: { available: false, reason: 'disabled_by_operator', guidance: 'n/a' },
  health: { buildHash: 'abc', terminalDaemon: { state: 'live' } }
})

describe('quirkydLaunchCommand', () => {
  it('states the bind posture rather than inheriting the build default', () => {
    expect(quirkydLaunchCommand(posix, SPEC)).toContain("--bind '127.0.0.1'")
  })

  it('truncates the readiness file, so a stale line cannot be activated on', () => {
    const command = quirkydLaunchCommand(posix, SPEC)
    const cd = command.indexOf(`cd '${SPEC.remoteInstallDir}'`)
    const truncate = command.indexOf(`: > '${QUIRKYD_READINESS_FILENAME}'`)
    const launch = command.indexOf('nohup')
    expect(cd).toBeGreaterThan(-1)
    expect(truncate).toBeGreaterThan(cd)
    expect(truncate).toBeLessThan(launch)
  })

  it('exports the version and the shared data root the deploy decided on', () => {
    const command = quirkydLaunchCommand(posix, SPEC)
    expect(command).toContain(`QUIRKY_VERSION '${SPEC.fullVersion}'`.replace(' ', '='))
    expect(command).toContain(`QUIRKY_USER_DATA='${SPEC.userDataDir}'`)
  })

  it('names the activation fence on every launch, which enables idle exit', () => {
    const command = quirkydLaunchCommand(posix, SPEC)
    expect(command).toContain(`${QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV}='${SPEC.activationRoot}'`)
    expect(command.indexOf(QUIRKYD_MANAGED_ACTIVATION_ROOT_ENV)).toBeLessThan(
      command.indexOf('nohup')
    )
  })

  it('declares the Windows refusal instead of emitting a command that cannot work', () => {
    expect(() => quirkydLaunchCommand(windows, SPEC)).toThrow(QuirkydRemoteLaunchUnsupportedError)
  })
})

describe('readiness parsing', () => {
  it('extracts the quirky_server_ready payload', () => {
    const parsed = parseQuirkydReadinessOutput(`${READY_LINE}\n`)
    expect(parsed).toMatchObject({ state: 'ready' })
    expect(parsed.state === 'ready' && parsed.readiness.boundEndpoint).toBe('ws://127.0.0.1:7777')
  })

  it('treats an empty or half-written file as pending, not as a failure', () => {
    expect(parseQuirkydReadinessOutput('')).toEqual({ state: 'pending' })
    expect(parseQuirkydReadinessOutput('{"type":"quirky_serv')).toEqual({ state: 'pending' })
  })

  it('reports a complete JSON line that is not a readiness payload as malformed', () => {
    expect(parseQuirkydReadinessOutput('{"type":"something_else"}')).toMatchObject({
      state: 'malformed'
    })
  })
})

describe('liveness', () => {
  it('reads the pid recorded in the version dir', () => {
    expect(quirkydLivenessProbeCommand(posix, SPEC.remoteInstallDir)).toContain('.quirkyd-pid')
  })

  it.each([
    ['LIVE', 'LIVE', true],
    ['DEAD', 'DEAD', false],
    ['NEVER_LAUNCHED', 'NEVER_LAUNCHED', false],
    ['', 'UNKNOWN', true],
    ['garbage', 'UNKNOWN', true]
  ])('parses %s and blocks GC = %s', (output, expected, blocks) => {
    expect(parseQuirkydLiveness(output)).toBe(expected)
    expect(quirkydLivenessBlocksGc(parseQuirkydLiveness(output))).toBe(blocks)
  })

  it.each([
    ['DEAD', true],
    ['NEVER_LAUNCHED', true],
    ['LIVE', false],
    ['UNKNOWN', false]
  ] as const)('%s is proven exit = %s', (liveness, exited) => {
    expect(quirkydLivenessProvenExited(liveness)).toBe(exited)
  })
})

describe('stopping a running quirkyd', () => {
  it('sends SIGTERM and never SIGKILL', () => {
    const command = stopQuirkydCommand(posix, SPEC.remoteInstallDir, {
      waitSeconds: 20,
      nodePath: SPEC.nodePath
    })
    expect(command).toContain('kill -TERM')
    for (const kill of ['kill -9', 'kill -KILL', 'kill -SIGKILL', 'pkill']) {
      expect(command).not.toContain(kill)
    }
  })

  it.each([
    ['STOPPED', 'stopped', true],
    ['ALREADY_EXITED', 'already-exited', true],
    ['NO_PID', 'no-pid', false],
    ['STILL_RUNNING', 'still-running', false],
    ['SIGNAL_FAILED', 'signal-failed', false],
    ['UNKNOWN', 'unknown', false],
    ['SIGNALED\nUNKNOWN', 'unconfirmed', false],
    ['', 'unconfirmed', false]
  ])('parses %s and frees the host = %s', (output, expected, frees) => {
    expect(parseQuirkydStopOutcome(output)).toBe(expected)
    expect(quirkydStopFreedTheHost(parseQuirkydStopOutcome(output))).toBe(frees)
  })
})
