import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverCommitMessageModelsLocal } from './commit-message-text-generation'
import { PROVIDER_SPAWN_FAILURE_MARKER } from '../provider-process/provider-spawn-failure-report'
import {
  createMockDiscoveryChild,
  spawnedAgentArgv
} from './commit-message-text-generation-test-harness'

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

function spawnError(errno: string): Error {
  return Object.assign(new Error(`spawn claude ${errno}`), { code: errno })
}

// These suites drive fake children down the Windows direct-child path, taskkill included. The POSIX
// supervised stop with the Codex home lock (generation: timeout, cancel, output limit; discovery:
// timeout, output limit) is in source-control-local-process.test.ts.
const hostPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: hostPlatform
  })
  vi.unstubAllEnvs()
})

beforeEach(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32'
  })
  // Windows resolves a bare agent name on PATH; the host's own installs must not answer it.
  vi.stubEnv('PATH', '')
  terminateWindowsProcessTreeMock.mockClear()
  terminateWindowsProcessTreeMock.mockResolvedValue(undefined)
  spawnMock.mockClear()
})

describe('discoverCommitMessageModelsLocal on the Windows direct-child path', () => {
  it('returns static catalog models without spawning for static agents', async () => {
    const result = await discoverCommitMessageModelsLocal('amp', undefined)

    expect(result).toMatchObject({
      success: true,
      catalogOrigin: 'spec',
      defaultModelId: 'smart'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('discovers dynamic models through the agent CLI', async () => {
    // The host's own spawn shape: supervised on POSIX, direct on Windows.
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: hostPlatform
    })
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: {
        on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback))
      },
      stderr: {
        on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback))
      },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('cursor', undefined)

    listeners.get('stdout:data')?.(Buffer.from('auto - Auto\ngpt-5.2 - GPT-5.2\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'auto',
      models: [
        { id: 'auto', label: 'Auto' },
        { id: 'gpt-5.2', label: 'GPT-5.2' }
      ]
    })
    expect(spawnedAgentArgv(spawnMock.mock.calls[0]!)).toEqual(['cursor-agent', '--list-models'])
    expect(spawnMock.mock.calls[0]![2]).toMatchObject({ windowsHide: true })
  })

  it('writes the Claude list_models request to stdin and parses the control response', async () => {
    // The host's own spawn shape: supervised on POSIX, direct on Windows.
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: hostPlatform
    })
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: {
        on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback))
      },
      stderr: {
        on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback))
      },
      stdin: { on: vi.fn(), end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('claude', undefined)

    listeners.get('stdout:data')?.(
      Buffer.from(
        `${JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'quirky-model-discovery',
            response: {
              models: [
                { value: 'default', displayName: 'Default (recommended)' },
                {
                  value: 'opus[1m]',
                  displayName: 'Opus (1M context)',
                  supportsEffort: true,
                  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
                },
                { value: 'sonnet', displayName: 'Sonnet' },
                { value: 'haiku', displayName: 'Haiku' }
              ]
            }
          }
        })}\n`
      )
    )
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      catalogOrigin: 'probe',
      defaultModelId: 'sonnet',
      models: [
        { id: 'opus[1m]', label: 'Opus (1M context)' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'haiku', label: 'Haiku' }
      ]
    })
    expect(spawnedAgentArgv(spawnMock.mock.calls[0]!)).toEqual([
      'claude',
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}'
    ])
    expect(spawnMock.mock.calls[0]![2]).toMatchObject({
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', ...(process.platform === 'win32' ? [] : ['ipc'])]
    })
    expect(child.stdin.end).toHaveBeenCalledWith(expect.stringContaining('"list_models"'))
  })

  it('falls back to the Claude seed models when the CLI lacks list_models', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: {
        on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback))
      },
      stderr: {
        on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback))
      },
      stdin: { on: vi.fn(), end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('claude', undefined)

    // Captured from claude 2.1.100: the unsupported subtype still exits 0.
    listeners.get('stdout:data')?.(
      Buffer.from(
        '{"type":"control_response","response":{"subtype":"error","request_id":"quirky-model-discovery","error":"Unsupported control request subtype: list_models"}}\n'
      )
    )
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      catalogOrigin: 'spec',
      defaultModelId: 'sonnet',
      models: [{ id: 'haiku' }, { id: 'sonnet' }, { id: 'opus' }]
    })
  })

  it('discovers dynamic models through the configured agent command override', async () => {
    // The host's own spawn shape: supervised on POSIX, direct on Windows.
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: hostPlatform
    })
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: {
        on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback))
      },
      stderr: {
        on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback))
      },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('cursor', undefined, 'npx cursor-agent')

    listeners.get('stdout:data')?.(Buffer.from('auto - Auto\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'auto'
    })
    if (process.platform === 'win32') {
      // npx.cmd is an npm shim, so process-host runs it as node + npx-cli.js, never cmd.exe.
      expect(spawnMock).toHaveBeenCalledWith(
        expect.stringMatching(/node\.exe$/i),
        [expect.stringMatching(/npx-cli\.js$/i), 'cursor-agent', '--list-models'],
        expect.objectContaining({ windowsHide: true })
      )
    } else {
      expect(spawnedAgentArgv(spawnMock.mock.calls[0]!)).toEqual([
        'npx',
        'cursor-agent',
        '--list-models'
      ])
    }
  })

  it('falls back to static models when dynamic discovery returns no parseable models', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: {
        on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback))
      },
      stderr: {
        on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback))
      },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('pi', undefined)

    listeners.get('stdout:data')?.(Buffer.from('provider model\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'default',
      models: [{ id: 'default' }]
    })
  })

  it('falls back to the first discovered non-Pi model when its static default is unavailable', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: {
        on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback))
      },
      stderr: {
        on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback))
      },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('cursor', undefined)

    listeners.get('stdout:data')?.(Buffer.from('gpt-5.2 - GPT-5.2\n'))
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'gpt-5.2',
      models: [{ id: 'gpt-5.2' }]
    })
  })

  it('parses Pi model discovery from stderr when the CLI exits successfully', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: {
        on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback))
      },
      stderr: {
        on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback))
      },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('pi', undefined)

    listeners.get('stderr:data')?.(
      Buffer.from(
        [
          'provider        model                   context  max-out  thinking  images',
          'github-copilot  gpt-5.4-mini            400K     128K     yes       yes',
          'openai-codex    gpt-5.5                 272K     128K     yes       yes'
        ].join('\n')
      )
    )
    listeners.get('close')?.(0)

    await expect(pending).resolves.toMatchObject({
      success: true,
      defaultModelId: 'default',
      models: [{ id: 'github-copilot/gpt-5.4-mini' }, { id: 'openai-codex/gpt-5.5' }]
    })
  })

  const notFound = 'claude not found on PATH. Install Claude to discover models.'
  const failedToStart =
    'Claude model discovery failed to start. Check the agent CLI configuration and try again.'
  const couldNotStart =
    'Claude model discovery could not be started. Check the agent CLI configuration and try again.'
  it.each([
    ['ENOENT', false, notFound],
    ['EACCES', false, failedToStart],
    ['ENOTDIR', true, couldNotStart]
  ])(
    'reports a supervisor %s spawn failure as a direct spawn does',
    async (errno, thrown, error) => {
      const child = createMockDiscoveryChild()
      spawnMock.mockReturnValue(child as never)

      const pending = discoverCommitMessageModelsLocal('claude', undefined)
      child.stderr.emit(
        'data',
        Buffer.from(
          `Warning: an Electron startup notice\n${PROVIDER_SPAWN_FAILURE_MARKER}${JSON.stringify({
            thrown,
            code: errno,
            message: `spawn claude ${errno}`
          })}\n`
        )
      )
      child.emit('close', 127)

      await expect(pending).resolves.toEqual({
        success: false,
        error,
        // A missing binary is typed so the catalog can say the CLI is not installed.
        ...(errno === 'ENOENT' ? { unavailable: { reason: 'cliMissing' } } : {})
      })
    }
  )

  it.each([
    ['ENOENT', notFound],
    ['EACCES', failedToStart]
  ])('reports an emitted %s spawn error as before', async (errno, error) => {
    const child = createMockDiscoveryChild()
    spawnMock.mockReturnValue(child as never)

    const pending = discoverCommitMessageModelsLocal('claude', undefined)
    child.emit('error', spawnError(errno))

    await expect(pending).resolves.toEqual({
      success: false,
      error,
      ...(errno === 'ENOENT' ? { unavailable: { reason: 'cliMissing' } } : {})
    })
  })
})
