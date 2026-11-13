import type { ProcessRunner } from '@quirky/protocol'

/**
 * Finds the user's `claude` executable the way their terminal would: `command -v claude` in a
 * login shell, so PATH entries added by shell profiles count. Throws when nothing is found.
 */
export async function resolveClaudeThroughLoginShell(runner: ProcessRunner, shell: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const result = await runner.run([shell, '-l', '-c', 'command -v claude'], {
      timeoutMs: 30000,
      killGraceMs: 0,
      maxOutputBytes: 1048576,
      signal: controller.signal
    })
    const executable = result.stdoutText.trim().split('\n').at(-1)?.trim() ?? ''
    if (result.stopped !== undefined || result.spawnError !== undefined || !executable) {
      throw new Error('could not find the claude executable on the login shell PATH')
    }
    return executable
  } catch {
    throw new Error('could not find the claude executable on the login shell PATH')
  } finally {
    clearTimeout(timer)
  }
}
