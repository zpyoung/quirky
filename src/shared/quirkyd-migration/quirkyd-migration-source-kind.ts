/**
 * Which kind of source a migration manifest moves state out of.
 *
 * The relay-era SSH target is encoded by the ABSENCE of `source.kind`, so its manifests stay
 * byte-identical (and digest-identical) for destinations that predate the field. Every other kind
 * sets `kind` and must never carry `sshTargetId`: an older destination strips unknown fields, so a
 * non-SSH source without it fails that destination's parse instead of importing as an SSH host.
 */
import type {
  QuirkydMigrationLocalWslManifestSource,
  QuirkydMigrationManifestSource,
  QuirkydMigrationSshManifestSource
} from './quirkyd-migration-manifest'
import { QUIRKYD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY } from '../quirkyd-runtime-capabilities'

export const QUIRKYD_MIGRATION_SSH_RELAY_SOURCE_KIND = 'ssh-relay' as const

/** Non-SSH kinds and the destination capability that proves a destination parses each one. */
export const QUIRKYD_MIGRATION_SOURCE_KIND_CAPABILITIES = {
  'local-wsl': QUIRKYD_MIGRATION_LOCAL_WSL_SOURCE_RUNTIME_CAPABILITY
} as const

export type QuirkydMigrationNonSshSourceKind =
  keyof typeof QUIRKYD_MIGRATION_SOURCE_KIND_CAPABILITIES
export type QuirkydMigrationSourceKind =
  | typeof QUIRKYD_MIGRATION_SSH_RELAY_SOURCE_KIND
  | QuirkydMigrationNonSshSourceKind

export const QUIRKYD_MIGRATION_SOURCE_KIND_UNKNOWN = 'quirkyd_migration_source_kind_unknown'

/** A manifest source as it travels: this build may not know every field a newer peer signed. */
export type QuirkydMigrationWireSource = Readonly<Record<string, unknown>>

/** Reads the wire discriminator; a source without one is the relay-era SSH source. */
export function quirkydMigrationManifestSourceKind(
  source: QuirkydMigrationWireSource
): QuirkydMigrationSourceKind {
  if (source.kind === undefined) {
    return QUIRKYD_MIGRATION_SSH_RELAY_SOURCE_KIND
  }
  // An explicit 'ssh-relay' is refused too: SSH has exactly one encoding, so one digest.
  if (isNonSshSourceKind(source.kind)) {
    return source.kind
  }
  throw new Error(QUIRKYD_MIGRATION_SOURCE_KIND_UNKNOWN)
}

function isNonSshSourceKind(kind: unknown): kind is QuirkydMigrationNonSshSourceKind {
  return typeof kind === 'string' && Object.hasOwn(QUIRKYD_MIGRATION_SOURCE_KIND_CAPABILITIES, kind)
}

/** The capability a destination must advertise before it may see this source; null for SSH. */
export function requiredQuirkydMigrationSourceCapability(
  source: QuirkydMigrationWireSource
): string | null {
  const kind = quirkydMigrationManifestSourceKind(source)
  return kind === QUIRKYD_MIGRATION_SSH_RELAY_SOURCE_KIND
    ? null
    : QUIRKYD_MIGRATION_SOURCE_KIND_CAPABILITIES[kind]
}

export function isQuirkydMigrationLocalWslSource(
  source: QuirkydMigrationManifestSource
): source is QuirkydMigrationLocalWslManifestSource {
  return 'kind' in source && source.kind === 'local-wsl'
}

/** For the SSH conversion's own steps: a WSL manifest reaching them is a bug, never a fallback. */
export function requireQuirkydMigrationSshSource(
  source: QuirkydMigrationManifestSource
): QuirkydMigrationSshManifestSource {
  if (isQuirkydMigrationLocalWslSource(source)) {
    throw new Error('quirkyd_migration_source_not_ssh')
  }
  return source
}
