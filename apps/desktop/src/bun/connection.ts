export type ConnectionLike = { isClosed?: boolean; onClose: (handler: () => void) => () => void }

const MIN_DELAY_MS = 500
const MAX_DELAY_MS = 10_000

/**
 * Keeps one daemon connection alive: ensures the daemon is running, connects, waits for the
 * connection to drop, then starts over. Failures back off up to 10s. Resolves once `shouldStop`
 * is true at the top of a cycle or after a disconnect.
 */
export async function maintainConnection<C extends ConnectionLike>(options: {
  ensure: () => Promise<void>
  connect: () => Promise<C>
  onConnected: (client: C) => void
  onDisconnected: () => void
  onError?: (error: unknown) => void
  sleep: (ms: number) => Promise<void>
  shouldStop: () => boolean
}): Promise<void> {
  let delay = MIN_DELAY_MS
  while (!options.shouldStop()) {
    let client: C
    try {
      await options.ensure()
      client = await options.connect()
    } catch (error) {
      options.onError?.(error)
      await options.sleep(delay)
      delay = Math.min(delay * 2, MAX_DELAY_MS)
      continue
    }
    delay = MIN_DELAY_MS
    const closed = new Promise<void>((resolve) => {
      if (client.isClosed) resolve()
      else client.onClose(resolve)
    })
    options.onConnected(client)
    await closed
    options.onDisconnected()
    if (!options.shouldStop()) await options.sleep(MIN_DELAY_MS)
  }
}
