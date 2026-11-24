import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { QUIRKYD_PID_FILENAME, QUIRKYD_READINESS_FILENAME } from './quirkyd-remote-host-support'
import { quirkydLaunchCommand, type QuirkydLaunchSpec } from './quirkyd-remote-launch'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { QUIRKYD_WSL_HOST_ENV } from '../../ipc/wsl-guest-windows-drive-path'

const host = getRemoteHostPlatform('linux-x64')

function spec(remoteInstallDir: string, nodePath = '/usr/bin/node'): QuirkydLaunchSpec {
  return {
    remoteInstallDir,
    nodePath,
    fullVersion: '0.2.0+bb01',
    userDataDir: '/home/u/.quirky',
    bindHost: '127.0.0.1',
    port: 7777,
    activationRoot: '/home/u/.quirky-remote/.quirkyd-activation-transaction'
  }
}

describe('the WSL launch (setsid)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: `nohup … &` is killed when its `wsl.exe --exec` exits on a distro without systemd.
  it('never backgrounds under nohup, and starts the runtime in a session of its own', () => {
    const command = quirkydLaunchCommand(
      host,
      spec('/home/u/.quirky-remote/quirkyd-0.2.0+bb01'),
      'setsid'
    )
    expect(command).not.toContain('nohup')
    expect(command).toContain('setsid -f "$@"')
    // busybox has no `-f`; a background child of a non-interactive shell can still setsid.
    expect(command).toContain('else setsid "$@" & fi')
    expect(command).toContain(`${QUIRKYD_WSL_HOST_ENV}=1 sh -c`)
  })

  it('has the child record its own PID, since the setsid -f parent exits at once', () => {
    const command = quirkydLaunchCommand(host, spec('/d/quirkyd-1'), 'setsid')
    const removeStale = command.indexOf(`rm -f '/d/quirkyd-1/${QUIRKYD_PID_FILENAME}'`)
    const recordOwn = command.indexOf(`echo $$ > "$1" && umask "$2" && shift 2 && exec "$@"`)
    expect(removeStale).toBeGreaterThan(-1)
    expect(recordOwn).toBeGreaterThan(removeStale)
    expect(command.trimEnd().endsWith(`cat '/d/quirkyd-1/${QUIRKYD_PID_FILENAME}'`)).toBe(true)
  })

  it('passes host facts the guest cannot read, quoted, and refuses a malformed name', () => {
    const command = quirkydLaunchCommand(host, spec('/d/quirkyd-1'), 'setsid', [
      ['QUIRKY_WSL_DISTRO_GUID', "abc'd"]
    ])
    expect(command).toContain(`${QUIRKYD_WSL_HOST_ENV}=1 QUIRKY_WSL_DISTRO_GUID='abc'\\''d' sh -c`)
    expect(() =>
      quirkydLaunchCommand(host, spec('/d/quirkyd-1'), 'setsid', [['BAD NAME', 'x']])
    ).toThrow('quirkyd_launch_env_name_invalid')
  })

  it('keeps the SSH launch byte-for-byte when no detach is named', () => {
    const ssh = quirkydLaunchCommand(host, spec('/d/quirkyd-1'))
    expect(ssh).toBe(quirkydLaunchCommand(host, spec('/d/quirkyd-1'), 'nohup'))
    expect(ssh).toContain('exec nohup "$quirkyd_runtime"')
    expect(ssh).not.toContain('setsid')
    expect(ssh).not.toContain(QUIRKYD_WSL_HOST_ENV)
  })

  it.skipIf(process.platform !== 'linux')(
    'really detaches: the recorded PID is the runtime, in a new session, and writes readiness',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'quirkyd-setsid-'))
      dirs.push(dir)
      const runtime = join(dir, 'fake-node')
      writeFileSync(runtime, `#!/bin/sh\necho '{"type":"quirky_server_ready"}'\nsleep 30\n`)
      chmodSync(runtime, 0o755)
      const out = execFileSync('sh', [
        '-c',
        quirkydLaunchCommand(host, spec(dir, runtime), 'setsid')
      ])
      const pid = Number(out.toString().trim())
      try {
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        expect(readFileSync(join(dir, QUIRKYD_PID_FILENAME), 'utf8').trim()).toBe(String(pid))
        const ps = (field: string, target: number): string =>
          execFileSync('ps', ['-o', `${field}=`, '-p', String(target)])
            .toString()
            .trim()
        expect(ps('args', pid)).toContain(join(dir, 'quirkyd.js'))
        expect(ps('sid', pid)).toBe(String(pid))
        expect(ps('sid', pid)).not.toBe(ps('sid', process.pid))
        for (
          let i = 0;
          i < 50 && !readFileSync(join(dir, QUIRKYD_READINESS_FILENAME), 'utf8');
          i++
        ) {
          execFileSync('sleep', ['0.05'])
        }
        expect(readFileSync(join(dir, QUIRKYD_READINESS_FILENAME), 'utf8')).toContain(
          'quirky_server_ready'
        )
      } finally {
        try {
          process.kill(pid)
        } catch {
          // Already gone.
        }
      }
    }
  )

  // Regression (#31125): git, terminals and agents the daemon spawns create the user's files.
  it.skipIf(process.platform !== 'linux')(
    'runs the daemon at the login umask while its PID and readiness files stay owner-only',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'quirkyd-setsid-umask-'))
      dirs.push(dir)
      const runtime = join(dir, 'fake-node')
      writeFileSync(runtime, `#!/bin/sh\n: > daemon-file\necho '{"type":"quirky_server_ready"}'\n`)
      chmodSync(runtime, 0o755)
      const command = quirkydLaunchCommand(host, spec(dir, runtime), 'setsid')
      execFileSync('sh', ['-c', `umask 022; ${command}`])
      for (let i = 0; i < 50 && !readFileSync(join(dir, QUIRKYD_READINESS_FILENAME), 'utf8'); i++) {
        execFileSync('sleep', ['0.05'])
      }
      const mode = (name: string): number => statSync(join(dir, name)).mode & 0o777
      expect(mode('daemon-file')).toBe(0o644)
      expect(mode(QUIRKYD_PID_FILENAME)).toBe(0o600)
      expect(mode(QUIRKYD_READINESS_FILENAME)).toBe(0o600)
    }
  )
})
