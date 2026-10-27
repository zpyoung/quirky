import { bytesToBase64, type ExitCause, type PluginPty, type PtyFact } from '@quirky/protocol'
import type { PtyClient } from '../pty-client'

const acceptedInputEncoder = new TextEncoder()
const acceptedInputDecoder = new TextDecoder()

type DataListener = (sessionId: string, bytes: Uint8Array) => void
type ExitListener = (
  sessionId: string,
  exitCode: number | null,
  exit: { exitSignal: string | null; exitCause: ExitCause }
) => void
type FactListener = (sessionId: string, fact: PtyFact) => void
type InputListener = (sessionId: string, data: string) => void
type ReconnectListener = () => void

/**
 * Per-plugin listener sets behind one registration on the shared client, because `PtyClient`
 * can add handlers but not remove them.
 */
type Fanout = {
  data: Set<{ pluginId: string; listener: DataListener }>
  exit: Set<{ pluginId: string; listener: ExitListener }>
  fact: Set<{ pluginId: string; listener: FactListener }>
  input: Set<{ pluginId: string; listener: InputListener }>
  reconnect: Set<{ pluginId: string; listener: ReconnectListener }>
  /** Plugins holding a host subscription per session; the host subscription ends when the last holder lets go. */
  holds: Map<string, Set<string>>
  log: (message: string) => void
  /** Calls a plugin listener with its errors, sync or async, logged instead of thrown. */
  run: (pluginId: string, call: () => unknown) => void
}

const fanouts = new WeakMap<PtyClient, Fanout>()

function fanoutFor(pty: PtyClient, log: (message: string) => void): Fanout {
  const existing = fanouts.get(pty)
  if (existing) return existing
  const fanout: Fanout = {
    data: new Set(),
    exit: new Set(),
    fact: new Set(),
    input: new Set(),
    reconnect: new Set(),
    holds: new Map(),
    log,
    run: (pluginId, call) => run(pluginId, call)
  }
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
 *
 * Host subscriptions are shared by all plugins on the client: `subscribe` marks this plugin as
 * holding the session (repeats do not stack), and `unsubscribe` or `revoke` reach the host only
 * once no plugin holds it.
 */
export function createPtyApi(
  pty: PtyClient,
  pluginId: string,
  log: (message: string) => void = () => {}
): { api: PluginPty; revoke(): void } {
  const fanout = fanoutFor(pty, log)
  const removers = new Set<() => void>()
  const attempts = new Map<string, { inflight: number; succeeded: boolean }>()
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

  const release = (sessionId: string): boolean => {
    const holders = fanout.holds.get(sessionId)
    holders?.delete(pluginId)
    if (holders && holders.size > 0) return false
    fanout.holds.delete(sessionId)
    return true
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
      if (fanout.input.size === 0) return
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      for (const entry of [...fanout.input]) fanout.run(entry.pluginId, () => entry.listener(sessionId, text))
    },
    async writeAccepted(sessionId, data) {
      if (revoked) {
        throw Object.assign(new Error(`${pluginId} is no longer active`), {
          code: 'PTY_WRITE_REJECTED' as const,
          acceptedBytes: 0
        })
      }
      const bytes = typeof data === 'string' ? acceptedInputEncoder.encode(data) : data
      let text: string | null = null
      if (fanout.input.size > 0) text = typeof data === 'string' ? data : acceptedInputDecoder.decode(data)
      await pty.request('writeAccepted', { sessionId, bytes: bytesToBase64(bytes) })
      if (text === null) return
      for (const entry of [...fanout.input]) fanout.run(entry.pluginId, () => entry.listener(sessionId, text))
    },
    async resize(sessionId, cols, rows) {
      live()
      await pty.request('resize', { sessionId, cols, rows })
    },
    async read(sessionId, lines, options) {
      live()
      return pty.request('read', { sessionId, lines, ...(options?.unwrap === true ? { unwrap: true } : {}) })
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
      const holders = fanout.holds.get(sessionId) ?? new Set<string>()
      holders.add(pluginId)
      fanout.holds.set(sessionId, holders)
      const attempt = attempts.get(sessionId) ?? { inflight: 0, succeeded: false }
      attempts.set(sessionId, attempt)
      attempt.inflight += 1
      try {
        const result = await pty.request('subscribe', {
          sessionId,
          ...(options?.mode === undefined ? {} : { mode: options.mode }),
          ...(options?.historyLines === undefined ? {} : { historyLines: options.historyLines })
        })
        attempt.succeeded = true
        return result
      } catch (error) {
        // only the last failing attempt may roll the hold back, and only if no attempt succeeded
        if (attempt.inflight === 1 && !attempt.succeeded && attempts.get(sessionId) === attempt) release(sessionId)
        throw error
      } finally {
        attempt.inflight -= 1
        if (attempt.inflight === 0 && !attempt.succeeded && attempts.get(sessionId) === attempt) attempts.delete(sessionId)
      }
    },
    async snapshot(sessionId) {
      live()
      return pty.request('snapshot', { sessionId })
    },
    async history(sessionId, options) {
      live()
      return pty.request('history', { sessionId, ...options })
    },
    async clear(sessionId) {
      live()
      await pty.request('clear', { sessionId })
    },
    async resetModes(sessionId) {
      live()
      await pty.request('resetModes', { sessionId })
    },
    async restartHost() {
      live()
      return pty.restartHost()
    },
    async unsubscribe(sessionId) {
      live()
      attempts.delete(sessionId)
      if (release(sessionId)) await pty.request('unsubscribe', { sessionId })
    },
    onData: (listener) => listen(fanout.data, { pluginId, listener }),
    onExit: (listener) => listen(fanout.exit, { pluginId, listener }),
    onFact: (listener) => listen(fanout.fact, { pluginId, listener }),
    onInput: (listener) => listen(fanout.input, { pluginId, listener }),
    onReconnect: (listener) => listen(fanout.reconnect, { pluginId, listener })
  }

  return {
    api,
    revoke() {
      revoked = true
      attempts.clear()
      for (const remove of [...removers]) remove()
      for (const [sessionId, holders] of [...fanout.holds]) {
        if (!holders.has(pluginId) || !release(sessionId)) continue
        pty.request('unsubscribe', { sessionId }).catch(() => {})
      }
    }
  }
}
