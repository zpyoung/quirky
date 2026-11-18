export const PLUGIN_CHANGED_INTERVAL_MS = 250

/** Preserves a burst's leading and final state without broadcasting every intermediate change. */
export function createPluginChangedBroadcast(options: {
  send: () => void
  intervalMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}): { signal(): void; dispose(): void } {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let timer: unknown
  let waiting = false
  let pending = false
  let disposed = false

  return {
    signal() {
      if (disposed) {
        options.send()
        return
      }
      if (waiting) {
        pending = true
        return
      }
      waiting = true
      timer = setTimer(() => {
        waiting = false
        if (!pending) return
        pending = false
        options.send()
      }, options.intervalMs ?? PLUGIN_CHANGED_INTERVAL_MS)
      options.send()
    },
    dispose() {
      disposed = true
      if (waiting) clearTimer(timer)
      waiting = false
      if (!pending) return
      pending = false
      options.send()
    }
  }
}
