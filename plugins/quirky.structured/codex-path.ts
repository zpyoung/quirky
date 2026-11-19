import type { ProcessRunner } from '@quirky/protocol'

/** Finds the user's `codex` executable through their login shell without touching global config. */
export async function resolveCodexThroughLoginShell(runner: ProcessRunner, shell: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const result = await runner.run([shell, '-l', '-c', 'command -v codex'], {
      timeoutMs: 30000,
      killGraceMs: 0,
      maxOutputBytes: 1048576,
      signal: controller.signal
    })
    const executable = result.stdoutText.trim().split('\n').at(-1)?.trim() ?? ''
    if (result.exitCode !== 0 || result.stopped !== undefined || result.spawnError !== undefined || !executable) {
      throw new Error('could not find the codex executable on the login shell PATH')
    }
    return executable
  } catch {
    throw new Error('could not find the codex executable on the login shell PATH')
  } finally {
    clearTimeout(timer)
  }
}
