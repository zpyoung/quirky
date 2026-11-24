import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../../shared/ai-vault-types'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import type { AiVaultSessionResumeTargetState } from '../../right-sidebar/ai-vault-session-resume'
import {
  resolveAiVaultSessionHandoffLaunchTarget,
  resolveAiVaultSessionHandoffWorktreeId
} from './ai-vault-handoff-action'

function makeSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    filePath: '/Users/ada/.claude/session.jsonl',
    previewMessages: [],
    ...overrides
  } as AiVaultSession
}

function makeTargetState(): AiVaultSessionResumeTargetState {
  return {
    folderWorkspaces: [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        name: 'Remote folder',
        folderPath: '/srv/quirky'
      }
    ],
    projectGroups: [{ id: 'group-1', connectionId: 'ssh-1' }],
    repos: [],
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'repo-1::/repo/quirky',
          repoId: 'repo-1',
          displayName: 'quirky',
          path: '/repo/quirky'
        }
      ]
    }
  } as unknown as AiVaultSessionResumeTargetState
}

describe('Vault handoff target selection', () => {
  it('selects the active new-tab identity even when same-host resume disabled it', () => {
    expect(
      resolveAiVaultSessionHandoffWorktreeId(makeSession(), {
        worktree: { worktreeId: 'repo-1::/archived/quirky', disabled: true },
        newTab: { worktreeId: 'repo-1::/repo/quirky', disabled: true }
      })
    ).toBe('repo-1::/repo/quirky')
  })

  it('keeps the resumable session worktree as the default over another active workspace', () => {
    expect(
      resolveAiVaultSessionHandoffWorktreeId(makeSession(), {
        worktree: { worktreeId: 'repo-1::/archived/quirky', disabled: false },
        newTab: { worktreeId: 'repo-1::/repo/quirky', disabled: false }
      })
    ).toBe('repo-1::/archived/quirky')
  })

  it('falls back to the session worktree when it is also the active workspace', () => {
    expect(
      resolveAiVaultSessionHandoffWorktreeId(makeSession(), {
        worktree: { worktreeId: 'repo-1::/repo/quirky', disabled: true },
        newTab: { worktreeId: null, disabled: true }
      })
    ).toBe('repo-1::/repo/quirky')
  })

  it('preserves the existing session-content gate', () => {
    expect(
      resolveAiVaultSessionHandoffWorktreeId(makeSession({ filePath: '  ', previewMessages: [] }), {
        worktree: { worktreeId: null, disabled: true },
        newTab: { worktreeId: 'repo-1::/repo/quirky', disabled: true }
      })
    ).toBeNull()
  })

  it('allows a host-stored archived session to hand off into an SSH folder workspace', () => {
    const folderTarget = folderWorkspaceKey('folder-1')

    expect(
      resolveAiVaultSessionHandoffLaunchTarget({
        sessionFilePath: '/Users/ada/.claude/session.jsonl',
        sessionExecutionHostId: 'local',
        activeWorktreeId: folderTarget,
        targetWorktreeId: folderTarget,
        targetState: makeTargetState()
      })
    ).toEqual({ status: 'ready', worktreeId: folderTarget })
  })

  it('allows a runtime-host mismatch so the dialog can downgrade unreachable context', () => {
    expect(
      resolveAiVaultSessionHandoffLaunchTarget({
        sessionFilePath: '/home/ada/.codex/session.jsonl',
        sessionExecutionHostId: 'runtime:source-env',
        activeWorktreeId: 'repo-1::/repo/quirky',
        targetState: makeTargetState()
      })
    ).toEqual({ status: 'ready', worktreeId: 'repo-1::/repo/quirky' })
  })

  it('rejects a destination that is no longer open', () => {
    expect(
      resolveAiVaultSessionHandoffLaunchTarget({
        sessionFilePath: null,
        sessionExecutionHostId: 'local',
        activeWorktreeId: 'missing-worktree',
        targetState: makeTargetState()
      })
    ).toEqual({ status: 'missing' })
  })
})
