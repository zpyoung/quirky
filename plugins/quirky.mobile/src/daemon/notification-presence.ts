import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Unknown presence must not silence a paired phone. No session/user details leave this module. */
export async function readDesktopAway(): Promise<boolean | null> {
  if (process.platform !== 'darwin') return null
  try {
    const [hid, root] = await Promise.all([
      exec('/usr/sbin/ioreg', ['-r', '-c', 'IOHIDSystem', '-d', '1'], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 }),
      exec('/usr/sbin/ioreg', ['-n', 'Root', '-d', '1', '-l'], { timeout: 1500, maxBuffer: 2 * 1024 * 1024 })
    ])
    const idle = /"HIDIdleTime"\s*=\s*(\d+)/.exec(hid.stdout)?.[1]
    const locked = /"IOConsoleLocked"\s*=\s*(Yes|No)/.exec(root.stdout)?.[1]
    if (locked === 'Yes') return true
    if (!idle || locked !== 'No') return null
    return BigInt(idle) >= 180_000_000_000n
  } catch {
    return null
  }
}
