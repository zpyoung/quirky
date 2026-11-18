import type { BrowserChild, BrowserDependencies } from './dependencies'
import { redactedMessage } from './errors'

export async function stopOwned(child: BrowserChild, graceMs = 5_000): Promise<void> {
  await child.stop({ graceMs })
}

export function redactedOpenReason(error: unknown): string {
  return redactedMessage(error)
    .replace(/\b(?:mailto|https?|file):[^\s]+/gi, '[redacted]')
    .slice(0, 500)
}

/** Launches an approved target without delaying its caller or exposing the target in failure logs. */
export function launchDetachedOpen(
  dependencies: Pick<BrowserDependencies, 'process' | 'log'>,
  args: readonly string[],
  fallbackLog?: (message: string) => void
): void {
  const log = dependencies.log ?? fallbackLog
  const failed = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error)
    const target = args.at(-1)
    const reason = target
      ? text.replaceAll(target, /^(?:mailto|https?|file):/i.test(target) ? '[redacted]' : '[path]')
      : text
    log?.(`could not open external target: ${redactedOpenReason(reason)}`)
  }
  try {
    void dependencies.process.run(args, {
      timeoutMs: 30_000,
      maxOutputBytes: 1,
      overflow: 'truncate',
      killGraceMs: 2_000
    }).then((result) => {
      const reason = result.spawnError?.message
        ?? (result.stopped ? `open stopped: ${result.stopped}` : undefined)
        ?? (result.signal ? `open terminated by ${result.signal}` : undefined)
        ?? (result.exitCode !== 0 ? `open exited with ${result.exitCode}` : undefined)
      if (reason !== undefined) failed(reason)
    }, failed)
  } catch (error) {
    failed(error)
  }
}
