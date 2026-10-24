import type { MethodName, ParamsOf, QuirkyClient, ResultOf } from '@quirky/protocol'

/**
 * What commands use to reach the daemon. `reconnect` replaces a dropped connection; `call` always
 * goes to the current one.
 */
export interface DaemonLink {
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>
  reconnect(): Promise<void>
  close(): void
}

/** Connects on first use, so commands that fail validation or print help never touch the daemon. */
export function createDaemonLink(connect: () => Promise<QuirkyClient>): DaemonLink {
  let current: Promise<QuirkyClient> | null = null
  const get = () => (current ??= connect())
  return {
    async call(method, params) {
      const client = await get()
      return client.call(method, params)
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
