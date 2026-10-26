import type { MethodName, ParamsOf, QuirkyClient, ResultOf } from '@quirky/protocol'

/** The CLI could not reach (or start) the daemon; the message is the connection failure's. */
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonUnavailableError'
  }
}

/**
 * What commands use to reach the daemon. `reconnect` replaces a dropped connection; `call` always
 * goes to the current one. `callAny` reaches methods the CLI has no static types for, such as plugin methods.
 */
export interface DaemonLink {
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>
  callAny(method: string, params: Record<string, unknown>): Promise<unknown>
  reconnect(): Promise<void>
  close(): void
}

/** Connects on first use, so commands that fail validation or print help never touch the daemon. */
export function createDaemonLink(connect: () => Promise<QuirkyClient>): DaemonLink {
  let current: Promise<QuirkyClient> | null = null
  const get = () =>
    (current ??= connect().catch((error) => {
      throw new DaemonUnavailableError(error instanceof Error ? error.message : String(error))
    }))
  return {
    async call(method, params) {
      const client = await get()
      return client.call(method, params)
    },
    async callAny(method, params) {
      const client = await get()
      return client.callAny(method, params)
    },
    async reconnect() {
      const previous = current
      current = null
      if (previous) (await previous.catch(() => null))?.close()
      await get()
    },
    close() {
      void current?.then((client) => client.close()).catch(() => {})
    }
  }
}
