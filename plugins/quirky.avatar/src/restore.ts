import type { AvatarApp } from './contracts'
import { listMarkerFiles, readMarkerFile, removeMarkerFile } from './hooks/install'

export type RestoreResult = {
  markersWritten: string[]
  markersRemoved: string[]
  checksResumed: string[]
}

type MarkerState = 'written' | 'kept' | 'none'

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

function log(app: AvatarApp, message: string): void {
  try {
    app.context.log(message)
  } catch {
    return
  }
}

function journal(app: AvatarApp, worktreeId: string, data: Record<string, unknown>): void {
  try {
    app.journal(worktreeId, 'event', data)
  } catch (error) {
    log(app, `avatar restore: could not journal for ${worktreeId}: ${errorText(error)}`)
  }
}

function restoreFailed(app: AvatarApp, worktreeId: string, error: unknown): void {
  const message = errorText(error)
  log(app, `avatar restore: failed for ${worktreeId}: ${message}`)
  journal(app, worktreeId, { type: 'restore-failed', error: message })
}

function gateCheckFailed(app: AvatarApp, worktreeId: string, error: unknown): void {
  journal(app, worktreeId, { type: 'gate-check-error', error: errorText(error) })
}

/** Reconciles supervision markers and restarts gate checks left in progress by a daemon stop. */
export function restoreHandoffs(app: AvatarApp): RestoreResult {
  const result: RestoreResult = { markersWritten: [], markersRemoved: [], checksResumed: [] }
  let rows
  try {
    rows = app.store.handoffs.list({ active: true })
  } catch (error) {
    log(app, `avatar restore: could not read active hand-offs: ${errorText(error)}`)
    return result
  }

  const heldWorktrees = new Set<string>()
  for (const row of rows) {
    let marker: MarkerState = 'none'
    try {
      const mandate = app.store.mandates.get(row.worktreeId)
      if (row.active && mandate !== null && row.sessionId !== null && row.state !== 'parked' && row.state !== 'gate-failed') {
        heldWorktrees.add(row.worktreeId)
        const existing = readMarkerFile(app.context.home, row.sessionId)
        if (existing?.worktreeId === row.worktreeId && existing.level === mandate.level) {
          marker = 'kept'
        } else {
          app.services.gate.writeMarker(row.sessionId, row.worktreeId, mandate.level)
          result.markersWritten.push(row.sessionId)
          marker = 'written'
        }
      }
    } catch (error) {
      restoreFailed(app, row.worktreeId, error)
    }

    const gateCheck = row.state === 'checking'
    if (gateCheck) {
      result.checksResumed.push(row.worktreeId)
      try {
        const check = app.services.gate.gateCheck(row.worktreeId)
        void Promise.resolve(check).catch((error: unknown) => gateCheckFailed(app, row.worktreeId, error))
      } catch (error) {
        gateCheckFailed(app, row.worktreeId, error)
      }
    }

    if (marker === 'written' || gateCheck) {
      journal(app, row.worktreeId, {
        type: 'restored',
        sessionId: row.sessionId,
        marker,
        gateCheck
      })
    }
  }

  const removed: string[] = []
  for (const sessionId of listMarkerFiles(app.context.home)) {
    const marker = readMarkerFile(app.context.home, sessionId)
    if (marker !== null && heldWorktrees.has(marker.worktreeId)) continue
    try {
      removeMarkerFile(app.context.home, sessionId)
      result.markersRemoved.push(sessionId)
      removed.push(sessionId)
    } catch (error) {
      log(app, `avatar restore: could not remove stale marker ${sessionId}: ${errorText(error)}`)
    }
  }

  result.markersRemoved.sort()
  if (removed.length > 0) {
    log(app, `avatar restore: removed stale supervision markers: ${removed.sort().join(', ')}`)
  }
  return result
}
