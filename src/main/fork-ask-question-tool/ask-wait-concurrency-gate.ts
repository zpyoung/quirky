// Why: a parked `quirky ask` blocks on a human, so it outlives every other long-poll class.
// Four keeps user asks to a quarter of the runtime's 16-slot long-poll budget, leaving
// orchestration.ask's own reservation and the browser-host slots untouched by a waiting fleet.
export const ASK_WAIT_CONCURRENCY_CAP = 4

export type AskWaitConcurrencyGate = {
  run<T>(operation: () => Promise<T>): Promise<T>
}

/**
 * Meters concurrent `ask.wait` chunks for one runtime, shedding the overflow with the
 * `runtime_busy` RPC code the CLI retries on. The ask itself is durable, so a shed wait costs
 * only a re-poll — unlike `orchestration.ask`, whose caller exits non-zero when it is shed.
 *
 * Sheds rather than queues: a queued wait would go on holding its long-poll slot while it
 * waited for one, which is the starvation this exists to prevent.
 */
export function createAskWaitConcurrencyGate(
  cap: number = ASK_WAIT_CONCURRENCY_CAP
): AskWaitConcurrencyGate {
  let active = 0
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (active >= cap) {
        throw new Error('runtime_busy')
      }
      active += 1
      try {
        return await operation()
      } finally {
        active -= 1
      }
    }
  }
}
