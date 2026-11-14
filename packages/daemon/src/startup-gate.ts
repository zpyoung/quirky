import type { QuirkyEvent } from '@quirky/protocol'
import type { RpcHandler } from './rpc-handler'

export const STARTUP_HOOK_LIMIT = 1_000
export const STARTUP_HOOK_BYTES = 16 * 1024 * 1024
export type HookReceived = Extract<QuirkyEvent, { type: 'hook.received' }>

export type StartupGate = {
  readonly isOpen: boolean
  rpc(handle: RpcHandler): RpcHandler
  hook(event: HookReceived, bodyBytes: number, deliver: (event: HookReceived) => void): void
  open(): void
}

/** Holds client messages and bounded agent hooks until every startup listener has subscribed. */
export function createStartupGate(log: (message: string) => void): StartupGate {
  let isOpen = false
  const { promise: opened, resolve: release } = Promise.withResolvers<void>()
  const hooks: { event: HookReceived; deliver: (event: HookReceived) => void }[] = []
  let bytes = 0
  let dropped = 0

  return {
    get isOpen() { return isOpen },
    rpc(handle) {
      return async (conn, text) => {
        if (!isOpen) await opened
        if (!conn.closed) return handle(conn, text)
      }
    },
    hook(event, bodyBytes, deliver) {
      if (isOpen) {
        deliver(event)
      } else if (hooks.length < STARTUP_HOOK_LIMIT && bytes + bodyBytes <= STARTUP_HOOK_BYTES) {
        bytes += bodyBytes
        hooks.push({ event, deliver })
      } else {
        dropped++
      }
    },
    open() {
      if (isOpen) return
      isOpen = true
      for (const { event, deliver } of hooks) deliver(event)
      hooks.length = 0
      bytes = 0
      if (dropped > 0) log(`dropped ${dropped} agent hook${dropped === 1 ? '' : 's'} that arrived during startup`)
      release()
    }
  }
}
