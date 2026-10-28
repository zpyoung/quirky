import type { BrowserChild } from './dependencies'

export function signalOwned(child: BrowserChild, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* the retained child may already have exited */ }
  }
}

async function exitedWithin(child: BrowserChild, timeoutMs: number): Promise<boolean> {
  const timeout = Promise.withResolvers<boolean>()
  const timer = setTimeout(() => timeout.resolve(false), timeoutMs)
  try {
    return await Promise.race([child.exited.then(() => true), timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

export async function stopOwned(child: BrowserChild, timeoutMs = 5_000): Promise<void> {
  signalOwned(child, 'SIGTERM')
  if (await exitedWithin(child, timeoutMs)) return
  signalOwned(child, 'SIGKILL')
  await exitedWithin(child, 500)
}
