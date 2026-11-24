import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveQuirkyAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveQuirkyAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/quirky-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('../runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('../index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveQuirkyAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('../runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('../index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from '../index'
import { useWorktreeAwarenessEnvironment } from '../index-test-harness'
import { localRepoDestinationFixtures, okFixture, queueFixtures } from '../test-fixtures'
import { AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

describe('quirky cli automation launch overrides', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveQuirkyAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('preflights and creates automation launch overrides', async () => {
    queueFixtures(
      callMock,
      okFixture('req_status', {
        capabilities: [AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY]
      }),
      ...localRepoDestinationFixtures('repo-1'),
      okFixture('req_automation_create', {
        automation: { id: 'auto-1', name: 'Configured review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'create',
        '--name',
        'Configured review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'claude',
        '--repo',
        'id:repo-1',
        '--model',
        'sonnet',
        '--effort',
        'high',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenCalledWith(
      'automation.create',
      expect.objectContaining({
        agentId: 'claude',
        launchOverrides: {
          model: 'sonnet',
          optionValues: { effort: 'high' }
        }
      })
    )
  })

  it('fetches and sparsely merges automation launch overrides on edit', async () => {
    queueFixtures(
      callMock,
      okFixture('req_status', {
        capabilities: [AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY]
      }),
      okFixture('req_show', {
        automation: {
          id: 'auto-1',
          agentId: 'claude',
          launchOverrides: { model: 'sonnet', optionValues: { effort: 'high' } }
        }
      }),
      okFixture('req_update', {
        automation: { id: 'auto-1', name: 'Configured review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['automations', 'edit', 'auto-1', '--model=inherit', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(2, 'automation.show', { id: 'auto-1' })
    // Why: one show serves both the override merge and the owner fence.
    expect(callMock.mock.calls.filter(([method]) => method === 'automation.show')).toHaveLength(1)
    expect(callMock).toHaveBeenCalledWith(
      'automation.update',
      expect.objectContaining({
        id: 'auto-1',
        updates: expect.objectContaining({
          launchOverrides: { optionValues: { effort: 'high' } }
        })
      })
    )
  })

  it('clears structured launch overrides when edit changes provider', async () => {
    queueFixtures(
      callMock,
      okFixture('req_show', {
        automation: {
          id: 'auto-1',
          agentId: 'claude',
          launchOverrides: {
            model: 'sonnet',
            optionValues: { effort: 'high' }
          }
        }
      }),
      okFixture('req_status', {
        capabilities: [AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY]
      }),
      okFixture('req_update', {
        automation: { id: 'auto-1', name: 'Configured review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['automations', 'edit', 'auto-1', '--provider', 'gemini', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(1, 'automation.show', { id: 'auto-1' })
    expect(callMock).toHaveBeenNthCalledWith(2, 'status.get')
    expect(callMock).toHaveBeenCalledWith(
      'automation.update',
      expect.objectContaining({
        id: 'auto-1',
        updates: expect.objectContaining({
          agentId: 'gemini',
          launchOverrides: null
        })
      })
    )
  })

  it('does not merge old structured overrides when provider and model change together', async () => {
    queueFixtures(
      callMock,
      okFixture('req_status', {
        capabilities: [AGENT_LAUNCH_OVERRIDES_RUNTIME_CAPABILITY]
      }),
      okFixture('req_show', {
        automation: {
          id: 'auto-1',
          agentId: 'claude',
          launchOverrides: { model: 'sonnet', optionValues: { effort: 'high' } }
        }
      }),
      okFixture('req_update', {
        automation: { id: 'auto-1', name: 'Configured review' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'automations',
        'edit',
        'auto-1',
        '--provider',
        'codex',
        '--model',
        'gpt-5.3-codex',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'automation.update',
      expect.objectContaining({
        updates: expect.objectContaining({
          agentId: 'codex',
          launchOverrides: { model: 'gpt-5.3-codex' }
        })
      })
    )
  })

  it('blocks automation launch overrides when the runtime capability is absent', async () => {
    queueFixtures(callMock, okFixture('req_status', { capabilities: [] }))
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      [
        'automations',
        'create',
        '--name',
        'Configured review',
        '--trigger',
        'daily',
        '--prompt',
        'Review open changes',
        '--provider',
        'claude',
        '--repo',
        'id:repo-1',
        '--model',
        'sonnet',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'capability_unsupported' }
    })
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })
})
