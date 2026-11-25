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
  it('passes prepared provider environment to local agent subprocesses', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'quirky-test-agent-nope'
      },
      {
        kind: 'local',
        cwd: '/repo',
        env: { ...process.env, CODEX_HOME: '/managed/codex-home' }
      }
    )

    listeners.get('stdout:data')?.(Buffer.from('Add README note\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      message: 'Add README note'
    })
    expect(spawnMock).toHaveBeenCalledWith(
      'quirky-test-agent-nope',
      [],
      expect.objectContaining({
        env: expect.objectContaining({ CODEX_HOME: '/managed/codex-home' })
      })
    )
  })

  it('routes Windows batch-script agent commands through cmd.exe', async () => {
    const originalComSpec = process.env.ComSpec
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    try {
      await withPlatform('win32', async () => {
        const listeners = new Map<string, (value: unknown) => void>()
        const child = {
          pid: 123,
          kill: vi.fn(),
          stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
          stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
          stdin: { end: vi.fn() },
          on: vi.fn((event, callback) => listeners.set(event, callback))
        }
        spawnMock.mockReturnValue(child as never)

        const pending = generateCommitMessageFromContext(
          {
            branch: 'main',
            stagedSummary: 'M\tREADME.md',
            stagedPatch: '+hello'
          },
          {
            agentId: 'custom',
            model: '',
            customAgentCommand: 'C:/tools/agent.cmd'
          },
          {
            kind: 'local',
            cwd: 'C:\\repo'
          }
        )

        listeners.get('stdout:data')?.(Buffer.from('Update README\n'))
        listeners.get('close')?.(0)

        await expect(pending).resolves.toMatchObject({
          success: true,
          message: 'Update README'
        })
        // Not an npm shim, so process-host falls back to its own cmd.exe line.
        expect(spawnMock).toHaveBeenCalledWith(
          'C:\\Windows\\System32\\cmd.exe',
          ['/d /v:off /s /c ""C:/tools/agent.cmd""'],
          expect.objectContaining({
            cwd: 'C:\\repo',
            windowsHide: true,
            windowsVerbatimArguments: true
          })
        )
      })
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec
      } else {
        process.env.ComSpec = originalComSpec
      }
    }
  })

  it('rejects unsafe argv prompts for Windows batch-script agent commands', async () => {
    await withPlatform('win32', async () => {
      const result = await generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M\tREADME.md',
          stagedPatch: '+hello & goodbye'
        },
        {
          agentId: 'custom',
          model: '',
          customAgentCommand: 'C:/tools/agent.cmd {prompt}'
        },
        {
          kind: 'local',
          cwd: 'C:\\repo'
        }
      )

      expect(result).toEqual({
        success: false,
        error:
          "C:/tools/agent.cmd runs through a Windows batch script that cannot take the multi-line prompt as an argument. Point Settings at the agent's executable, or use a custom command without {prompt} so Quirky sends the prompt on stdin."
      })
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })
})
