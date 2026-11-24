import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot-reader'
import {
  confirmShellForegroundProcess,
  resolveAgentForegroundProcess,
  resolveAgentForegroundProcessWithAvailability
} from './agent-foreground-process'
// Why: the POSIX reader wraps execFile with promisify, so the mock must honor
// the Node callback contract — invoke the last arg with (err, { stdout, stderr }).
function mockPs(stdout: string): void {
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
    callback(null, { stdout, stderr: '' })
  })
}

describe('resolveAgentForegroundProcess', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  afterEach(() => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('does not report a suspended agent when a non-agent holds the foreground', async () => {
    // shell pid 100. vim (pid 102) holds the terminal foreground ('+'); a
    // suspended codex (pid 101, stat 'T', no '+') is a backgrounded descendant.
    mockPs(
      [
        '101 100 T    node /Users/dev/.nvm/versions/node/bin/codex',
        '102 100 S+   vim notes.txt'
      ].join('\n')
    )

    await expect(resolveAgentForegroundProcess(100, 'vim')).resolves.toBe('vim')
  })

  it('still reports a foreground agent', async () => {
    mockPs(['101 100 S+   node /Users/dev/.nvm/versions/node/bin/codex'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'node')).resolves.toBe('codex')
  })

  // Why: OMP embeds Pi, but the outer process is the user-visible identity (#6364).
  it('reports the outer omp wrapper, not the wrapped pi child', async () => {
    mockPs(['101 100 S+   omp', '102 101 S+   pi'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'omp')).resolves.toBe('omp')
  })

  it('reports omp even when the wrapped pi child holds the foreground alone', async () => {
    // Why: across command boundaries only the deeper `pi` carries `+`; the
    // wrapper identity must stay omp regardless of which frame we sampled.
    mockPs(['101 100 S    omp', '102 101 S+   pi'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'omp')).resolves.toBe('omp')
  })

  it('reports bare pi when no omp wrapper is present', async () => {
    mockPs(['101 100 S+   pi'].join('\n'))

    await expect(resolveAgentForegroundProcess(100, 'pi')).resolves.toBe('pi')
  })

  it('treats a fresh POSIX snapshot missing the PTY root as unavailable', async () => {
    mockPs('101 999 S+ node /Users/dev/.nvm/versions/node/bin/codex')

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'zsh', { fresh: true })
    ).resolves.toEqual({ available: false, processName: 'zsh' })
  })

  it('treats failed POSIX scans as unavailable', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(new Error('ps unavailable'), { stdout: '', stderr: '' })
      }
    )

    await expect(
      resolveAgentForegroundProcessWithAvailability(100, 'zsh', { fresh: true })
    ).resolves.toEqual({ available: false, processName: 'zsh' })
    await expect(resolveAgentForegroundProcessWithAvailability(100, 'zsh')).resolves.toEqual({
      available: false,
      processName: 'zsh'
    })
    await expect(resolveAgentForegroundProcess(100, 'zsh')).resolves.toBe('zsh')
  })

  it('confirms a quoted login shell only when its fresh PTY tree contains shells', async () => {
    mockPs(['100 99 100 100 Ss+ "/bin/zsh" -l', '101 100 101 100 S+ /bin/bash'].join('\n'))

    await expect(confirmShellForegroundProcess(100, 'zsh')).resolves.toBe(true)
  })

  it('uses spawned-shell identity instead of a lagging foreground child label', async () => {
    mockPs(['100 99 100 100 Ss+ /bin/zsh -l'].join('\n'))

    await expect(confirmShellForegroundProcess(100, '/bin/zsh')).resolves.toBe(true)
  })

  it('confirms the spawned shell behind a login wrapper while prompt hooks run', async () => {
    mockPs(
      [
        '100 99 100 101 Ss /usr/bin/login -pfl developer /bin/zsh',
        '101 100 101 101 S+ -zsh',
        '102 101 101 101 S+ (zsh)',
        '103 102 101 101 S+ (sed)',
        '104 102 101 101 R+ (git)'
      ].join('\n')
    )

    await expect(confirmShellForegroundProcess(100, '/bin/zsh')).resolves.toBe(true)
  })

  it('rejects a foreground nested shell while the spawned shell remains suspended', async () => {
    mockPs(
      [
        '100 99 100 102 Ss /usr/bin/login -pfl developer /bin/zsh',
        '101 100 101 102 S -zsh',
        '102 101 102 102 S+ agent-tui',
        '103 102 102 102 S+ /bin/zsh -i'
      ].join('\n')
    )

    await expect(confirmShellForegroundProcess(100, '/bin/zsh')).resolves.toBe(false)
  })

  it('rejects shell ownership while a TUI and its nested shell remain in the PTY tree', async () => {
    mockPs(
      [
        '100 99 100 101 Ss /bin/zsh -l',
        '101 100 101 101 S+ /usr/local/bin/agent-tui',
        '102 101 101 101 S+ /bin/bash -i'
      ].join('\n')
    )

    await expect(confirmShellForegroundProcess(100, 'zsh')).resolves.toBe(false)
  })

  it('rejects shell ownership while a stopped TUI remains resumable', async () => {
    mockPs(['100 99 100 100 Ss+ /bin/zsh -l', '101 100 101 100 T agent-tui'].join('\n'))

    await expect(confirmShellForegroundProcess(100, 'zsh')).resolves.toBe(false)
  })

  it('fails open when fresh shell ownership inspection is unavailable', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: unknown) => {
        const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
        callback(new Error('ps unavailable'), { stdout: '', stderr: '' })
      }
    )

    await expect(confirmShellForegroundProcess(100, 'zsh')).resolves.toBe(false)
  })

  it('does not report Claude print-mode hook descendants as foreground agents', async () => {
    mockPs(
      [
        '100 99 Ss   bash -i',
        '101 100 S+   claude --print --model haiku Analyze this conversation and determine next work'
      ].join('\n')
    )

    await expect(resolveAgentForegroundProcess(100, 'bash')).resolves.toBe('bash')
  })

  it('does not report a stopped agent after the shell regains foreground', async () => {
    mockPs(
      ['100 99 Ss+  bash -i', '101 100 T    node /Users/dev/.nvm/versions/node/bin/codex'].join(
        '\n'
      )
    )

    await expect(resolveAgentForegroundProcess(100, 'bash')).resolves.toBe('bash')
  })

  it('falls back to recognized descendants when no process in the PTY tree holds foreground', async () => {
    // No '+' marker at all (e.g. a detached/daemon descendant tree) — the
    // recognized agent may still be the best available signal.
    mockPs(
      ['100 99 Ss   bash -i', '101 100 S    node /Users/dev/.nvm/versions/node/bin/codex'].join(
        '\n'
      )
    )

    await expect(resolveAgentForegroundProcess(100, 'node')).resolves.toBe('codex')
  })
})
