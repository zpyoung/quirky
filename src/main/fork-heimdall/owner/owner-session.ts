import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import type { QuirkyRuntimeService } from '../../runtime/quirky-runtime'
import {
  createStructuredWorkerSession,
  releaseStructuredWorkerSession,
  sendStructuredWorkerPreamble
} from '../orchestration/owner-structured-session-bridge'
import type { WatcherOwnerConfig } from '../../../shared/fork-heimdall/owner/owner-config'

/** Only `claude` has a resumable, non-PTY structured session; every other configured agent refuses. */
export class UnsupportedOwnerAgentError extends Error {
  constructor(readonly agent: string) {
    super(
      `Heimdall owner agent "${agent}" has no structured session; only "claude" is supported in this slice.`
    )
    this.name = 'UnsupportedOwnerAgentError'
  }
}

export function ownerSessionHoldId(watcherId: string): string {
  return `owner:${watcherId}`
}

export type OwnerSessionHandle = {
  watcherId: string
  sessionId: string
  handle: string
  host: StructuredAgentSessionHost
}

const sessionsByWatcherId = new Map<string, OwnerSessionHandle>()

export function findOwnerSession(watcherId: string): OwnerSessionHandle | null {
  return sessionsByWatcherId.get(watcherId) ?? null
}

/**
 * Creates and holds the owner's structured session for the watcher's lifetime. Idempotent: a
 * watcher that already has a live session reuses it rather than creating a second one, since the
 * hold this takes is what keeps the provider child alive between wakes.
 */
export async function ensureOwnerSession(args: {
  runtime: QuirkyRuntimeService
  watcherId: string
  worktreeId: string
  owner: WatcherOwnerConfig
  onJournalActivity: (sessionId: string) => void
}): Promise<OwnerSessionHandle> {
  const existing = sessionsByWatcherId.get(args.watcherId)
  if (existing) {
    return existing
  }
  if (args.owner.agent !== 'claude') {
    throw new UnsupportedOwnerAgentError(args.owner.agent)
  }
  const holdId = ownerSessionHoldId(args.watcherId)
  const options: Record<string, string> = {}
  if (args.owner.model) {
    options.model = args.owner.model
  }
  if (args.owner.effort) {
    options.effort = args.owner.effort
  }
  const { identity, host } = await createStructuredWorkerSession({
    runtime: args.runtime,
    worktreeId: args.worktreeId,
    agent: 'claude',
    dispatchId: holdId,
    ...(Object.keys(options).length > 0 ? { options } : {}),
    onJournalActivity: args.onJournalActivity
  })
  const created: OwnerSessionHandle = {
    watcherId: args.watcherId,
    sessionId: identity.sessionId,
    handle: identity.handle,
    host
  }
  sessionsByWatcherId.set(args.watcherId, created)
  return created
}

/** Delivers one turn — the initial wake or a re-raise — to the owner's held session. */
export async function sendOwnerTurn(args: {
  session: OwnerSessionHandle
  turnText: string
}): Promise<void> {
  await sendStructuredWorkerPreamble({
    host: args.session.host,
    sessionId: args.session.sessionId,
    dispatchId: ownerSessionHoldId(args.session.watcherId),
    preamble: args.turnText
  })
}

/** Drops the hold; the provider child is evicted on the host's own eviction clock afterward. */
export function releaseOwnerSession(
  watcherId: string,
  runtime?: Parameters<typeof releaseStructuredWorkerSession>[1]
): void {
  if (!sessionsByWatcherId.delete(watcherId)) {
    return
  }
  releaseStructuredWorkerSession(ownerSessionHoldId(watcherId), runtime)
}
