import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../../shared/ai-vault-types'
import { prepareAiVaultSessionContinuation as prepareUpstreamAiVaultSessionContinuation } from '../../right-sidebar/ai-vault-session-continuation'
import { prepareAiVaultSessionContinuation } from './prepare-handoff-from-vault'

vi.mock('../../right-sidebar/ai-vault-session-continuation', () => ({
  prepareAiVaultSessionContinuation: vi.fn(() => ({
    source: { capturedText: 'preview', sourceAgent: 'codex' },
    worktreeId: 'repo::/target',
    workspacePath: '/target',
    initialCwd: '/source',
    launchSource: 'sidebar'
  }))
}))

function makeSession(): AiVaultSession {
  return {
    executionHostId: 'runtime:env-1',
    agent: 'codex',
    sessionId: 'provider-session-1'
  } as unknown as AiVaultSession
}

describe('prepareAiVaultSessionContinuation', () => {
  it('wraps the upstream request with Vault identity and a non-null anchor', () => {
    const session = makeSession()
    const result = prepareAiVaultSessionContinuation({
      session,
      targetWorktreeId: 'repo::/target',
      targetWorkspacePath: '/target'
    })

    expect(prepareUpstreamAiVaultSessionContinuation).toHaveBeenCalledWith({
      session,
      targetWorktreeId: 'repo::/target',
      targetWorkspacePath: '/target'
    })
    expect(result.forkSource).toEqual({
      sourcePaneKey: null,
      sourceWorktreeId: null,
      anchorWorktreeId: 'repo::/target',
      sourceExecutionHostId: 'runtime:env-1',
      providerSessionId: 'provider-session-1',
      vaultSessionId: 'provider-session-1',
      vaultAgent: 'codex',
      capturePaneScrollback: null
    })
    expect(result.source.capturedText).toBe('preview')
  })

  it('preserves an archived SSH source contract when the active destination is a folder', () => {
    const session = {
      ...makeSession(),
      executionHostId: 'ssh:source-host',
      agent: 'claude',
      sessionId: 'archived-session-1'
    } as AiVaultSession
    vi.mocked(prepareUpstreamAiVaultSessionContinuation).mockReturnValueOnce({
      source: {
        capturedText: '',
        sourceAgent: 'claude',
        transcriptPath: '/home/ada/.claude/session.jsonl'
      },
      worktreeId: 'folder:folder-1',
      workspacePath: '/srv/quirky',
      initialCwd: '/source',
      launchSource: 'sidebar'
    })

    const result = prepareAiVaultSessionContinuation({
      session,
      targetWorktreeId: 'folder:folder-1',
      targetWorkspacePath: '/srv/quirky'
    })

    expect(result).toEqual({
      source: {
        capturedText: '',
        sourceAgent: 'claude',
        transcriptPath: '/home/ada/.claude/session.jsonl'
      },
      worktreeId: 'folder:folder-1',
      workspacePath: '/srv/quirky',
      initialCwd: '/source',
      launchSource: 'sidebar',
      forkSource: {
        sourcePaneKey: null,
        sourceWorktreeId: null,
        anchorWorktreeId: 'folder:folder-1',
        sourceExecutionHostId: 'ssh:source-host',
        providerSessionId: 'archived-session-1',
        vaultSessionId: 'archived-session-1',
        vaultAgent: 'claude',
        capturePaneScrollback: null
      }
    })
  })
})
