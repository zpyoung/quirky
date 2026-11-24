/** Catalog merges retain known rows and reject conflicting imported configuration. */
import { serializeQuirkydMigrationValue } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { Repo } from '../../../shared/repo-types'

export function selectNewRows<T extends { id: string }>(
  incoming: T[],
  existing: T[],
  conflictError: (id: string) => string,
  sameRow: (left: T, right: T) => boolean = (left, right) =>
    serializeQuirkydMigrationValue(left) === serializeQuirkydMigrationValue(right)
): T[] {
  const existingById = new Map(existing.map((row) => [row.id, row]))
  return incoming.filter((row) => {
    const current = existingById.get(row.id)
    if (!current) {
      return true
    }
    if (!sameRow(current, row)) {
      throw new Error(conflictError(row.id))
    }
    return false
  })
}

function isAutomaticGitHubIcon(repo: Repo): boolean {
  return repo.repoIcon?.type === 'image' && repo.repoIcon.source === 'github'
}

function withoutHostProbeCache(repo: Repo, dropIcon: boolean): Partial<Repo> {
  const { gitRemoteIdentity: _identity, repoIcon, ...configuration } = repo
  return dropIcon ? configuration : { ...configuration, repoIcon }
}

export function sameQuirkydRepositoryConfiguration(current: Repo, incoming: Repo): boolean {
  // Git identity is the execution host's cached probe, and identity enrichment rewrites an
  // automatic GitHub avatar alongside it; reimport must keep that host's result for both.
  const dropIcon = isAutomaticGitHubIcon(current) && isAutomaticGitHubIcon(incoming)
  return (
    serializeQuirkydMigrationValue(withoutHostProbeCache(current, dropIcon)) ===
    serializeQuirkydMigrationValue(withoutHostProbeCache(incoming, dropIcon))
  )
}

export function assertSameValue(left: unknown, right: unknown, label: string): void {
  if (serializeQuirkydMigrationValue(left) !== serializeQuirkydMigrationValue(right)) {
    throw new Error(`quirkyd_migration_dormant_id_conflict:${label}`)
  }
}
