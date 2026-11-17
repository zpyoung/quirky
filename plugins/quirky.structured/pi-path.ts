import type { ProcessRunner } from '@quirky/protocol'
import type { PiVariant } from './pi-rpc'

/**
 * Finds the user's `pi` or `omp` executable the way their terminal would: `command -v <variant>` in a
 * login shell, so PATH entries added by shell profiles count. Throws when nothing is found.
 */
export async function resolvePiThroughLoginShell(runner: ProcessRunner, shell: string, variant: PiVariant): Promise<string> {
  const failure = new Error(`could not find the ${variant} executable on the login shell PATH`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const result = await runner.run([shell, '-l', '-c', `command -v ${variant}`], {
      timeoutMs: 30000,
      killGraceMs: 0,
      maxOutputBytes: 1048576,
      signal: controller.signal
    })
    const executable = result.stdoutText.trim().split('\n').at(-1)?.trim() ?? ''
    if (result.exitCode !== 0 || result.stopped !== undefined || result.spawnError !== undefined || !executable) throw failure
    return executable
  } catch {
    throw failure
  } finally {
    clearTimeout(timer)
  }
}
