import { GlobalRegistrator } from '@happy-dom/global-registrator'

// happy-dom replaces these with versions tied to its window, which stop working once it closes;
// React keeps whichever it sees first, so a later test in the same process, such as a headless
// window, would never render
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
  if (GlobalRegistrator.isRegistered) return
  const native = RUNTIME_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
  GlobalRegistrator.register()
  for (const [name, value] of native) {
    if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  }
}
