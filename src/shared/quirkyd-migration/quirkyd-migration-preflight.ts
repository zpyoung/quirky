import type { FolderWorkspace } from '../folder-workspace-types'
import type { Repo } from '../repo-types'
import type { SavedPortForward, SshRemotePtyLease } from '../ssh-types'

export type QuirkydMigrationBlockerCategory =
  | 'registration'
  | 'exclusive-ownership'
  | 'drainable-static-state'
  | 'live-or-unverifiable'
  | 'client-owned-state'

export const QUIRKYD_MIGRATION_DEPENDENCY_KINDS = [
  'saved-port-forward',
  'terminal-lease',
  'terminal-recovery',
  'workspace-session',
  'worktree-metadata',
  'worktree-lineage',
  'workspace-lineage',
  'sparse-preset',
  'retired-worktree-name',
  'automation',
  'automation-run',
  'mobile-tab-selection',
  'ui-routing'
] as const

export type QuirkydMigrationDependencyKind = (typeof QUIRKYD_MIGRATION_DEPENDENCY_KINDS)[number]

export type QuirkydMigrationDependency = {
  kind: QuirkydMigrationDependencyKind
  count: number
  /** A bounded sample of what holds the reference, so the user can find and clear it. */
  names?: string[]
}

export type QuirkydMigrationRepository = Pick<Repo, 'id' | 'path' | 'displayName' | 'kind'>
export type QuirkydMigrationFolderWorkspace = Pick<FolderWorkspace, 'id' | 'name' | 'folderPath'>
export type QuirkydMigrationTerminalLease = Pick<
  SshRemotePtyLease,
  'ptyId' | 'worktreeId' | 'tabId' | 'leafId' | 'state' | 'updatedAt'
>

export type QuirkydMigrationBlocker =
  | {
      code: 'quirkyd_migration_target_not_found'
      category: 'registration'
    }
  | {
      code: 'quirkyd_migration_target_owned'
      category: 'exclusive-ownership'
      holder:
        | { kind: 'runtime'; runtimeId: string }
        | { kind: 'managed-server'; environmentId: string }
    }
  | {
      /** Owned by the asking environment, but no durable record of why. */
      code: 'quirkyd_migration_owner_unrecorded'
      category: 'exclusive-ownership'
    }
  | {
      code: 'quirkyd_migration_direct_ssh_repositories'
      category: 'drainable-static-state'
      repositories: QuirkydMigrationRepository[]
    }
  | {
      code: 'quirkyd_migration_direct_ssh_folder_workspaces'
      category: 'drainable-static-state'
      folderWorkspaces: QuirkydMigrationFolderWorkspace[]
    }
  | {
      code: 'quirkyd_migration_direct_ssh_terminal_leases'
      category: 'live-or-unverifiable'
      terminalLeases: QuirkydMigrationTerminalLease[]
    }
  | {
      code: 'quirkyd_migration_saved_port_forwards'
      category: 'client-owned-state'
      portForwards: SavedPortForward[]
    }
  | {
      code: 'quirkyd_migration_dependent_state'
      category: 'client-owned-state'
      dependencies: QuirkydMigrationDependency[]
    }
  | {
      code: 'quirkyd_migration_dependency_unverifiable'
      category: 'live-or-unverifiable'
      sources: QuirkydMigrationDependencyKind[]
    }

export type QuirkydMigrationPreflight = {
  targetId: string
  targetLabel: string | null
  claimable: boolean
  blockers: QuirkydMigrationBlocker[]
}
