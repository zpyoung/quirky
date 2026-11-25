import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import type {
  AgentJournalTurnChangesItem,
  TurnChangesFile
} from '../../../shared/agent-session-journal-v1-items'

/** The row a turn's changes live in: one per turn, so a second write revises it. */
export function turnChangesIdentity(turnId: string): AgentJournalItemIdentity {
  return { provider: 'quirky', clientMessageId: `turn-changes:${turnId}` }
}

/** The row a shell test run's result lives in, keyed by the call's own journal row so an id a
 *  provider reuses across turns still gets a row each. */
export function testResultIdentity(toolItemId: string): AgentJournalItemIdentity {
  return { provider: 'quirky', clientMessageId: `test-result:${toolItemId}` }
}

/** Builds a `turn-changes` body from two snapshots. Null when nothing changed, because the item
 *  is written only when a file did. */
export function gitTreeTurnChanges(
  turnId: string,
  fromTree: string,
  toTree: string,
  files: readonly TurnChangesFile[]
): AgentJournalTurnChangesItem | null {
  return files.length === 0
    ? null
    : { kind: 'turn-changes', turnId, source: 'git-tree', fromTree, toTree, files: [...files] }
}

/** Builds a `turn-changes` body from the files the turn's edit tools named; it carries no trees,
 *  because a folder outside a repo has none. */
export function editToolTurnChanges(
  turnId: string,
  files: readonly TurnChangesFile[]
): AgentJournalTurnChangesItem | null {
  return files.length === 0
    ? null
    : { kind: 'turn-changes', turnId, source: 'edit-tools', files: [...files] }
}
