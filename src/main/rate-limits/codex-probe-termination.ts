// Why: Codex OAuth uses rotating refresh tokens. Hard-killing a probe's
// app-server mid-refresh can strand auth.json between rotations and permanently
// invalidate the stored credential, so termination always requests shutdown
// first and only escalates after a bounded drain window.

export const CODEX_PROBE_SHUTDOWN_DRAIN_MS = 5_000
const HARD_KILL_EXIT_WAIT_MS = 1_000

export type TerminatableProbeChild = {
  pid?: number
  exitCode: number | null
  signalCode?: NodeJS.Signals | null
  kill: (signal?: NodeJS.Signals) => boolean
  on: (event: 'error', listener: () => void) => unknown
  once: (event: 'exit' | 'close' | 'error', listener: () => void) => unknown
  off: (event: 'exit' | 'close' | 'error', listener: () => void) => unknown
  stdin?: { end: () => void } | null
}

export type TerminateCodexProbeOptions = {
  drainMs?: number
  hardKillWaitMs?: number
}

function hasExited(child: TerminatableProbeChild): boolean {
  return child.exitCode != null || child.signalCode != null
}

function waitForExit(child: TerminatableProbeChild, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (exited: boolean): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      child.off('exit', onGone)
      child.off('close', onGone)
      child.off('error', onError)
      resolve(exited)
    }
    const onGone = (): void => settle(true)
    const onError = (): void => {
      // Keep ChildProcess errors observed, but only exit/close proves it is gone.
    }
    // Node emits 'close' after both exit and spawn failure. A later 'error'
    // alone does not prove a successfully spawned child released auth.json.
    child.once('exit', onGone)
    child.once('close', onGone)
    child.on('error', onError)
    timer = setTimeout(() => settle(false), timeoutMs)
  })
}

export async function terminateCodexProbeChild(
  child: TerminatableProbeChild,
  options?: TerminateCodexProbeOptions
): Promise<void> {
  if (hasExited(child)) {
    return
  }
  // Why: stdin EOF is the graceful stop for a stdio JSON-RPC server; SIGTERM backs it up.
  try {
    child.stdin?.end()
  } catch {
    // stdin may already be destroyed; the signal/kill path still applies.
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // Already-exited children can race the kill; the exit wait handles it.
  }
  if (await waitForExit(child, options?.drainMs ?? CODEX_PROBE_SHUTDOWN_DRAIN_MS)) {
    return
  }
  if (hasExited(child)) {
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // Already-exited children can race the kill; the exit wait handles it.
  }
  await waitForExit(child, options?.hardKillWaitMs ?? HARD_KILL_EXIT_WAIT_MS)
}
