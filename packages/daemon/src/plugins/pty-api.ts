import type { ExitCause, PluginPty, PtyFact } from '@quirky/protocol'
import type { PtyClient } from '../pty-client'

type DataListener = (sessionId: string, bytes: Uint8Array) => void
type ExitListener = (
  sessionId: string,
  exitCode: number | null,
  exit: { exitSignal: string | null; exitCause: ExitCause }
) => void
type FactListener = (sessionId: string, fact: PtyFact) => void
type ReconnectListener = () => void

/**
 * Per-plugin listener sets behind one registration on the shared client, because `PtyClient`
 * can add handlers but not remove them.
 */
type Fanout = {
  data: Set<{ pluginId: string; listener: DataListener }>
  exit: Set<{ pluginId: string; listener: ExitListener }>
  fact: Set<{ pluginId: string; listener: FactListener }>
  reconnect: Set<{ pluginId: string; listener: ReconnectListener }>
  log: (message: string) => void
}

const fanouts = new WeakMap<PtyClient, Fanout>()

function fanoutFor(pty: PtyClient, log: (message: string) => void): Fanout {
  const existing = fanouts.get(pty)
  if (existing) return existing
  const fanout: Fanout = { data: new Set(), exit: new Set(), fact: new Set(), reconnect: new Set(), log }
  const run = (pluginId: string, call: () => unknown) => {
    try {
      const result = call()
      if (result instanceof Promise) result.catch((error) => fanout.log(`${pluginId}: pty listener failed: ${String(error)}`))
    } catch (error) {
      fanout.log(`${pluginId}: pty listener failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  pty.onData((sessionId, bytes) => {
    for (const entry of [...fanout.data]) run(entry.pluginId, () => entry.listener(sessionId, bytes))
  })
  pty.onExit((sessionId, exitCode, exit) => {
    for (const entry of [...fanout.exit]) run(entry.pluginId, () => entry.listener(sessionId, exitCode, exit))
  })
  pty.onFact((sessionId, fact) => {
    for (const entry of [...fanout.fact]) run(entry.pluginId, () => entry.listener(sessionId, fact))
  })
  pty.onReconnect(() => {
    for (const entry of [...fanout.reconnect]) run(entry.pluginId, () => entry.listener())
  })
  fanouts.set(pty, fanout)
  return fanout
}

/**
 * Builds `context.pty` for one plugin over the shared PTY client. After `revoke` the plugin's
 * listeners are gone and every member throws, so a stale handle cannot reach the host.
 */
export function createPtyApi(
  pty: PtyClient,
  pluginId: string,
  log: (message: string) => void = () => {}
): { api: PluginPty; revoke(): void } {
  const fanout = fanoutFor(pty, log)
  const removers = new Set<() => void>()
  let revoked = false

  const live = () => {
    if (revoked) throw new Error(`${pluginId} is no longer active`)
  }
  const listen = <T extends { pluginId: string }>(set: Set<T>, entry: T): (() => void) => {
    live()
    set.add(entry)
    const remove = () => {
      set.delete(entry)
      removers.delete(remove)
    }
    removers.add(remove)
    return remove
  }

  const api: PluginPty = {
    get connected() {
      return pty.connected
    },
    async spawn(sessionId, { argv, cwd, env, cols, rows, shellReady, restore }) {
      live()
      return pty.request('create', { sessionId, argv, cwd, env, cols, rows, shellReady, restore })
    },
    write(sessionId, data) {
      live()
      pty.sendData(sessionId, typeof data === 'string' ? new TextEncoder().encode(data) : data)
    },
    async resize(sessionId, cols, rows) {
      live()
      await pty.request('resize', { sessionId, cols, rows })
    },
    async read(sessionId, lines) {
      live()
      return pty.request('read', { sessionId, lines })
    },
    async kill(sessionId, signal, options) {
      live()
      await pty.request('kill', {
        sessionId,
        ...(signal === undefined ? {} : { signal }),
        ...(options?.reason === undefined ? {} : { reason: options.reason })
      })
    },
    async forget(sessionId) {
      live()
      await pty.request('forget', { sessionId })
    },
    async list() {
      live()
      return pty.request('list', {})
    },
    async subscribe(sessionId, options) {
      live()
      return pty.request('subscribe', {
        sessionId,
        ...(options?.mode === undefined ? {} : { mode: options.mode }),
        ...(options?.historyLines === undefined ? {} : { historyLines: options.historyLines })
      })
    },
    async snapshot(sessionId) {
      live()
      return pty.request('snapshot', { sessionId })
    },
    async history(sessionId, options) {
      live()
      return pty.request('history', { sessionId, ...options })
    },
    async restartHost() {
      live()
      return pty.restartHost()
    },
    async unsubscribe(sessionId) {
      live()
      await pty.request('unsubscribe', { sessionId })
    },
    onData: (listener) => listen(fanout.data, { pluginId, listener }),
    onExit: (listener) => listen(fanout.exit, { pluginId, listener }),
    onFact: (listener) => listen(fanout.fact, { pluginId, listener }),
    onReconnect: (listener) => listen(fanout.reconnect, { pluginId, listener })
  }

  return {
    api,
    revoke() {
      revoked = true
      for (const remove of [...removers]) remove()
    }
  }
}
