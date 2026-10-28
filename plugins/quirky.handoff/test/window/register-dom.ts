import { GlobalRegistrator } from '@happy-dom/global-registrator'

// happy-dom swaps these for versions tied to its window, which stop working once that window is
// closed; React keeps whichever it sees first, so a later test file in the same process would
// never render
const RUNTIME_GLOBALS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'queueMicrotask',
  'MessageChannel',
  'performance',
  'fetch',
  'WebSocket'
] as const

/** Registers happy-dom globally, leaving the runtime's own timers and microtask queue in place. */
export function registerDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    const native = RUNTIME_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
    GlobalRegistrator.register()
    for (const [name, value] of native) {
      if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
    }
  }
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
}
