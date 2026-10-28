import { GlobalRegistrator } from '@happy-dom/global-registrator'

const RUNTIME_GLOBALS = [
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'MessageChannel', 'performance', 'Request', 'Response', 'Headers', 'fetch', 'WebSocket'
] as const
// Dynamic test-global indexing; values remain unknown rather than bypassing boundary types.
const globals = globalThis as unknown as Record<string, unknown>
const runtime = RUNTIME_GLOBALS.map((name) => [name, globals[name]] as const)
const priorActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT

/** React must detect a DOM without capturing a scheduler tied to a disposable Happy DOM window. */
export function registerUiDom(): void {
  GlobalRegistrator.register()
  for (const [name, value] of runtime) {
    if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true
}

export async function unregisterUiDom(): Promise<void> {
  await GlobalRegistrator.unregister()
  for (const [name, value] of runtime) {
    if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  }
  if (priorActEnvironment === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT
  else globals.IS_REACT_ACT_ENVIRONMENT = priorActEnvironment
}
