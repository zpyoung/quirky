/**
 * The cutover journal sidecar: one durable, owner-only file per migration beside the profile.
 *
 * Why not the profile store: shipped builds rewrite quirky-data.json and the profile database with
 * schemas that drop unknown fields, so a journal kept there would vanish across a downgrade while
 * the target's `quirkydFence`, which shipped builds keep, survived it. A missing journal must
 * never look like "no migration"; an unreadable one fails closed.
 */
import {
  MAX_QUIRKYD_MIGRATION_SOURCE_CUTOVERS,
  isRetainedQuirkydMigrationSourceCutover,
  parseQuirkydMigrationSourceCutover,
  type QuirkydMigrationSourceCutover
} from '../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import {
  createMigrationJournalDirectory,
  orderMigrationJournalChain
} from '../persistence/migrating-quirkyd-catalog/migration-journal-directory'

export class QuirkydMigrationCutoverJournalUnreadableError extends Error {
  constructor(detail: string) {
    super(`The migration journal cannot be read, so the SSH host stays fenced: ${detail}`)
    this.name = 'QuirkydMigrationCutoverJournalUnreadableError'
  }
}

type JournalChangeListener = (userDataPath: string) => void
let journalChangeListener: JournalChangeListener | null = null

/** Persistence state that follows the journal (scrollback retention) re-syncs on every change. */
export function setQuirkydMigrationJournalChangeListener(
  listener: JournalChangeListener | null
): void {
  journalChangeListener = listener
}

const journals = createMigrationJournalDirectory({
  directoryName: 'quirkyd-migration-cutovers',
  // A manifest carries catalog rows and dormant session state, never scrollback bytes.
  maxFileBytes: 16 * 1024 * 1024,
  parse: parseQuirkydMigrationSourceCutover,
  unreadable: (detail) => new QuirkydMigrationCutoverJournalUnreadableError(detail),
  onChange: (userDataPath) => journalChangeListener?.(userDataPath)
})

export function quirkydMigrationCutoverJournalDirectory(userDataPath: string): string {
  return journals.directory(userDataPath)
}

/** Every journaled cutover; throws rather than skipping a file it cannot trust. */
export function listQuirkydMigrationSourceCutovers(
  userDataPath: string
): QuirkydMigrationSourceCutover[] {
  return journals.list(userDataPath)
}

/** The target's current cutover: the head of its chain, which no later delta move supersedes. */
export function findQuirkydMigrationSourceCutoverForTarget(
  userDataPath: string,
  sshTargetId: string
): QuirkydMigrationSourceCutover | null {
  const chain = listQuirkydMigrationCutoverChainForTarget(userDataPath, sshTargetId)
  return chain.at(-1) ?? null
}

/** Oldest first; throws unless the target's journals form one chain of delta moves. */
export function listQuirkydMigrationCutoverChainForTarget(
  userDataPath: string,
  sshTargetId: string
): QuirkydMigrationSourceCutover[] {
  const matches = listQuirkydMigrationSourceCutovers(userDataPath).filter(
    (cutover) => cutover.sshTargetId === sshTargetId
  )
  return orderMigrationJournalChain(
    matches,
    (detail) => new QuirkydMigrationCutoverJournalUnreadableError(detail),
    `SSH target ${sshTargetId}`
  )
}

/** Durable before it returns: a fence written after this always has its journal on disk. */
export function writeQuirkydMigrationSourceCutover(
  userDataPath: string,
  cutover: QuirkydMigrationSourceCutover
): void {
  const parsed = parseQuirkydMigrationSourceCutover(cutover)
  const existing = listQuirkydMigrationSourceCutovers(userDataPath)
  // Why in flight only: a retained cutover is finished and may wait two releases for retirement.
  const inFlight = existing.filter(
    (entry) => entry.phase !== 'source-retired' && !isRetainedQuirkydMigrationSourceCutover(entry)
  )
  if (
    !existing.some((entry) => entry.migrationId === parsed.migrationId) &&
    inFlight.length >= MAX_QUIRKYD_MIGRATION_SOURCE_CUTOVERS
  ) {
    throw new Error('quirkyd_migration_cutover_capacity_exceeded')
  }
  journals.write(userDataPath, parsed)
}

export function removeQuirkydMigrationSourceCutover(
  userDataPath: string,
  migrationId: string
): void {
  journals.remove(userDataPath, migrationId)
}

/** Every journal a host's stopped or never-registered server leaves behind; they grant nothing. */
export function removeQuirkydMigrationJournalsForDestination(
  userDataPath: string,
  sshTargetId: string,
  environmentId: string
): void {
  for (const cutover of listQuirkydMigrationSourceCutovers(userDataPath)) {
    if (cutover.sshTargetId === sshTargetId && cutover.destinationEnvironmentId === environmentId) {
      removeQuirkydMigrationSourceCutover(userDataPath, cutover.migrationId)
    }
  }
}
