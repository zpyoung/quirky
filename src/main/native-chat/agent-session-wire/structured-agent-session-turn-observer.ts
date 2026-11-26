// What the host derives from a journal commit that no adapter writes: the Changes card's
// `turn-changes` item and the Tests card's `test-result` item.
//
// WHY THE HOST DERIVES THEM FROM THE JOURNAL: Claude and Codex write their own turn and tool rows
// and only ACP and pi go through the provider timeline assembler, so the one place every agent's
// turn start, turn end and finished tool call shows up alike is the journal commit. It also runs
// on the host that runs the agent, so a remote workspace needs nothing more.
//
// WHY ASYNC: a snapshot walks the work tree. Nothing here sits on a write's path: a commit is
// scanned synchronously for what is new, and the git work and the follow-up write run after it.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalCursor,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { TurnChangesFile } from '../../../shared/agent-session-journal-v1-items'
import type { AgentSessionWorkspaceKind } from '../../../shared/agent-session-record'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { listTreeChanges, snapshotWorkspaceTree } from '../../git/turn-tree-snapshot'
import type { JournalItemLinkageVisitor } from '../agent-session-journal/journal-store-contracts'
import { deriveTestResult } from '../agent-session-timeline/test-result-derivation'
import {
  editToolTurnChanges,
  gitTreeTurnChanges,
  testResultIdentity,
  turnChangesIdentity
} from '../agent-session-timeline/turn-changes-item'
import { editedPathsOfItem, editToolFiles } from '../agent-session-timeline/turn-edit-tool-paths'
import { resolveAgentSessionLaunchDirectory } from '../../runtime/agent-session-launch-directory'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

/** The part of a journal the observer reads and writes. */
export type TurnObserverJournal = {
  cursor(): AgentJournalCursor
  itemBody(itemId: string): AgentJournalItemBody | null
  visitItemsWithLinkage(visit: JournalItemLinkageVisitor): void
  appendItem(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: { fence: number; turnScope: AgentJournalTurnScope }
  ): Promise<unknown>
}

export type TurnObserverWorkspace = {
  directory: string
  kind: AgentSessionWorkspaceKind
}

export type StructuredAgentSessionTurnObserverDeps = {
  /** Where the session's agent runs; null when this host has no directory for it. */
  workspace: (sessionId: string) => Promise<TurnObserverWorkspace | null>
  /** The fence a host-written row is stamped with. */
  fence: (sessionId: string) => number
  logger: StructuredAgentSessionLogger
  /** False when this process may not write the journal. */
  canWrite?: () => boolean
  snapshot?: typeof snapshotWorkspaceTree
  changes?: typeof listTreeChanges
}

type TurnBefore =
  | { kind: 'tree'; directory: string; tree: string }
  | { kind: 'plain-folder'; directory: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'none' }

type WatchedTurn = { turnId: string; before: Promise<TurnBefore> }

// weak so an idle-released journal is not kept alive by the observer
type SessionState = {
  journalRef: WeakRef<TurnObserverJournal>
  epoch: string
  sequence: number
  turns: Map<string, WatchedTurn>
  tests: Map<string, AgentJournalTurnScope>
}

const MAX_OBSERVED_SESSIONS = 64

export class StructuredAgentSessionTurnObserver {
  private readonly states = new Map<string, SessionState>()
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly deps: StructuredAgentSessionTurnObserverDeps) {}

  /** Resolves once every snapshot and write started so far has finished. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending)
    }
  }

  /**
   * One journal commit. The first one a journal shows only records where it is, so history, a
   * restore and a rewind produce nothing; a turn that ends with no recorded start writes no
   * `turn-changes`.
   */
  observe(sessionId: string, journal: TurnObserverJournal): void {
    try {
      this.scan(sessionId, journal)
    } catch (error) {
      // Derived rows are extras: a commit's own delivery must never fail for them.
      this.deps.logger.warn('scanning a journal commit for turn items failed', {
        scope: 'turn-changes',
        sessionId,
        error
      })
    }
  }

  private scan(sessionId: string, journal: TurnObserverJournal): void {
    const cursor = journal.cursor()
    const state = this.states.get(sessionId)
    if (
      !state ||
      state.journalRef.deref() !== journal ||
      state.epoch !== cursor.epoch ||
      cursor.sequence < state.sequence
    ) {
      this.remember(sessionId, {
        journalRef: new WeakRef(journal),
        epoch: cursor.epoch,
        sequence: cursor.sequence,
        turns: new Map(),
        tests: new Map()
      })
      return
    }
    this.settleWatched(sessionId, state, journal)
    if (cursor.sequence > state.sequence) {
      const floor = state.sequence
      state.sequence = cursor.sequence
      journal.visitItemsWithLinkage((itemId, sequence, body, attribution) => {
        if (sequence > floor && isRootAgentJournalItem(attribution)) {
          this.observeNewItem(sessionId, state, itemId, body, attribution.turnScope)
        }
      })
    }
  }

  private remember(sessionId: string, state: SessionState): void {
    this.states.delete(sessionId)
    this.states.set(sessionId, state)
    for (const oldest of [...this.states.keys()].slice(
      0,
      Math.max(0, this.states.size - MAX_OBSERVED_SESSIONS)
    )) {
      this.states.delete(oldest)
    }
  }

  private settleWatched(
    sessionId: string,
    state: SessionState,
    journal: TurnObserverJournal
  ): void {
    for (const [turnItemId, watched] of state.turns) {
      const turn = readAgentJournalTurn(journal.itemBody(turnItemId) ?? undefined)
      if (turn?.state === 'running') {
        continue
      }
      state.turns.delete(turnItemId)
      if (turn) {
        this.track(this.finishTurn(sessionId, state, turnItemId, watched))
      }
    }
    for (const [toolItemId, scope] of state.tests) {
      const body = journal.itemBody(toolItemId)
      if (body?.kind === 'tool-call' && body.state === 'running') {
        continue
      }
      state.tests.delete(toolItemId)
      if (body) {
        this.writeTestResult(sessionId, state, toolItemId, body, scope)
      }
    }
  }

  private observeNewItem(
    sessionId: string,
    state: SessionState,
    itemId: string,
    body: AgentJournalItemBody,
    turnScope: AgentJournalTurnScope | undefined
  ): void {
    const turn = readAgentJournalTurn(body)
    if (turn) {
      if (turn.state === 'running') {
        const before = this.snapshotBefore(sessionId)
        this.track(before)
        state.turns.set(itemId, { turnId: turn.turnId, before })
      }
      return
    }
    if (body.kind === 'tool-call') {
      const scope = turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
      if (this.writeTestResult(sessionId, state, itemId, body, scope) === 'running') {
        state.tests.set(itemId, scope)
      }
    }
  }

  private writeTestResult(
    sessionId: string,
    state: SessionState,
    toolItemId: string,
    body: AgentJournalItemBody,
    turnScope: AgentJournalTurnScope
  ): 'running' | 'final' | 'none' {
    if (body.kind !== 'tool-call') {
      return 'none'
    }
    const result = deriveTestResult(body, body.callId ?? toolItemId)
    if (!result) {
      return 'none'
    }
    this.track(this.append(sessionId, state, testResultIdentity(toolItemId), result, turnScope))
    return result.state === 'running' ? 'running' : 'final'
  }

  private snapshotBefore(sessionId: string): Promise<TurnBefore> {
    return this.resolveBefore(sessionId).catch((error: unknown) => ({
      kind: 'failed' as const,
      reason: error instanceof Error ? error.message : String(error)
    }))
  }

  private async resolveBefore(sessionId: string): Promise<TurnBefore> {
    const workspace = await this.deps.workspace(sessionId)
    if (!workspace) {
      return { kind: 'none' }
    }
    const snapshot = await (this.deps.snapshot ?? snapshotWorkspaceTree)(workspace.directory)
    if ('tree' in snapshot) {
      return { kind: 'tree', directory: workspace.directory, tree: snapshot.tree }
    }
    if ('failed' in snapshot) {
      return { kind: 'failed', reason: snapshot.failed }
    }
    // A worktree is always a repository, so one that is not has nothing to list.
    return workspace.kind === 'folder'
      ? { kind: 'plain-folder', directory: workspace.directory }
      : { kind: 'none' }
  }

  private async finishTurn(
    sessionId: string,
    state: SessionState,
    turnItemId: string,
    watched: WatchedTurn
  ): Promise<void> {
    const before = await watched.before
    if (before.kind === 'none') {
      return
    }
    if (before.kind === 'failed') {
      this.warnSnapshotFailed(sessionId, watched.turnId, before.reason)
      return
    }
    const scope: AgentJournalTurnScope = { kind: 'turn', turnItemId }
    if (before.kind === 'plain-folder') {
      const body = editToolTurnChanges(
        watched.turnId,
        editToolFiles(this.editedPaths(state, turnItemId), before.directory)
      )
      if (body) {
        await this.append(sessionId, state, turnChangesIdentity(watched.turnId), body, scope)
      }
      return
    }
    const after = await (this.deps.snapshot ?? snapshotWorkspaceTree)(before.directory)
    if (!('tree' in after)) {
      if ('failed' in after) {
        this.warnSnapshotFailed(sessionId, watched.turnId, after.failed)
      }
      return
    }
    if (after.tree === before.tree) {
      return
    }
    let files: TurnChangesFile[]
    try {
      files = await (this.deps.changes ?? listTreeChanges)(
        before.directory,
        before.tree,
        after.tree
      )
    } catch (error) {
      this.warnSnapshotFailed(
        sessionId,
        watched.turnId,
        error instanceof Error ? error.message : String(error)
      )
      return
    }
    const body = gitTreeTurnChanges(watched.turnId, before.tree, after.tree, files)
    if (body) {
      await this.append(sessionId, state, turnChangesIdentity(watched.turnId), body, scope)
    }
  }

  private editedPaths(state: SessionState, turnItemId: string): string[] {
    const paths: string[] = []
    state.journalRef.deref()?.visitItemsWithLinkage((_itemId, _sequence, body, attribution) => {
      if (
        attribution.turnScope?.kind === 'turn' &&
        attribution.turnScope.turnItemId === turnItemId
      ) {
        paths.push(...editedPathsOfItem(body))
      }
    })
    return paths
  }

  private warnSnapshotFailed(sessionId: string, turnId: string, reason: string): void {
    this.deps.logger.warn('snapshotting the workspace for a turn failed', {
      scope: 'turn-changes',
      sessionId,
      turnId,
      reason
    })
  }

  private async append(
    sessionId: string,
    state: SessionState,
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    turnScope: AgentJournalTurnScope
  ): Promise<void> {
    // A rewind or restore replaced the rows this was derived from.
    const journal = state.journalRef.deref()
    if (!journal || this.deps.canWrite?.() === false || journal.cursor().epoch !== state.epoch) {
      return
    }
    try {
      await journal.appendItem(identity, body, {
        fence: this.deps.fence(sessionId),
        turnScope
      })
    } catch (error) {
      this.deps.logger.warn('writing a derived turn item failed', {
        scope: 'turn-changes',
        sessionId,
        item: agentJournalItemKey(identity),
        error
      })
    }
  }

  private track(work: Promise<unknown>): void {
    const settled: Promise<void> = work.then(
      () => undefined,
      (error: unknown) => {
        this.deps.logger.warn('deriving a turn item failed', { scope: 'turn-changes', error })
      }
    )
    this.pending.add(settled)
    void settled.finally(() => this.pending.delete(settled))
  }
}

/** The observer a host runs: the workspace is the directory the session's agent launches in, and
 *  rows are stamped with the conversation's current fence. */
export function createHostTurnObserver(
  deps: () => Pick<StructuredAgentSessionHostDeps, 'store' | 'resolveWorkspacePath' | 'logger'>
): StructuredAgentSessionTurnObserver {
  return new StructuredAgentSessionTurnObserver({
    workspace: async (sessionId) => {
      const { store, resolveWorkspacePath } = deps()
      const record = store.getRecord(sessionId)
      if (!record || !resolveWorkspacePath) {
        return null
      }
      return {
        directory: await resolveAgentSessionLaunchDirectory(
          { store, resolveWorkspacePath },
          record
        ),
        kind: record.location.workspaceKind
      }
    },
    fence: (sessionId) => structuredAgentSessionConversationFence(deps().store, sessionId),
    canWrite: () => !deps().store.readOnly,
    get logger() {
      return deps().logger
    }
  })
}
