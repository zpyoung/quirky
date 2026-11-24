import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../constants'
import {
  MAX_QUIRKYD_MIGRATION_DORMANT_NAMESPACES,
  MAX_QUIRKYD_MIGRATION_DORMANT_ROWS
} from '../quirkyd-migration-dormant-state-validation'
import {
  MAX_QUIRKYD_MIGRATION_IMPORT_RECEIPTS,
  MAX_QUIRKYD_MIGRATION_MANIFEST_BYTES,
  normalizeQuirkydMigrationImportReceipts,
  QUIRKYD_MIGRATION_MANIFEST_VERSION,
  parseQuirkydMigrationManifest
} from './quirkyd-migration-manifest-validation'
import {
  serializeQuirkydMigrationValue,
  type QuirkydMigrationImportReceipt
} from './quirkyd-migration-manifest'

function receipt(index: number, overrides: Partial<QuirkydMigrationImportReceipt> = {}) {
  return {
    version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
    migrationId: `migration-${index}`,
    manifestSha256: index.toString(16).padStart(64, '0'),
    source: {
      sshTargetId: 'ssh-prod',
      sshTargetGeneration: 1,
      targetLabel: 'Production'
    },
    importedAt: new Date(index * 1_000).toISOString(),
    repositoryIds: [],
    projectGroupIds: [],
    folderWorkspaceIds: [],
    ...overrides
  }
}

describe('quirkyd migration manifest', () => {
  it('serializes object keys deterministically without locale ordering', () => {
    expect(
      serializeQuirkydMigrationValue({ z: 1, Z: 2, nested: { ä: 3, a: 4 }, omitted: undefined })
    ).toBe('{"Z":2,"nested":{"a":4,"ä":3},"z":1}')
  })

  it('keeps the newest bounded set of valid unique receipts', () => {
    const candidates: unknown[] = Array.from(
      { length: MAX_QUIRKYD_MIGRATION_IMPORT_RECEIPTS + 2 },
      (_, index) => receipt(index)
    )
    candidates.push(receipt(10, { source: { ...receipt(10).source, targetLabel: 'Newest' } }))
    candidates.push({ invalid: true })

    const normalized = normalizeQuirkydMigrationImportReceipts(candidates)

    expect(normalized).toHaveLength(MAX_QUIRKYD_MIGRATION_IMPORT_RECEIPTS)
    expect(normalized.some((entry) => entry.migrationId === 'migration-0')).toBe(false)
    expect(normalized.find((entry) => entry.migrationId === 'migration-10')?.source).toMatchObject({
      targetLabel: 'Newest'
    })
  })

  it('normalizes receipts without Node 20-only array methods', () => {
    const prototype: object = Array.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'toReversed')
    try {
      Object.defineProperty(prototype, 'toReversed', {
        configurable: true,
        value: undefined,
        writable: true
      })
      expect(normalizeQuirkydMigrationImportReceipts([receipt(1), receipt(2)])).toHaveLength(2)
    } finally {
      if (descriptor) {
        Object.defineProperty(prototype, 'toReversed', descriptor)
      } else {
        Reflect.deleteProperty(prototype, 'toReversed')
      }
    }
  })

  it('drops a receipt with duplicate catalog identities', () => {
    expect(
      normalizeQuirkydMigrationImportReceipts([receipt(1, { repositoryIds: ['repo-1', 'repo-1'] })])
    ).toEqual([])
  })

  it('accepts bounded dormant state and rejects rows outside the catalog scope', () => {
    const candidate = {
      version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
      migrationId: 'migration-dormant',
      createdAt: '2026-08-30T12:00:00.000Z',
      source: receipt(1).source,
      payload: {
        repositories: [
          {
            id: 'repo-1',
            path: '/srv/repo-1',
            displayName: 'Repo',
            badgeColor: '#737373',
            addedAt: 1
          }
        ],
        projectGroups: [],
        folderWorkspaces: [],
        dormantState: {
          version: 1,
          worktreeMeta: [
            {
              sourceKey: 'repo-1::/srv/worktree',
              worktreeId: 'repo-1::/srv/worktree',
              meta: {
                displayName: '',
                comment: '',
                linkedIssue: null,
                linkedPR: null,
                linkedLinearIssue: null,
                isArchived: false,
                isUnread: false,
                isPinned: false,
                sortOrder: 1,
                lastActivityAt: 1,
                hostId: 'local'
              }
            }
          ],
          worktreeLineage: [],
          workspaceLineage: [],
          sparsePresets: [],
          retiredWorktreeNames: [],
          retiredWorktreeNamespaces: [],
          workspaceSession: {
            ...getDefaultWorkspaceSession(),
            tabsByWorktree: {
              'repo-1::/srv/worktree': [
                {
                  id: 'tab-dormant',
                  ptyId: null,
                  worktreeId: 'repo-1::/srv/worktree',
                  title: 'Dormant terminal',
                  customTitle: null,
                  color: null,
                  sortOrder: 0,
                  createdAt: 1
                }
              ]
            }
          }
        }
      },
      manifestSha256: 'a'.repeat(64)
    }

    expect(
      parseQuirkydMigrationManifest(candidate).payload.dormantState?.worktreeMeta
    ).toHaveLength(1)
    expect(
      parseQuirkydMigrationManifest(candidate).payload.dormantState?.workspaceSession
        ?.tabsByWorktree
    ).toHaveProperty('repo-1::/srv/worktree')
    expect(() =>
      parseQuirkydMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            worktreeMeta: [
              {
                ...candidate.payload.dormantState.worktreeMeta[0],
                worktreeId: 'repo-other::/srv/worktree'
              }
            ]
          }
        }
      })
    ).toThrow('quirkyd_migration_dormant_worktree_meta_scope_invalid')

    expect(() =>
      parseQuirkydMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            workspaceSession: {
              ...candidate.payload.dormantState.workspaceSession,
              tabsByWorktree: {
                'repo-1::/srv/worktree': [
                  {
                    ...candidate.payload.dormantState.workspaceSession.tabsByWorktree[
                      'repo-1::/srv/worktree'
                    ][0],
                    ptyId: 'pty-live'
                  }
                ]
              }
            }
          }
        }
      })
    ).toThrow('quirkyd_migration_dormant_workspace_session_pty_invalid')

    expect(() =>
      parseQuirkydMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            worktreeMeta: Array.from(
              { length: MAX_QUIRKYD_MIGRATION_DORMANT_ROWS + 1 },
              () => candidate.payload.dormantState.worktreeMeta[0]
            )
          }
        }
      })
    ).toThrow('quirkyd_migration_dormant_worktree_meta_too_many')

    expect(() =>
      parseQuirkydMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            retiredWorktreeNamespaces: Array.from(
              { length: MAX_QUIRKYD_MIGRATION_DORMANT_NAMESPACES + 1 },
              () => ({
                sourceNamespaceKeys: ['ssh:source:/srv/quirky-worktrees'],
                namespaceKey: 'local:/srv/quirky-worktrees',
                registry: { exhaustedTiers: 0, names: ['nautilus'] }
              })
            )
          }
        }
      })
    ).toThrow('quirkyd_migration_dormant_retirement_namespaces_too_many')

    expect(() =>
      parseQuirkydMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            worktreeMeta: [
              {
                ...candidate.payload.dormantState.worktreeMeta[0],
                meta: {
                  ...candidate.payload.dormantState.worktreeMeta[0].meta,
                  comment: 'x'.repeat(MAX_QUIRKYD_MIGRATION_MANIFEST_BYTES)
                }
              }
            ]
          }
        }
      })
    ).toThrow('quirkyd_migration_manifest_too_large')
  })

  it('accepts only destination-owned disabled automations with final run history', () => {
    const automation = {
      id: 'automation-1',
      name: 'Nightly checks',
      prompt: 'Run tests',
      precheck: null,
      agentId: 'codex',
      runContext: {
        kind: 'workspace-run',
        projectId: 'repo:repo-1',
        hostId: 'local',
        projectHostSetupId: 'repo-1',
        repoId: 'repo-1',
        path: '/srv/repo-1'
      },
      sourceContext: null,
      projectId: 'repo-1',
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'remote_host_service',
      workspaceMode: 'new_per_run',
      workspaceId: null,
      baseBranch: 'main',
      reuseSession: false,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 1,
      enabled: false,
      nextRunAt: 2,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 60,
      createdAt: 1,
      updatedAt: 2
    }
    const run = {
      id: 'run-1',
      automationId: automation.id,
      runContext: automation.runContext,
      sourceContext: null,
      title: 'Nightly checks run 1',
      scheduledFor: 1,
      status: 'completed',
      trigger: 'scheduled',
      workspaceId: null,
      sessionKind: 'terminal',
      chatSessionId: null,
      terminalSessionId: 'tab-history',
      terminalPaneKey: null,
      terminalPtyId: 'pty-history',
      outputSnapshot: {
        format: 'plain_text',
        content: 'all green',
        capturedAt: 2,
        truncated: false
      },
      precheckResult: null,
      usage: null,
      error: null,
      startedAt: 1,
      dispatchedAt: 1,
      createdAt: 1
    }
    const candidate = {
      version: QUIRKYD_MIGRATION_MANIFEST_VERSION,
      migrationId: 'migration-automation',
      createdAt: '2026-08-30T12:00:00.000Z',
      source: receipt(1).source,
      payload: {
        repositories: [
          {
            id: 'repo-1',
            path: '/srv/repo-1',
            displayName: 'Repo',
            badgeColor: '#737373',
            addedAt: 1
          }
        ],
        projectGroups: [],
        folderWorkspaces: [],
        dormantState: {
          version: 1,
          worktreeMeta: [],
          worktreeLineage: [],
          workspaceLineage: [],
          sparsePresets: [],
          retiredWorktreeNames: [],
          retiredWorktreeNamespaces: [],
          automations: [automation],
          automationRuns: [run]
        }
      },
      manifestSha256: 'a'.repeat(64)
    }

    expect(
      parseQuirkydMigrationManifest(candidate).payload.dormantState?.automationRuns?.[0]
        ?.outputSnapshot?.content
    ).toBe('all green')
    expect(() =>
      parseQuirkydMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            automations: [{ ...automation, enabled: true }]
          }
        }
      })
    ).toThrow('quirkyd_migration_dormant_automation_owner_invalid')
    expect(() =>
      parseQuirkydMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            automationRuns: [{ ...run, status: 'dispatching' }]
          }
        }
      })
    ).toThrow('quirkyd_migration_dormant_automation_run_status_invalid')
    for (const invalid of [
      { extraAgentArgs: '--dangerously-bypass-approvals-and-sandbox' },
      { extraAgentArgs: '--model gpt-5', reuseSession: true }
    ]) {
      expect(() =>
        parseQuirkydMigrationManifest({
          ...candidate,
          payload: {
            ...candidate.payload,
            dormantState: {
              ...candidate.payload.dormantState,
              automations: [{ ...automation, ...invalid }]
            }
          }
        })
      ).toThrow('quirkyd_migration_dormant_automation_extra_agent_args_invalid')
    }
  })
})
