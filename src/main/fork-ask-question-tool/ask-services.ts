import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { AskDb } from './ask-db'
import { AskRegistry } from './ask-registry'
import {
  createAskAttachedSurfaceRoster,
  type AskAttachedSurfaceRoster
} from './ask-attached-surface-roster'
import {
  createAskWaitConcurrencyGate,
  type AskWaitConcurrencyGate
} from './ask-wait-concurrency-gate'

export type AskServices = {
  readonly db: AskDb
  readonly registry: AskRegistry
  readonly roster: AskAttachedSurfaceRoster
  readonly waitGate: AskWaitConcurrencyGate
  /** Resolves a closed pane's pending asks; a no-op while the durable store was never opened. */
  resolvePaneClosed(paneKey: string): void
}

type DurableAskStore = { db: AskDb; registry: AskRegistry }

/**
 * The runtime instance a roster belongs to. Held weakly and compared by identity — the id is
 * what makes two runtimes distinguishable, and nothing here reads any other member.
 */
export type AskServicesOwner = { getRuntimeId: () => string }

const servicesByRuntime = new WeakMap<AskServicesOwner, AskServices>()

/**
 * Lazily builds and memoizes the ask db, registry, and attached-surface roster for one runtime
 * instance, keyed by identity — the runtime itself carries only a one-line delegating accessor.
 * The roster exists from the first call; the durable store opens on the first `db` or `registry`
 * read, so connection bookkeeping alone never touches sqlite or the app-environment port.
 */
export function askServicesFor(
  runtime: AskServicesOwner,
  hasLocalRendererWindow: () => boolean
): AskServices {
  let services = servicesByRuntime.get(runtime)
  if (!services) {
    let durable: DurableAskStore | null = null
    const openDurable = (): DurableAskStore => {
      if (!durable) {
        const db = new AskDb(join(getAppEnvironment().getPath('userData'), 'asks.db'))
        db.startPeriodicPurge()
        durable = { db, registry: new AskRegistry(db) }
      }
      return durable
    }
    // Why: RpcContext.clientCapabilities describes only the calling connection, never the
    // surface that owns a pane — the roster needs its own local-window signal to answer that.
    // The registry is also the sink for its own liveness grace timer: a pane losing or
    // regaining its last capable owner is exactly what starts or cancels that timer. A registry
    // that was never opened has surfaced no ask, so it has no timer to start or cancel either.
    const roster = createAskAttachedSurfaceRoster(
      { hasLocalRendererWindow },
      {
        notePaneDetached: (paneKey) => durable?.registry.notePaneDetached(paneKey),
        notePaneAttached: (paneKey) => durable?.registry.notePaneAttached(paneKey)
      }
    )
    const waitGate = createAskWaitConcurrencyGate()
    services = {
      get db() {
        return openDurable().db
      },
      get registry() {
        return openDurable().registry
      },
      roster,
      waitGate,
      resolvePaneClosed: (paneKey) => durable?.registry.resolvePaneClosed(paneKey)
    }
    servicesByRuntime.set(runtime, services)
  }
  return services
}
