import { describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@quirky/process-host/process-spec'
import { resolveQuirkydLegacyKeyringReader } from './quirkyd-legacy-keyring-key'

function result(partial: Partial<ProcessResult>): ProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...partial
  }
}

describe('resolveQuirkydLegacyKeyringReader', () => {
  it('reads no keyring on Windows, or on Linux without a session bus', () => {
    expect(resolveQuirkydLegacyKeyringReader('win32', {})).toBeNull()
    expect(resolveQuirkydLegacyKeyringReader('linux', {})).toBeNull()
    expect(
      resolveQuirkydLegacyKeyringReader('linux', {
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x'
      })
    ).not.toBeNull()
  })

  it('macOS: looks the key up with a bounded timeout and reports a locked or slow Keychain', async () => {
    const runner = vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>()
    const read = resolveQuirkydLegacyKeyringReader('darwin', {}, runner)
    if (!read) {
      throw new Error('expected a macOS reader')
    }
    runner.mockResolvedValueOnce(result({ stdout: 'a2V5\n' }))
    expect(await read('acct')).toEqual({ key: 'a2V5' })
    expect(runner.mock.calls[0][0]).toMatchObject({
      program: '/usr/bin/security',
      args: ['find-generic-password', '-s', 'quirky-headless-secret-store', '-w', '-a', 'acct'],
      timeoutMs: 5_000
    })
    // errSecInteractionNotAllowed: locked, with no UI allowed.
    runner.mockResolvedValueOnce(result({ code: 36, stderr: 'User interaction is not allowed.' }))
    expect(await read('acct')).toEqual({ failure: 'exited 36' })
    runner.mockResolvedValueOnce(result({ code: null, timedOut: true }))
    expect(await read('acct')).toEqual({ failure: 'timed out after 5s' })
  })

  it('Linux: treats a spawn failure as unreadable rather than throwing', async () => {
    const runner = vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>()
    const read = resolveQuirkydLegacyKeyringReader(
      'linux',
      { DBUS_SESSION_BUS_ADDRESS: 'x' },
      runner
    )
    if (!read) {
      throw new Error('expected a Linux reader')
    }
    runner.mockRejectedValueOnce(new Error('spawn secret-tool ENOENT'))
    expect(await read('acct')).toEqual({ failure: 'spawn secret-tool ENOENT' })
  })
})
