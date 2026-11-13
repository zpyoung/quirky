import type { ProcessRunner } from '@quirky/protocol'

/** Unknown presence must not silence a paired phone. No session/user details leave this module. */
export async function readDesktopAway(runner: ProcessRunner): Promise<boolean | null> {
  if (process.platform !== 'darwin') return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    const options = { timeoutMs: 1500, maxOutputBytes: 2 * 1024 * 1024, killGraceMs: 0, signal: controller.signal }
    const results = await Promise.all([
      runner.run(['/usr/sbin/ioreg', '-r', '-c', 'IOHIDSystem', '-d', '1'], options),
      runner.run(['/usr/sbin/ioreg', '-n', 'Root', '-d', '1', '-l'], options)
    ])
    if (results.some(result => result.spawnError || result.stopped || result.signal || result.exitCode !== 0)) return null
    const [hid, root] = results
    const idle = /"HIDIdleTime"\s*=\s*(\d+)/.exec(hid.stdoutText)?.[1]
    const locked = /"IOConsoleLocked"\s*=\s*(Yes|No)/.exec(root.stdoutText)?.[1]
    if (locked === 'Yes') return true
    if (!idle || locked !== 'No') return null
    return BigInt(idle) >= 180_000_000_000n
  } catch {
    controller.abort()
    return null
  } finally {
    clearTimeout(timeout)
  }
}
