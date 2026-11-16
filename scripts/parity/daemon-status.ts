import { isDaemonAlive, readRuntime, type RuntimeInfo } from '@quirky/protocol/node'

export type DaemonStatusOptions = {
  signal?: AbortSignal
  readRuntime?: typeof readRuntime
  isDaemonAlive?: typeof isDaemonAlive
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
  probeTimeoutMs?: number
}

export async function daemonStatus(
  home: string,
  daemon: { pid: number; exited: Promise<number> },
  deadline: number,
  options: DaemonStatusOptions = {}
): Promise<boolean> {
  const probeTimeoutMs = options.probeTimeoutMs === undefined ? 300 : options.probeTimeoutMs
  if (!Number.isInteger(probeTimeoutMs) || probeTimeoutMs < 1 || probeTimeoutMs > 5_000) {
    throw new Error('probeTimeoutMs must be an integer from 1 to 5000')
  }
  const now = options.now ?? Date.now
  const readOwnedRuntime = options.readRuntime ?? readRuntime
  const probe = options.isDaemonAlive ?? isDaemonAlive
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds))
  const retryDeadline = Math.min(deadline, now() + 5_000)
  let exited = false
  let aborted = options.signal?.aborted ?? false
  const stopped = Promise.withResolvers<void>()
  const onAbort = () => {
    aborted = true
    stopped.resolve()
  }
  const onExit = () => {
    exited = true
    stopped.resolve()
  }
  daemon.exited.then(onExit, onExit)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (now() < retryDeadline) {
      if (aborted || exited || options.signal?.aborted) return false
      const runtime: RuntimeInfo | null = readOwnedRuntime(home)
      if (!runtime || runtime.pid !== daemon.pid) return false
      const remaining = retryDeadline - now()
      if (remaining <= 0) return false
      const alive = await Promise.race([
        probe(runtime, Math.min(probeTimeoutMs, remaining)),
        stopped.promise.then(() => false)
      ])
      if (aborted || exited || options.signal?.aborted || now() >= retryDeadline) return false
      const afterProbe = readOwnedRuntime(home)
      if (!afterProbe || afterProbe.pid !== daemon.pid) return false
      if (alive) return true
      const pause = Math.min(50, retryDeadline - now())
      if (pause <= 0) return false
      await Promise.race([sleep(pause), stopped.promise])
    }
    return false
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}
