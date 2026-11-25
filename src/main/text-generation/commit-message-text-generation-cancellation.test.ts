import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateCommitMessageFromContext } from './commit-message-text-generation'
import { withPlatform } from './commit-message-text-generation-test-harness'

const { terminateWindowsProcessTreeMock } = vi.hoisted(() => ({
  terminateWindowsProcessTreeMock: vi.fn(async () => {})
}))

vi.mock('../windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: terminateWindowsProcessTreeMock
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn)
  }
})

const spawnMock = vi.mocked(spawn)

// These suites drive fake children down the Windows direct-child path, taskkill included. The POSIX
// supervised stop with the Codex home lock (generation: timeout, cancel, output limit; discovery:
// timeout, output limit) is in source-control-local-process.test.ts.
const hostPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  vi.unstubAllEnvs()
})

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  // Windows resolves a bare agent name on PATH; the host's own installs must not answer it.
  vi.stubEnv('PATH', '')
  terminateWindowsProcessTreeMock.mockClear()
  terminateWindowsProcessTreeMock.mockResolvedValue(undefined)
  spawnMock.mockClear()
})

describe('generateCommitMessageFromContext on the Windows direct-child path', () => {
  it('fails clearly before spawning when a jcode argv prompt exceeds the Windows command line', async () => {
    await withPlatform('win32', async () => {
      const pending = generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M\tREADME.md',
          stagedPatch: `+${'x'.repeat(40_000)}`
        },
        {
          agentId: 'jcode',
          model: 'default'
        },
        {
          kind: 'local',
          cwd: '/repo',
          env: { ...process.env }
        }
      )

      await expect(pending).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('too large for the Windows command line')
      })
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })

  it('fails clearly before spawning when a jcode argv prompt exceeds the Linux single-argument cap', async () => {
    await withPlatform('linux', async () => {
      const pending = generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M\tREADME.md',
          // Why past 120 KiB and not the Windows 30k: Linux fails on ONE argument
          // over MAX_ARG_STRLEN, which is far larger than the Windows line budget.
          stagedPatch: `+${'x'.repeat(140_000)}`
        },
        { agentId: 'jcode', model: 'default' },
        { kind: 'local', cwd: '/repo', env: { ...process.env } }
      )

      await expect(pending).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('single command-line argument')
      })
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })

  it('still spawns on Linux for a prompt that only Windows would refuse', async () => {
    await withPlatform('linux', async () => {
      // 40k chars trips the Windows line budget but is far under the Linux per-arg cap,
      // so the guard must not have become a lowest-common-denominator limit.
      await generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M\tREADME.md',
          stagedPatch: `+${'x'.repeat(40_000)}`
        },
        { agentId: 'jcode', model: 'default' },
        { kind: 'local', cwd: '/repo', env: { ...process.env } }
      )
      expect(spawnMock).toHaveBeenCalled()
    })
  })
})
